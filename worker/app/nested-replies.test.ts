import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../testing/database";
import { handleRequest } from "./router";
import { readNotificationSnapshot } from "./notification-store";

type Reply = {
  id: string; message_id: string; parent_reply_id: string | null;
  user_id: string; body: string; created_at: string; direct_reply_count: number;
};

function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const identities = ["owner", "author", "other"].map(id => {
    const token = `bff_us_${createHash("sha256").update(id).digest("hex")}`;
    database.sqlite.prepare("INSERT INTO users(id,name) VALUES(?,?)").run(id, id);
    database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(createHash("sha256").update(token).digest("hex"), id, new Date(Date.now() + 60_000).toISOString());
    return { id, token };
  });
  database.sqlite.exec(`INSERT INTO messages(id,board_id,user_id,title,body) VALUES
    ('thread','general','owner','Thread','Body'), ('elsewhere','general','other','Other thread','Body');`);
  const request = (path: string, init: RequestInit = {}) => handleRequest(
    new Request(`https://api.yapern.com${path}`, init), { DB: database.db } as Env,
  );
  const post = (input: Record<string, unknown>, identity = identities[1], key?: string) => request("/tables/replies", {
    method: "POST", headers: { authorization: `Bearer ${identity.token}`, "content-type": "application/json", ...(key ? { "idempotency-key": key } : {}) },
    body: JSON.stringify(input),
  });
  const create = async (parent: string | null = null, identity = identities[1]): Promise<Reply> => {
    const response = await post({ message_id: "thread", parent_reply_id: parent, body: "A reply" }, identity);
    assert.equal(response.status, 201, await response.clone().text());
    return (await response.json() as { data: Reply[] }).data[0];
  };
  return { ...database, identities, request, post, create };
}

test("replies nest beyond presentation depth while counts track direct children and root thread totals", async t => {
  const f = fixture(t);
  const first = await f.post({ message_id: "thread", body: "Root reply" });
  assert.equal(first.status, 201);
  const root = (await first.json() as { data: Reply[] }).data[0];
  assert.equal(root.parent_reply_id, null);
  assert.equal(root.direct_reply_count, 0);
  const chain = [root];
  for (let depth = 1; depth < 32; depth++) {
    const reply = await f.create(chain.at(-1)!.id);
    assert.equal(reply.message_id, "thread");
    assert.equal(reply.parent_reply_id, chain.at(-1)!.id);
    assert.equal(reply.direct_reply_count, 0);
    assert.equal(reply.user_id, "author");
    chain.push(reply);
  }
  const sibling = await f.create(root.id);
  const response = await f.request("/tables/replies?message_id=eq.thread&order=created_at.asc&limit=100");
  assert.equal(response.status, 200);
  const replies = (await response.json() as { data: Reply[] }).data;
  assert.equal(replies.length, 33);
  for (let index = 0; index < chain.length; index++) {
    const reply = replies.find(item => item.id === chain[index].id)!;
    assert.equal(reply.direct_reply_count, index === 0 ? 2 : index === chain.length - 1 ? 0 : 1);
    assert.equal(reply.parent_reply_id, index ? chain[index - 1].id : null);
  }
  assert.equal(replies.find(reply => reply.id === sibling.id)!.direct_reply_count, 0);
  assert.equal(f.sqlite.prepare("SELECT reply_count FROM messages WHERE id='thread'").get()?.reply_count, 33);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM reply_votes WHERE value=1").get()?.n, 33);
  const projected = await f.request(`/tables/replies?select=id,parent_reply_id,direct_reply_count&id=eq.${root.id}`);
  assert.deepEqual(await projected.json(), { data: [{ id: root.id, parent_reply_id: null, direct_reply_count: 2 }] });
});

