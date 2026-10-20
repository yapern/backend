import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { handleRequest } from "./router";
import { retryNotificationDelivery } from "./notifications";
import { readNotificationSnapshot } from "./notification-store";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.com";
type Identity = { id: string; token: string };

function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const identities = new Map<string, Identity>();
  const snapshotVersions = new Map<string, number>();
  let failPublish = false;
  let failLookup = false;
  let published: string[] = [];
  const stub = {
    async fetch(request: Request): Promise<Response> {
      const url = new URL(request.url);
      const input = await request.json() as { user_id: string; through_id?: number };
      if (url.pathname === "/publish" && failPublish) return Response.json({ error: "temporarily_unavailable" }, { status: 503 });
      if (url.pathname === "/read") {
        await database.db.prepare(`UPDATE notifications SET read_at=?
          WHERE user_id=? AND id<=? AND read_at IS NULL`)
          .bind(new Date().toISOString(), input.user_id, input.through_id).run();
      }
      if (url.pathname === "/publish") published.push(input.user_id);
      const version = (snapshotVersions.get(input.user_id) ?? 0) + 1;
      snapshotVersions.set(input.user_id, version);
      const snapshot = await readNotificationSnapshot(database.db, input.user_id, version);
      return Response.json(url.pathname === "/ticket"
        ? { ticket: "a".repeat(64), user_id: input.user_id }
        : snapshot);
    },
  };
  const db = new Proxy(database.db, {
    get(target, property) {
      if (property === "prepare") return (query: string) => {
        if (failLookup && query.includes("SELECT user_id FROM notifications WHERE reply_id")) {
          throw new Error("notification lookup unavailable");
        }
        return target.prepare(query);
      };
      const value = Reflect.get(target, property, target) as unknown;
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const env = {
    DB: db,
    NOTIFICATIONS: {
      idFromName: (name: string) => name,
      get: (id: string) => {
        assert.ok(id);
        return stub;
      },
    },
  } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`${origin}${path}`, init), env);
  const user = (id: string): Identity => {
    const existing = identities.get(id);
    if (existing) return existing;
    const token = `bff_us_${createHash("sha256").update(id).digest("hex")}`;
    const email = `${id}@example.com`;
    database.sqlite.prepare("INSERT INTO users(id,email,name) VALUES(?,?,?)").run(id, email, id);
    database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(createHash("sha256").update(token).digest("hex"), id, new Date(Date.now() + 60_000).toISOString());
    const identity = { id, token };
    identities.set(id, identity);
    return identity;
  };
  const authorized = (identity: Identity, headers: HeadersInit = {}) => ({
    authorization: `Bearer ${identity.token}`,
    ...headers,
  });
  const message = (owner: Identity, id = `message-${owner.id}`) => {
    database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES(?, 'general', ?, ?, 'Body')")
      .run(id, owner.id, `Title ${id}`);
    return id;
  };
  const reply = async (actor: Identity, messageId: string, body = "A reply") => request("/tables/replies", {
    method: "POST", headers: authorized(actor, { "content-type": "application/json" }),
    body: JSON.stringify({ message_id: messageId, body }),
  });
  return {
    database, env, request, user, authorized, message, reply, stub,
    setFailPublish(value: boolean) { failPublish = value; },
    setFailLookup(value: boolean) { failLookup = value; },
    getPublished() { return [...published]; },
    resetPublished() { published = []; },
  };
}

test("reply trigger creates only recipient notifications and a failed push leaves retryable work without failing the reply", async t => {
  const f = fixture(t);
  const recipient = f.user("reply-owner");
  const actor = f.user("reply-actor");
  const ownedMessage = f.message(recipient);
  f.setFailPublish(true);

  const created = await f.reply(actor, ownedMessage);
  assert.equal(created.status, 201, await created.clone().text());
  const createdReply = (await created.json() as { data: Array<{ id: string }> }).data[0];
  const notification = f.database.sqlite.prepare("SELECT user_id,reply_id,delivered_at FROM notifications")
    .get() as { user_id: string; reply_id: string; delivered_at: string | null };
  assert.equal(notification.user_id, recipient.id);
  assert.equal(notification.reply_id, createdReply.id);
  assert.equal(notification.delivered_at, null);

  const selfReply = await f.reply(recipient, ownedMessage, "Owner reply");
  assert.equal(selfReply.status, 201);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get()?.count, 1);

  const missingMessage = await f.reply(actor, "missing-message");
  assert.equal(missingMessage.status, 404);
  const invalidReply = await f.reply(actor, ownedMessage, "   ");
  assert.equal(invalidReply.status, 400);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get()?.count, 1);
  assert.throws(() => f.database.sqlite.prepare("INSERT INTO replies(message_id,user_id,body) VALUES('missing-message',?,'bad')")
    .run(actor.id), /FOREIGN KEY/);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications").get()?.count, 1);

  f.setFailPublish(false);
  f.resetPublished();
  await retryNotificationDelivery(f.env);
  assert.deepEqual(f.getPublished(), [recipient.id]);
  const delivered = f.database.sqlite.prepare("SELECT delivered_at FROM notifications WHERE reply_id=?")
    .get(createdReply.id) as { delivered_at: string | null };
  assert.ok(delivered.delivered_at);
});

