import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { handleRequest } from "./router";
import { retryNotificationDelivery } from "./notifications";
import { readNotificationSnapshot } from "./notification-store";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.com";
type User = { id: string; token: string };
type Summary = { id: string; type: "message" | "reply"; score: number; user_vote: -1 | 0 | 1 };

function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  let pushFails = false;
  const published: string[] = [];
  const env = {
    DB: database.db,
    NOTIFICATIONS: {
      idFromName: (id: string) => id,
      get: (id: string) => ({
        async fetch() {
          if (pushFails) return Response.json({ error: "unavailable" }, { status: 503 });
          published.push(id);
          return Response.json(await readNotificationSnapshot(database.db, id, published.length));
        },
      }),
    },
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(origin + path, init), env);
  const user = (id: string): User => {
    const token = `bff_us_${createHash("sha256").update(id).digest("hex")}`;
    database.sqlite.prepare("INSERT INTO users(id,email,name) VALUES(?,?,?)").run(id, `${id}@example.com`, id);
    database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(createHash("sha256").update(token).digest("hex"), id, new Date(Date.now() + 60_000).toISOString());
    return { id, token };
  };
  const auth = (identity: User) => ({ authorization: `Bearer ${identity.token}` });
  const set = (identity: User | null, target: { message_id: string } | { reply_id: string }, value: number) =>
    request("/votes", { method: "PUT", headers: { "content-type": "application/json", ...(identity ? auth(identity) : {}) },
      body: JSON.stringify({ ...target, value }) });
  const get = async (messageIds: string[], replyIds: string[] = [], identity?: User): Promise<Summary[]> => {
    const query = new URLSearchParams();
    if (messageIds.length) query.set("message_ids", messageIds.join(","));
    if (replyIds.length) query.set("reply_ids", replyIds.join(","));
    const response = await request(`/votes?${query}`, { headers: identity ? auth(identity) : {} });
    assert.equal(response.status, 200, await response.clone().text());
    return (await response.json() as { data: Summary[] }).data;
  };
  return { database, env, request, user, auth, set, get, published, setPushFails(value: boolean) { pushFails = value; } };
}