test("nested creation validates parent/root atomically and enforces authorship and read-only fields", async t => {
  const f = fixture(t);
  const parent = await f.create();
  const foreignParentResponse = await f.post({ message_id: "elsewhere", body: "Elsewhere" });
  const foreignParent = (await foreignParentResponse.json() as { data: Reply[] }).data[0];
  const before = f.sqlite.prepare("SELECT COUNT(*) AS n FROM replies").get()?.n;
  for (const input of [
    { message_id: "thread", parent_reply_id: "missing", body: "No parent" },
    { message_id: "thread", parent_reply_id: foreignParent.id, body: "Wrong thread" },
    { message_id: "missing", parent_reply_id: parent.id, body: "No root" },
    { message_id: "thread", parent_reply_id: "thread", body: "A message is not a reply" },
  ]) assert.equal((await f.post(input)).status, 404);
  for (const fields of [
    { parent_reply_id: " " }, { parent_reply_id: 1 }, { parent_reply_id: [] },
    { parent_reply_id: {} }, { reply_count: 7 }, { direct_reply_count: 7 }, { vote_score: 99 }, { id: "forged" },
  ]) assert.equal((await f.post({ message_id: "thread", body: "Invalid", ...fields })).status, 400);
  assert.equal((await f.post({ message_id: "thread", parent_reply_id: parent.id, body: "Spoofed", user_id: "owner" })).status, 403);
  const unauthenticated = await f.request("/tables/replies", {
    method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ message_id: "thread", parent_reply_id: parent.id, body: "Unauthenticated" }),
  });
  assert.equal(unauthenticated.status, 401);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM replies").get()?.n, before);
  f.sqlite.prepare("DELETE FROM replies WHERE id=?").run(parent.id);
  assert.equal((await f.post({ message_id: "thread", parent_reply_id: parent.id, body: "Deleted parent" })).status, 404);
});

test("database guards prevent cross-thread parents, self-links, cycles and structural changes", t => {
  const f = fixture(t);
  f.sqlite.exec(`INSERT INTO replies(id,message_id,user_id,body) VALUES('a','thread','author','A');
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('b','thread','other','B','a');`);
  assert.throws(() => f.sqlite.exec("INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('cross','elsewhere','author','Cross','a')"), /invalid_reply_parent/);
  assert.throws(() => f.sqlite.exec("INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('self','thread','author','Self','self')"), /invalid_reply_parent/);
  for (const update of [
    "UPDATE replies SET parent_reply_id='b' WHERE id='a'",
    "UPDATE replies SET parent_reply_id=NULL WHERE id='b'",
    "UPDATE replies SET message_id='elsewhere' WHERE id='a'",
    "UPDATE replies SET id='new-id' WHERE id='b'",
  ]) assert.throws(() => f.sqlite.exec(update), /reply_thread_is_immutable/);
  assert.throws(() => f.sqlite.exec("INSERT OR REPLACE INTO replies(id,message_id,user_id,body) VALUES('a','elsewhere','author','Replacement')"), /reply_thread_is_immutable/);
  assert.throws(() => f.sqlite.exec("INSERT OR REPLACE INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('a','thread','author','Cyclic replacement','b')"), /reply_thread_is_immutable/);
  f.sqlite.exec("UPDATE replies SET body='Edited',parent_reply_id=parent_reply_id,message_id=message_id,id=id WHERE id='b'");
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id='a'").get()?.direct_reply_count, 1);
});

test("direct-child counters stay atomic through rollback, failed writes, leaf deletion and bulk subtree deletion", t => {
  const f = fixture(t);
  f.sqlite.exec(`INSERT INTO replies(id,message_id,user_id,body) VALUES('a','thread','author','A');
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('b','thread','other','B','a');
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('c','thread','author','C','b');
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('d','thread','author','D','a');
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('e','thread','other','E','d');`);
  const counts = () => f.sqlite.prepare("SELECT id,direct_reply_count FROM replies ORDER BY id").all().map(row => ({ ...row }));
  const before = counts();
  assert.deepEqual(before, [
    { id: "a", direct_reply_count: 2 }, { id: "b", direct_reply_count: 1 }, { id: "c", direct_reply_count: 0 },
    { id: "d", direct_reply_count: 1 }, { id: "e", direct_reply_count: 0 },
  ]);
  assert.throws(() => f.sqlite.exec("DELETE FROM replies WHERE id='b'"), /FOREIGN KEY/);
  assert.deepEqual(counts(), before, "deleting a parent cannot erase or orphan other authors' descendants");
  assert.throws(() => f.sqlite.exec(`INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES
    ('valid','thread','author','Valid','c'), ('invalid','elsewhere','other','Invalid','c');`), /invalid_reply_parent/);
  assert.deepEqual(counts(), before);
  f.sqlite.exec(`BEGIN;
    INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('temporary','thread','author','Temporary','e');
    DELETE FROM replies WHERE id IN ('b','c'); ROLLBACK;`);
  assert.deepEqual(counts(), before);
  f.sqlite.exec("DELETE FROM replies WHERE id IN ('b','c')");
  assert.deepEqual(counts(), [{ id: "a", direct_reply_count: 1 }, { id: "d", direct_reply_count: 1 }, { id: "e", direct_reply_count: 0 }]);
  f.sqlite.exec("DELETE FROM replies WHERE id='e'");
  assert.deepEqual(counts(), [{ id: "a", direct_reply_count: 1 }, { id: "d", direct_reply_count: 0 }]);
  assert.equal(f.sqlite.prepare("SELECT reply_count FROM messages WHERE id='thread'").get()?.reply_count, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM reply_votes").get()?.n, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE reply_id IN ('b','c','e')").get()?.n, 0);
});

