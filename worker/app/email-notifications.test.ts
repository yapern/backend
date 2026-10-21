import test from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { adminFixture } from "../testing/admin";
import { deliverEmailNotifications } from "./email-notifications";
import { handleRequest } from "./router";

const path = "/account/email-notifications";
const enabled = { email_notify_replies: true, email_notify_votes: true, email_notify_sub_yap_messages: true };
type Fixture = ReturnType<typeof adminFixture>;

function thread(f: Fixture) {
  f.sqlite.prepare("UPDATE users SET email_notify_sub_yap_messages=0").run();
  f.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES('root','general','admin','A thread','Body')").run();
}

function reply(f: Fixture, body = "Hello <friends>", parent: string | null = null, token = f.memberToken, key?: string) {
  return f.call("/tables/replies", {
    method: "POST", token, body: JSON.stringify({ message_id: "root", body, parent_reply_id: parent }),
    headers: key ? { "idempotency-key": key } : {},
  });
}

test("email preferences default to true, remain private, and save real booleans for only the current user", async t => {
  const f = adminFixture(t);
  assert.deepEqual(await (await f.call(path)).json(), enabled);
  const preferences = { ...enabled, email_notify_replies: false, email_notify_sub_yap_messages: false };
  const saved = await f.call(path, { method: "PATCH", body: JSON.stringify(preferences) });
  assert.equal(saved.status, 200);
  assert.equal(saved.headers.get("cache-control"), "no-store");
  assert.deepEqual(await saved.json(), preferences);
  assert.deepEqual(await (await f.call(path)).json(), preferences);
  assert.deepEqual(await (await f.call(path, { token: f.memberToken })).json(), enabled);
  assert.equal((await f.call(path, { token: null })).status, 401);
  assert.equal((await f.call(path, { token: null, method: "PATCH", body: JSON.stringify(enabled) })).status, 401);
  assert.equal((await f.call(`${path}?user_id=member`)).status, 400);
  assert.equal((await f.call(path, { origin: "https://evil.example" })).status, 403);
  for (const input of [{}, { ...enabled, email_notify_votes: 1 }, { ...enabled, email_notify_replies: "false" },
    { ...enabled, email_notify_sub_yap_messages: null }, { ...enabled, user_id: "member" }]) {
    assert.equal((await f.call(path, { method: "PATCH", body: JSON.stringify(input) })).status, 400);
  }
  assert.equal((await f.call("/tables/users?select=id,email_notify_replies")).status, 400);
  const publicRows = await (await f.call("/tables/users")).json() as { data: object[] };
  for (const row of publicRows.data) assert.deepEqual(Object.keys(row).sort(), ["id", "name"]);
  f.sqlite.prepare("UPDATE sessions SET expires_at='2000-01-01'").run();
  assert.equal((await f.call(path)).status, 401);
});

test("migration enables existing accounts without emailing historical events", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    const directory = resolve(import.meta.dirname, "../../migrations");
    for (const file of readdirSync(directory).filter(file => /^\d+.*\.sql$/.test(file) && file < "017").sort()) {
      sqlite.exec(readFileSync(resolve(directory, file), "utf8"));
    }
    sqlite.exec(`INSERT INTO users(id,email) VALUES('old','old@example.com'),('old-replier','replier@example.com');
      INSERT INTO messages(id,board_id,user_id,body) VALUES('old-post','general','old','Historical');
      INSERT INTO replies(message_id,user_id,body) VALUES('old-post','old-replier','Historical reply');`);
    sqlite.exec(readFileSync(resolve(directory, "017_email_notifications.sql"), "utf8"));
    assert.deepEqual({ ...sqlite.prepare("SELECT email_notify_replies,email_notify_votes,email_notify_sub_yap_messages FROM users WHERE id='old'").get() },
      { email_notify_replies: 1, email_notify_votes: 1, email_notify_sub_yap_messages: 1 });
    assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM email_notifications").get()?.n, 0);
    assert.deepEqual(sqlite.prepare("SELECT user_id FROM board_participants ORDER BY user_id").all().map(row => row.user_id), ["old", "old-replier"]);
    assert.deepEqual(sqlite.prepare("PRAGMA foreign_key_check").all(), []);
  } finally { sqlite.close(); }
});