test("new messages and replies start at one; each voter has one idempotent contribution", async t => {
  const f = fixture(t);
  const author = f.user("author");
  const alice = f.user("alice");
  const bob = f.user("bob");
  const message = await f.request("/tables/messages", { method: "POST", headers: { ...f.auth(author), "content-type": "application/json" },
    body: JSON.stringify({ board_id: "general", title: "Voting", body: "Vote here" }) });
  assert.equal(message.status, 201, await message.clone().text());
  const messageId = (await message.json() as { data: Array<{ id: string }> }).data[0].id;
  const reply = await f.request("/tables/replies", { method: "POST", headers: { ...f.auth(author), "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId, body: "A reply" }) });
  assert.equal(reply.status, 201);
  const replyId = (await reply.json() as { data: Array<{ id: string }> }).data[0].id;
  assert.deepEqual(await f.get([messageId], [replyId]), [
    { id: messageId, type: "message", score: 1, user_vote: 0 },
    { id: replyId, type: "reply", score: 1, user_vote: 0 },
  ]);
  assert.deepEqual((await f.get([messageId], [replyId], author)).map(row => row.user_vote), [1, 1]);
  assert.equal((await f.set(author, { message_id: messageId }, 1)).status, 200);
  assert.equal((await f.get([messageId], [], author))[0].score, 1);

  assert.equal((await f.set(alice, { message_id: messageId }, 1)).status, 200);
  assert.equal((await f.set(alice, { message_id: messageId }, 1)).status, 200);
  assert.deepEqual((await f.get([messageId], [], alice))[0],
    { id: messageId, type: "message", score: 2, user_vote: 1 });
  assert.equal((await f.set(alice, { message_id: messageId }, -1)).status, 409);
  assert.equal((await f.set(alice, { message_id: messageId }, 0)).status, 200);
  assert.equal((await f.get([messageId]))[0].score, 1);
  assert.equal((await f.set(bob, { reply_id: replyId }, 1)).status, 200);
  assert.equal((await f.get([], [replyId]))[0].score, 2);
  const notifications = await readNotificationSnapshot(f.database.db, author.id, 1);
  assert.deepEqual(notifications.notifications.map(item => [item.kind, item.reply_id, item.message_id, item.actor_name]), [
    ["upvote", replyId, messageId, bob.id],
    ["upvote", null, messageId, alice.id],
  ]);
  assert.equal((await f.set(bob, { reply_id: replyId }, 0)).status, 200);
  assert.equal((await f.get([], [replyId]))[0].score, 1);
  assert.equal((await f.set(bob, { reply_id: replyId }, -1)).status, 200);
  assert.equal((await f.get([], [replyId]))[0].score, 0);
  assert.equal((await f.set(bob, { reply_id: replyId }, -1)).status, 200);
  assert.equal((await f.get([], [replyId]))[0].score, 0);
});

test("upvote notifications are durable, unique per actor and target, and survive a failed push", async t => {
  const f = fixture(t);
  const author = f.user("owner");
  const actor = f.user("voter");
  const messageId = "upvote-message";
  f.database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES(?,'general',?,'Title','Body')")
    .run(messageId, author.id);
  f.setPushFails(true);
  assert.equal((await f.set(actor, { message_id: messageId }, 1)).status, 200);
  const first = f.database.sqlite.prepare("SELECT id,kind,actor_id,read_at,delivered_at FROM notifications").get() as {
    id: number; kind: string; actor_id: string; read_at: string | null; delivered_at: string | null;
  };
  assert.equal(first.kind, "upvote");
  assert.equal(first.actor_id, actor.id);
  assert.equal(first.delivered_at, null);
  assert.equal(first.read_at, null);
  f.database.sqlite.prepare("UPDATE notifications SET read_at='read' WHERE id=?").run(first.id);
  assert.equal((await f.set(actor, { message_id: messageId }, 0)).status, 200);
  assert.equal((await f.set(actor, { message_id: messageId }, 1)).status, 200);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications").get()?.n, 1);
  assert.equal(f.database.sqlite.prepare("SELECT read_at FROM notifications WHERE id=?").get(first.id)?.read_at, "read");
  const snapshot = await readNotificationSnapshot(f.database.db, author.id, 1);
  assert.equal(snapshot.notifications[0].kind, "upvote");
  assert.equal(snapshot.notifications[0].reply_id, null);
  assert.equal(snapshot.notifications[0].message_id, messageId);
  assert.equal(snapshot.notifications[0].actor_name, actor.id);
  f.setPushFails(false);
  await retryNotificationDelivery(f.env);
  assert.deepEqual(f.published, [author.id]);
  assert.ok(f.database.sqlite.prepare("SELECT delivered_at FROM notifications WHERE id=?").get(first.id)?.delivered_at);
});

test("votes validate target, body, session, origin, and cascade on deletion", async t => {
  const f = fixture(t);
  const author = f.user("delete-owner");
  const actor = f.user("delete-voter");
  const messageId = "delete-message";
  const replyId = "delete-reply";
  f.database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES(?,'general',?,'Title','Body')")
    .run(messageId, author.id);
  f.database.sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES(?,?,?,'Reply')")
    .run(replyId, messageId, author.id);
  assert.equal((await f.set(null, { message_id: messageId }, 1)).status, 401);
  assert.equal((await f.set(actor, { message_id: "missing" }, 1)).status, 404);
  assert.equal((await f.set(actor, { reply_id: "missing" }, 1)).status, 404);
  assert.equal((await f.set(actor, { message_id: messageId }, 2)).status, 400);
  const bad = await f.request("/votes", { method: "PUT", headers: { ...f.auth(actor), "content-type": "application/json" },
    body: JSON.stringify({ message_id: messageId, reply_id: replyId, value: 1 }) });
  assert.equal(bad.status, 400);
  const blocked = await f.request(`/votes?message_ids=${messageId}`, { headers: { origin: "https://bad.example" } });
  assert.equal(blocked.status, 403);
  assert.equal((await f.set(actor, { reply_id: replyId }, 1)).status, 200);
  assert.equal((await f.get(["missing", messageId], [replyId])).length, 2);
  assert.equal((await f.request(`/votes?message_ids=${messageId},${messageId}`)).status, 400);
  assert.equal((await f.request(`/votes?message_ids=${messageId}&message_ids=${messageId}`)).status, 400);
  const deleted = await f.request(`/tables/messages?id=eq.${messageId}`, { method: "DELETE", headers: f.auth(author) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM message_votes").get()?.n, 0);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM reply_votes").get()?.n, 0);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications").get()?.n, 0);
});

test("deleting a parent refreshes reply authors whose upvote notifications cascade", async t => {
  const f = fixture(t);
  const owner = f.user("parent-owner");
  const replyAuthor = f.user("reply-author");
  const voter = f.user("reply-voter");
  const messageId = "parent-with-reply";
  const replyId = "voted-reply";
  f.database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES(?,'general',?,'Title','Body')")
    .run(messageId, owner.id);
  f.database.sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES(?,?,?,'Reply')")
    .run(replyId, messageId, replyAuthor.id);
  assert.equal((await f.set(voter, { reply_id: replyId }, 1)).status, 200);
  assert.equal((await readNotificationSnapshot(f.database.db, replyAuthor.id, 1)).unread_count, 1);
  f.published.length = 0;
  const deleted = await f.request(`/tables/messages?id=eq.${messageId}`, { method: "DELETE", headers: f.auth(owner) });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(new Set(f.published), new Set([owner.id, replyAuthor.id]));
  assert.equal((await readNotificationSnapshot(f.database.db, replyAuthor.id, 2)).unread_count, 0);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications").get()?.n, 0);
});

test("reading 100 requested targets respects D1's 100-parameter statement limit", async t => {
  const f = fixture(t);
  const author = f.user("many-owner");
  const ids = Array.from({ length: 100 }, (_, index) => `many-${index}`);
  for (const id of ids) f.database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES(?,'general',?,'Title','Body')")
    .run(id, author.id);
  const original = f.env.DB;
  f.env.DB = new Proxy(original, {
    get(target, property) {
      if (property !== "prepare") return Reflect.get(target, property, target);
      return (query: string) => new Proxy(target.prepare(query), {
        get(statement, key) {
          if (key !== "bind") return Reflect.get(statement, key, statement);
          return (...values: unknown[]) => {
            assert.ok(values.length <= 100, `D1 statement bound ${values.length} parameters`);
            return statement.bind(...values);
          };
        },
      });
    },
  });
  const result = await f.get(ids);
  assert.equal(result.length, 100);
  assert.ok(result.every(row => row.score === 1));
});

test("migration preserves existing reply notification IDs, reads, deliveries and seeds historical authors", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    const path = resolve(import.meta.dirname, "../../migrations");
    const files = readdirSync(path).filter(file => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files.filter(file => file < "012")) sqlite.exec(readFileSync(resolve(path, file), "utf8"));
    sqlite.prepare("INSERT INTO users(id,name) VALUES('old-owner','Owner'),('old-actor','Actor')").run();
    sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES('old-message','general','old-owner','Old','Body')").run();
    sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES('old-reply','old-message','old-actor','Reply')").run();
    sqlite.prepare("UPDATE notifications SET read_at='read',delivered_at='sent' WHERE reply_id='old-reply'").run();
    const before = sqlite.prepare("SELECT id,read_at,delivered_at FROM notifications WHERE reply_id='old-reply'").get();
    sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES('deleted-reply','old-message','old-actor','Reply')").run();
    const deletedId = Number(sqlite.prepare("SELECT id FROM notifications WHERE reply_id='deleted-reply'").get()?.id);
    sqlite.prepare("DELETE FROM replies WHERE id='deleted-reply'").run();
    sqlite.exec(readFileSync(resolve(path, "012_votes.sql"), "utf8"));
    assert.deepEqual(sqlite.prepare("SELECT id,read_at,delivered_at FROM notifications WHERE reply_id='old-reply'").get(), before);
    assert.equal(sqlite.prepare("SELECT kind FROM notifications WHERE reply_id='old-reply'").get()?.kind, "reply");
    assert.equal(sqlite.prepare("SELECT value FROM message_votes WHERE message_id='old-message'").get()?.value, 1);
    assert.equal(sqlite.prepare("SELECT value FROM reply_votes WHERE reply_id='old-reply'").get()?.value, 1);
    sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES('new-reply','old-message','old-actor','Reply')").run();
    assert.ok(Number(sqlite.prepare("SELECT id FROM notifications WHERE reply_id='new-reply'").get()?.id) > deletedId);
  } finally {
    sqlite.close();
  }
});