test("a notification lookup failure after reply commit does not turn the successful reply into an error", async t => {
  const f = fixture(t);
  const recipient = f.user("lookup-owner");
  const actor = f.user("lookup-actor");
  const messageId = f.message(recipient);
  f.setFailLookup(true);

  const created = await f.reply(actor, messageId);
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM replies").get()?.count, 1);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=?").get(recipient.id)?.count, 1);
  assert.equal(f.database.sqlite.prepare("SELECT delivered_at FROM notifications WHERE user_id=?").get(recipient.id)?.delivered_at, null);
});

test("notification routes require a session, reject disallowed origins, and acknowledge only through the observed ID", async t => {
  const f = fixture(t);
  const recipient = f.user("read-owner");
  const actor = f.user("read-actor");
  const other = f.user("other-owner");
  const ownedMessage = f.message(recipient);
  const otherMessage = f.message(other);
  const firstReply = await f.reply(actor, ownedMessage);
  assert.equal(firstReply.status, 201);
  const firstId = f.database.sqlite.prepare("SELECT MAX(id) AS id FROM notifications WHERE user_id=?")
    .get(recipient.id)?.id as number;
  const otherReply = await f.reply(actor, otherMessage);
  assert.equal(otherReply.status, 201);

  assert.equal((await f.request("/notifications")).status, 401);
  const blocked = await f.request("/notifications", {
    headers: f.authorized(recipient, { origin: "https://evil.example" }),
  });
  assert.equal(blocked.status, 403);
  const initial = await f.request("/notifications", { headers: f.authorized(recipient) });
  assert.equal(initial.status, 200, await initial.clone().text());
  const snapshot = await initial.json() as {
    unread_count: number; last_id: number;
    notifications: Array<{ id: number; reply_id: string; message_id: string; board_slug: string; message_title: string; actor_name: string; read_at: string | null }>;
  };
  assert.equal(snapshot.unread_count, 1);
  assert.equal(snapshot.last_id, firstId);
  assert.equal(snapshot.notifications.length, 1);
  assert.equal(snapshot.notifications[0].message_id, ownedMessage);
  assert.equal(snapshot.notifications[0].board_slug, "general");
  assert.equal(snapshot.notifications[0].message_title, `Title ${ownedMessage}`);
  assert.equal(snapshot.notifications[0].actor_name, actor.id);
  assert.equal(snapshot.notifications[0].read_at, null);

  const invalidAck = await f.request("/notifications/read", {
    method: "POST", headers: f.authorized(recipient, { "content-type": "application/json" }),
    body: JSON.stringify({ through_id: -1 }),
  });
  assert.equal(invalidAck.status, 400);
  const ack = await f.request("/notifications/read", {
    method: "POST", headers: f.authorized(recipient, { "content-type": "application/json" }),
    body: JSON.stringify({ through_id: firstId }),
  });
  assert.equal(ack.status, 200, await ack.clone().text());
  assert.equal((await ack.json() as { unread_count: number }).unread_count, 0);

  const newerReply = await f.reply(actor, ownedMessage);
  assert.equal(newerReply.status, 201);
  const reread = await f.request("/notifications/read", {
    method: "POST", headers: f.authorized(recipient, { "content-type": "application/json" }),
    body: JSON.stringify({ through_id: firstId }),
  });
  assert.equal(reread.status, 200);
  const afterOldAck = await reread.json() as { unread_count: number; notifications: Array<{ id: number; read_at: string | null }> };
  assert.equal(afterOldAck.unread_count, 1);
  assert.ok(afterOldAck.notifications.find(row => row.id > firstId)?.read_at === null);
  const isolated = await f.request("/notifications", { headers: f.authorized(other) });
  assert.equal((await isolated.json() as { unread_count: number }).unread_count, 1);
});

test("deleting a message cascades its replies and their notifications", async t => {
  const f = fixture(t);
  const recipient = f.user("delete-owner");
  const actor = f.user("delete-actor");
  const messageId = f.message(recipient);
  const reply = await f.reply(actor, messageId);
  assert.equal(reply.status, 201);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=?").get(recipient.id)?.count, 1);

  const deleted = await f.request(`/tables/messages?id=eq.${messageId}`, {
    method: "DELETE", headers: f.authorized(recipient),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM replies WHERE message_id=?").get(messageId)?.count, 0);
  assert.equal(f.database.sqlite.prepare("SELECT COUNT(*) AS count FROM notifications WHERE user_id=?").get(recipient.id)?.count, 0);
});