test("direct and nested replies email the author being answered, with safe content and working deep links", async t => {
  const f = adminFixture(t);
  thread(f);
  const first = await reply(f);
  assert.equal(first.status, 201);
  const firstId = (await first.json() as { data: { id: string }[] }).data[0].id;
  assert.equal(f.emails.length, 1);
  assert.equal(f.emails[0].to, "OneOne@Gmail.com");
  assert.match(f.emails[0].subject!, /reply to your message/);
  assert.ok(f.emails[0].text!.includes(`https://yapern.com/y/general/root#reply-${firstId}`));
  assert.match(f.emails[0].html!, /Hello &lt;friends&gt;/);
  assert.match(f.emails[0].text!, /Unsubscribe: https:\/\/api.yapern.com\/unsubscribe\?email=/);
  assert.equal((await reply(f, "Nested answer", firstId, f.adminToken)).status, 201);
  assert.equal(f.emails.length, 2);
  assert.equal(f.emails[1].to, "member@example.com");
  assert.match(f.emails[1].subject!, /reply to your reply/);
  assert.equal((await reply(f, "Talking to myself", firstId)).status, 201);
  assert.equal((await reply(f, "Own root", null, f.adminToken)).status, 201);
  assert.equal(f.emails.length, 2);
});

test("retries of the same reply do not send another email", async t => {
  const f = adminFixture(t);
  thread(f);
  for (let i = 0; i < 2; i++) assert.equal((await reply(f, "One answer", null, f.memberToken, "email-reply-key")).status, 201);
  assert.equal(f.emails.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM email_notifications").get()?.n, 1);
});

test("upvotes and downvotes on messages and replies email once per actual change, excluding removals and self-votes", async t => {
  const f = adminFixture(t);
  thread(f);
  f.sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES('answer','root','admin','Answer')").run();
  for (const target of [{ message_id: "root" }, { reply_id: "answer" }]) {
    const vote = (value: number, token = f.memberToken) => f.call("/votes", { method: "PUT", token, body: JSON.stringify({ ...target, value }) });
    const before = f.emails.length;
    assert.equal((await vote(1)).status, 200);
    assert.equal((await vote(1)).status, 200);
    assert.equal(f.emails.length, before + 1);
    assert.match(f.emails.at(-1)!.subject!, /upvoted/);
    assert.equal((await vote(-1)).status, 409);
    assert.equal((await vote(0)).status, 200);
    assert.equal(f.emails.length, before + 1);
    assert.equal((await vote(-1)).status, 200);
    assert.equal((await vote(-1)).status, 200);
    assert.equal(f.emails.length, before + 2);
    assert.match(f.emails.at(-1)!.subject!, /downvoted/);
    assert.match(f.emails.at(-1)!.subject!, "reply_id" in target ? /your reply/ : /your message/);
    assert.ok(f.emails.at(-1)!.text!.includes("reply_id" in target ? "/y/general/root#reply-answer" : "/y/general/root"));
    assert.equal((await vote(0, f.adminToken)).status, 200);
    assert.equal((await vote(-1, f.adminToken)).status, 200);
    assert.equal(f.emails.length, before + 2);
  }
});

test("new messages email each prior message or reply author in that sub-yap once", async t => {
  const f = adminFixture(t);
  f.sqlite.exec(`UPDATE users SET email_notify_sub_yap_messages=0;
    INSERT INTO users(id,email,email_notify_sub_yap_messages) VALUES
      ('posted','posted@example.com',0),('replied','replied@example.com',0),
      ('disabled','disabled@example.com',0),('elsewhere','elsewhere@example.com',0),('deleted','deleted@example.com',0);
    INSERT INTO boards(id,slug,name) VALUES('other','other','Other');
    INSERT INTO messages(id,board_id,user_id,title,body) VALUES
      ('root','general','posted','First','Body'),('second','general','posted','Second','Body'),
      ('other-post','other','elsewhere','Other','Body'),('deleted-post','general','deleted','Deleted','Body');
    INSERT INTO replies(message_id,user_id,body) VALUES
      ('root','replied','One'),('root','replied','Two'),('root','disabled','Off');
    DELETE FROM messages WHERE id='deleted-post';
    UPDATE users SET email_notify_sub_yap_messages=1 WHERE id<>'disabled';`);
  const created = await f.call("/tables/messages", { method: "POST", body: JSON.stringify({ board_id: "general", title: "A new message", body: "News" }) });
  assert.equal(created.status, 201);
  const id = (await created.json() as { data: { id: string }[] }).data[0].id;
  // Ignore reply jobs from fixture setup when checking board message recipients.
  const emails = f.emails.filter(email => email.subject!.startsWith("New message"));
  assert.deepEqual(emails.map(email => email.to).sort(), ["deleted@example.com", "posted@example.com", "replied@example.com"]);
  for (const email of emails) {
    assert.ok(email.text!.includes(`https://yapern.com/y/general/${id}`));
    assert.match(email.text!, /A new message\n\nNews/);
  }
});

test("each preference independently suppresses its events without changing the others", async t => {
  const f = adminFixture(t);
  thread(f);
  await f.call(path, { method: "PATCH", body: JSON.stringify({ ...enabled, email_notify_replies: false, email_notify_sub_yap_messages: false }) });
  assert.equal((await reply(f)).status, 201);
  assert.equal(f.emails.length, 0);
  await f.call("/votes", { method: "PUT", token: f.memberToken, body: JSON.stringify({ message_id: "root", value: -1 }) });
  assert.equal(f.emails.length, 1);
  await f.call(path, { method: "PATCH", body: JSON.stringify({ ...enabled, email_notify_votes: false, email_notify_sub_yap_messages: false }) });
  await reply(f, "Now enabled");
  assert.equal(f.emails.length, 2);
  await f.call("/votes", { method: "PUT", token: f.memberToken, body: JSON.stringify({ message_id: "root", value: 0 }) });
  await f.call("/votes", { method: "PUT", token: f.memberToken, body: JSON.stringify({ message_id: "root", value: 1 }) });
  assert.equal(f.emails.length, 2);
});

test("queued emails recheck changed preferences, account and normalized address unsubscribes", async t => {
  for (const optOut of ["preference", "account", "address"] as const) {
    await t.test(optOut, async t => {
      const f = adminFixture(t);
      thread(f);
      const binding = f.env.MARKETING_EMAIL;
      f.env.MARKETING_EMAIL = undefined as unknown as SendEmail;
      assert.equal((await reply(f)).status, 201);
      if (optOut === "preference") f.sqlite.prepare("UPDATE users SET email_notify_replies=0 WHERE id='admin'").run();
      else if (optOut === "account") f.sqlite.prepare("UPDATE users SET marketing_email_unsubscribed=1 WHERE id='admin'").run();
      else f.sqlite.prepare("INSERT INTO marketing_email_unsubscribes(email) VALUES('oneone@gmail.com')").run();
      f.env.MARKETING_EMAIL = binding;
      await deliverEmailNotifications(f.env);
      assert.equal(f.emails.length, 0);
      assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM email_notifications WHERE completed_at IS NULL").get()?.n, 0);
    });
  }
});

test("failed email delivery preserves the post, retries later, and never resends completed jobs", async t => {
  const f = adminFixture(t);
  thread(f);
  const binding = f.env.MARKETING_EMAIL;
  f.env.MARKETING_EMAIL = { async send() { throw new Error("provider unavailable"); } } as SendEmail;
  assert.equal((await reply(f)).status, 201);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM replies").get()?.n, 1);
  const pending = f.sqlite.prepare("SELECT attempts,available_at,completed_at FROM email_notifications").get()!;
  assert.equal(pending.attempts, 1);
  assert.equal(pending.completed_at, null);
  assert.ok(Number(pending.available_at) > Date.now());
  f.env.MARKETING_EMAIL = binding;
  await deliverEmailNotifications(f.env);
  assert.equal(f.emails.length, 0);
  f.sqlite.prepare("UPDATE email_notifications SET available_at=0").run();
  await deliverEmailNotifications(f.env);
  await deliverEmailNotifications(f.env);
  assert.equal(f.emails.length, 1);
});

test("concurrent drains claim a job once and deletion cancels queued events", async t => {
  const f = adminFixture(t);
  thread(f);
  const binding = f.env.MARKETING_EMAIL;
  f.env.MARKETING_EMAIL = undefined as unknown as SendEmail;
  await reply(f);
  f.env.MARKETING_EMAIL = binding;
  await Promise.all([deliverEmailNotifications(f.env), deliverEmailNotifications(f.env)]);
  assert.equal(f.emails.length, 1);
  f.env.MARKETING_EMAIL = undefined as unknown as SendEmail;
  await reply(f, "Another answer");
  f.sqlite.prepare("DELETE FROM messages WHERE id='root'").run();
  f.env.MARKETING_EMAIL = binding;
  await deliverEmailNotifications(f.env);
  assert.equal(f.emails.length, 1);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS n FROM email_notifications").get()?.n, 0);
});

test("Worker request context schedules email delivery in the background", async t => {
  const f = adminFixture(t);
  thread(f);
  const pending: Promise<unknown>[] = [];
  const response = await handleRequest(new Request("https://api.yapern.com/tables/replies", {
    method: "POST", headers: { authorization: `Bearer ${f.memberToken}`, "content-type": "application/json" },
    body: JSON.stringify({ message_id: "root", body: "Background answer" }),
  }), f.env, { waitUntil(task: Promise<unknown>) { pending.push(task); } } as ExecutionContext);
  assert.equal(response.status, 201);
  assert.equal(pending.length, 1);
  await Promise.all(pending);
  assert.equal(f.emails.length, 1);
});