test("a thread deeper than SQLite's cascade-trigger limit can be deleted as one message", async t => {
  const f = fixture(t);
  const insert = f.sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES(?,'thread','author','Deep reply',?)");
  f.sqlite.exec("BEGIN");
  for (let depth = 0; depth < 1100; depth++) insert.run(`deep-${depth}`, depth ? `deep-${depth - 1}` : null);
  f.sqlite.exec("COMMIT");
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id='deep-0'").get()?.direct_reply_count, 1);
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id='deep-1099'").get()?.direct_reply_count, 0);
  f.sqlite.exec("INSERT INTO replies(id,message_id,user_id,body) VALUES('unrelated','elsewhere','owner','Unrelated')");
  const denied = await f.request("/tables/messages?id=eq.thread", {
    method: "DELETE", headers: { authorization: `Bearer ${f.identities[1].token}` },
  });
  assert.equal(denied.status, 403);
  const deleted = await f.request("/tables/messages?id=eq.thread&board_id=eq.general&user_id=eq.owner", {
    method: "DELETE", headers: { authorization: `Bearer ${f.identities[0].token}` },
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await deleted.json(), { data: [], meta: { changes: 1 } });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM replies WHERE message_id='thread'").get()?.n, 0);
  assert.deepEqual(f.sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  assert.equal(f.sqlite.prepare("SELECT reply_count FROM messages WHERE id='elsewhere'").get()?.reply_count, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM reply_votes").get()?.n, 1);
});

test("nested notifications go only to the direct parent author with root links and no self-notifications", async t => {
  const f = fixture(t);
  const rootReply = await f.create(null, f.identities[1]);
  const nested = await f.create(rootReply.id, f.identities[2]);
  await f.create(nested.id, f.identities[2]);
  await f.create(rootReply.id, f.identities[0]);
  const recipients = f.sqlite.prepare("SELECT user_id,reply_id FROM notifications WHERE kind='reply' ORDER BY id").all().map(row => ({ ...row }));
  assert.equal(recipients.length, 3);
  assert.deepEqual(recipients.slice(0, 2), [
    { user_id: "owner", reply_id: rootReply.id }, { user_id: "author", reply_id: nested.id },
  ]);
  assert.equal(recipients[2].user_id, "author", "message owner answering a reply notifies that reply author");
  const snapshot = await readNotificationSnapshot(f.db, "author", 1);
  assert.equal(snapshot.unread_count, 2);
  const event = snapshot.notifications.find(notification => notification.reply_id === nested.id)!;
  assert.equal(event.message_id, "thread");
  assert.equal(event.board_slug, "general");
  assert.equal(event.actor_name, "other");
});

test("idempotent reply retries create one row, vote, notification and counter increment", async t => {
  const f = fixture(t);
  const parent = await f.create(null, f.identities[0]);
  const input = { message_id: "thread", parent_reply_id: parent.id, body: "Retry this reply" };
  const key = "12345678-1234-4567-890a-123456789abc";
  const responses = await Promise.all(Array.from({ length: 8 }, () => f.post(input, f.identities[1], key)));
  const ids: string[] = [];
  for (const response of responses) {
    assert.equal(response.status, 201, await response.clone().text());
    const row = (await response.json() as { data: Reply[] }).data[0];
    ids.push(row.id);
    assert.equal("idempotency_key" in row, false);
    assert.equal("vote_score" in row, false);
  }
  assert.equal(new Set(ids).size, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM replies").get()?.n, 2);
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id=?").get(parent.id)?.direct_reply_count, 1);
  assert.equal(f.sqlite.prepare("SELECT reply_count FROM messages WHERE id='thread'").get()?.reply_count, 2);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM reply_votes WHERE reply_id=?").get(ids[0])?.n, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM notifications WHERE reply_id=?").get(ids[0])?.n, 1);
  for (const changed of [
    { ...input, body: "Changed body" }, { ...input, parent_reply_id: null }, { ...input, message_id: "elsewhere" },
  ]) {
    const conflict = await f.post(changed, f.identities[1], key);
    assert.equal(conflict.status, 409);
    assert.deepEqual(await conflict.json(), { error: "idempotency_conflict" });
  }
  assert.equal((await f.post(input, f.identities[2], key)).status, 201, "keys are scoped to the authenticated user");
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id=?").get(parent.id)?.direct_reply_count, 2);
  for (const invalidKey of ["short", "bad key value", "invalid/key", "a".repeat(129)]) {
    assert.equal((await f.post(input, f.identities[1], invalidKey)).status, 400);
  }
  const preflight = await f.request("/tables/replies", {
    method: "OPTIONS", headers: {
      origin: "https://yapern.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,idempotency-key,content-type",
    },
  });
  assert.match(preflight.headers.get("access-control-allow-headers") ?? "", /idempotency-key/i);
});

test("nested migration preserves historical replies, counters, votes and notification delivery state", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    const path = resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(path).filter(file => /^\d+.*\.sql$/.test(file) && file < "014").sort()) {
      sqlite.exec(readFileSync(resolve(path, file), "utf8"));
    }
    sqlite.exec(`INSERT INTO users(id,name) VALUES('owner','Owner'),('actor','Actor');
      INSERT INTO messages(id,board_id,user_id,title,body) VALUES('old-thread','general','owner','Old thread','Body');
      INSERT INTO replies(id,message_id,user_id,body) VALUES('old-reply','old-thread','actor','Historical reply');
      UPDATE notifications SET read_at='2026-01-01',delivered_at='2026-01-02';`);
    const replies = sqlite.prepare("SELECT * FROM replies").all();
    const messages = sqlite.prepare("SELECT * FROM messages").all();
    const votes = sqlite.prepare("SELECT * FROM reply_votes").all();
    const notifications = sqlite.prepare("SELECT * FROM notifications").all();
    const sequence = sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'").get()?.seq;
    sqlite.exec(readFileSync(resolve(path, "014_nested_replies.sql"), "utf8"));
    assert.deepEqual(sqlite.prepare("SELECT * FROM replies").all().map(row => ({ ...row })), replies.map(row => ({ ...row, parent_reply_id: null, direct_reply_count: 0, idempotency_key: null, vote_score: 1 })));
    assert.deepEqual(sqlite.prepare("SELECT * FROM messages").all(), messages);
    assert.deepEqual(sqlite.prepare("SELECT * FROM reply_votes").all(), votes);
    assert.deepEqual(sqlite.prepare("SELECT * FROM notifications").all(), notifications);
    assert.equal(sqlite.prepare("SELECT seq FROM sqlite_sequence WHERE name='notifications'").get()?.seq, sequence);
    sqlite.exec("INSERT INTO replies(id,message_id,user_id,body,parent_reply_id) VALUES('new-nested','old-thread','owner','Nested','old-reply')");
    assert.equal(sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id='old-reply'").get()?.direct_reply_count, 1);
    assert.equal(sqlite.prepare("SELECT reply_count FROM messages WHERE id='old-thread'").get()?.reply_count, 2);
    assert.equal(sqlite.prepare("SELECT user_id FROM notifications ORDER BY id DESC LIMIT 1").get()?.user_id, "actor");
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally {
    sqlite.close();
  }
});
