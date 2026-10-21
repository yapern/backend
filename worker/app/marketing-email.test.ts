import test from "node:test";
import assert from "node:assert/strict";
import { adminFixture } from "../testing/admin";
import { marketingSender, sendMarketingEmail } from "../lib/marketing-email";
import { marketingUnsubscribeUrl } from "../templates/marketing-email";
import { handleRequest } from "./router";

const input = { to: "foo@bar.com", subj: "New idea", from: "Bob Smith <bob@yapern.com>", message: "Hello everyone" };
const sendPath = "/api/send-marketing-email";
const unsubscribePath = "/api/unsubscribe";
const sendOptions = { method: "POST", body: JSON.stringify(input) };

test("marketing sends require a current admin session, trusted Origin and POST", async t => {
  const f = adminFixture(t);
  for (const [token, status] of [[null, 401], ["unknown", 401], [f.memberToken, 403]] as const) {
    assert.equal((await f.call(sendPath, { ...sendOptions, token })).status, status);
  }
  for (const origin of [null, "https://example.com"]) {
    assert.equal((await f.call(sendPath, { ...sendOptions, origin })).status, 403);
  }
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    const response = await f.call(sendPath, { method });
    assert.equal(response.status, 405);
    assert.equal(response.headers.get("allow"), "POST, OPTIONS");
  }
  const preflight = await f.call(sendPath, { method: "OPTIONS", token: null });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://yapern.com");
  f.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  assert.equal((await f.call(sendPath, sendOptions)).status, 401);
  assert.equal(f.emails.length, 0);
});

test("marketing email includes escaped Yapern HTML, named sender, text and recipient unsubscribe link", async t => {
  const f = adminFixture(t);
  const email = { ...input, to: "Member+news@example.com", subj: 'Hi <friends> & "everyone"', message: 'Hello <everyone> & \'friends\'\r\n\r\n<img src="x">\rBye\nEnd' };
  const response = await f.call(sendPath, { method: "POST", body: JSON.stringify(email) });
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, messageId: "marketing-123" });
  assert.equal(response.headers.get("cache-control"), "no-store");
  const sent = f.emails[0];
  assert.deepEqual(sent.from, { email: "bob@yapern.com", name: "Bob Smith" });
  assert.equal(sent.to, email.to);
  assert.equal(sent.subject, email.subj);
  const url = marketingUnsubscribeUrl(email.to);
  assert.equal(new URL(url).searchParams.get("email"), email.to);
  assert.equal(sent.text, `${email.message}\n\nUnsubscribe: ${url}`);
  assert.ok(sent.html!.includes(`href="${url}"`));
  assert.match(sent.html!, /Hello &lt;everyone&gt; &amp; &#39;friends&#39;<br>\n<br>\n&lt;img src=&quot;x&quot;&gt;<br>\nBye<br>\nEnd/);
  assert.match(sent.html!, /Hi &lt;friends&gt; &amp; &quot;everyone&quot;/);
  assert.match(sent.html!, /Yapern/);
  assert.doesNotMatch(sent.html!, /mainbrella|<img src="x">|<friends>/i);
  await f.call(sendPath, { method: "POST", body: JSON.stringify({ ...email, fancy: true }) });
  assert.deepEqual(f.emails[1], sent);
  await sendMarketingEmail(f.env, email);
  assert.deepEqual(f.emails[2], sent);
});

test("fancy=false uses plain HTML with the escaped message and a simple unsubscribe footer", async t => {
  const f = adminFixture(t);
  const email = { ...input, fancy: false, message: "Hello <friends>\nNext line" };
  const response = await f.call(sendPath, { method: "POST", body: JSON.stringify(email) });
  assert.equal(response.status, 202);
  const sent = f.emails[0];
  assert.match(sent.html!, /background-color:#ffffff;color:#000000;font-family:Arial,Helvetica,sans-serif/);
  assert.match(sent.html!, /Hello &lt;friends&gt;<br>\nNext line/);
  assert.equal((sent.html!.match(/<a\b/g) ?? []).length, 1);
  assert.doesNotMatch(sent.html!, /<(?:h1|table|img)\b/);
  assert.ok(sent.text!.endsWith(`Unsubscribe: ${marketingUnsubscribeUrl(email.to)}`));
});

test("sender parsing accepts a single named mailbox and rejects header injection and multiple senders", () => {
  assert.equal(marketingSender("bob@yapern.com"), "bob@yapern.com");
  assert.deepEqual(marketingSender('"Smith, Bob" <bob@yapern.com>'), { email: "bob@yapern.com", name: "Smith, Bob" });
  assert.deepEqual(marketingSender("José Smith <jose@yapern.com>"), { email: "jose@yapern.com", name: "José Smith" });
  for (const sender of ["", "bad", "Bob <bad>", "<bob@yapern.com>", "A <a@example.com>, B <b@example.com>",
    "a@example.com, b@example.com", "Bob <bob@example.com>\r\nBcc: other@example.com", '"Bob <bob@example.com>']) {
    assert.equal(marketingSender(sender), null, sender);
  }
});

test("invalid marketing bodies, unsupported fields and unsafe headers never send", async t => {
  const f = adminFixture(t);
  const invalid = [null, [], {}, { ...input, extra: true }, { ...input, to: [input.to] }, { ...input, to: "bad" },
    { ...input, subj: "" }, { ...input, subj: "   " }, { ...input, subj: "x".repeat(999) }, { ...input, subj: "Hi\r\nBcc: a@example.com" },
    { ...input, from: "Bob <bad>" }, { ...input, from: "Bob <bob@example.com>\n" }, { ...input, from: "x".repeat(513) },
    { ...input, message: "" }, { ...input, message: " \n\t " }, { ...input, message: 123 }, { ...input, message: "x".repeat(100_001) },
    ...[null, "false", "true", 0, 1, {}, []].map(fancy => ({ ...input, fancy }))];
  for (const body of ["{", "", ...invalid.map(value => JSON.stringify(value))]) {
    const response = await f.call(sendPath, { method: "POST", body });
    assert.equal(response.status, 400, body.slice(0, 100));
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  assert.equal(f.emails.length, 0);
});

test("body limits check actual streams even with absent or misleading Content-Length", async t => {
  const f = adminFixture(t);
  for (const [path, max] of [[sendPath, 1024 * 1024], [unsubscribePath, 4096]] as const) {
    for (const options of [
      { body: "{}", headers: { "content-length": String(max + 1) } },
      { body: " ".repeat(max + 1) },
      { body: " ".repeat(max + 1), headers: { "content-length": "2" } },
    ]) {
      const response = await f.call(path, { method: "POST", ...options });
      assert.equal(response.status, 413);
      assert.deepEqual(await response.json(), { error: "request_too_large" });
    }
  }
  assert.equal(f.emails.length, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM marketing_email_unsubscribes").get()!.count, 0);
  // Valid messages larger than the older API-wide 16 KiB limit remain supported.
  assert.equal((await f.call(sendPath, { method: "POST", body: JSON.stringify({ ...input, message: "x".repeat(100_000) }) })).status, 202);
});

test("send waits for binding acceptance and returns its message ID", async t => {
  const f = adminFixture(t);
  let accept!: (result: EmailSendResult) => void;
  let started!: () => void;
  const sending = new Promise<void>(resolve => { started = resolve; });
  f.env.MARKETING_EMAIL = { send() {
    started();
    return new Promise<EmailSendResult>(resolve => { accept = resolve; });
  } };
  let completed = false;
  const pending = f.call(sendPath, sendOptions).then(response => { completed = true; return response; });
  await sending;
  assert.equal(completed, false);
  accept({ messageId: "accepted-later" });
  const response = await pending;
  assert.equal(response.status, 202);
  assert.deepEqual(await response.json(), { ok: true, messageId: "accepted-later" });
});

test("binding failures and unavailable preferences never report acceptance or retry", async t => {
  const f = adminFixture(t);
  t.mock.method(console, "error", () => {});
  f.env.MARKETING_EMAIL = undefined as unknown as SendEmail;
  assert.deepEqual(await (await f.call(sendPath, sendOptions)).json(), { error: "email_sending_unavailable" });
  for (const code of ["E_DELIVERY_FAILED", "E_RECIPIENT_SUPPRESSED", "E_SENDER_NOT_VERIFIED", "E_RATE_LIMIT_EXCEEDED", "E_DAILY_LIMIT_EXCEEDED", undefined]) {
    let attempts = 0;
    f.env.MARKETING_EMAIL = { async send() { attempts++; throw Object.assign(new Error("Private provider details"), { code }); } };
    const response = await f.call(sendPath, sendOptions);
    const limited = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
    assert.equal(response.status, limited ? 429 : 502);
    assert.deepEqual(await response.json(), { error: limited ? "email_rate_limited" : "email_send_failed" });
    assert.equal(attempts, 1);
  }
  f.env.MARKETING_EMAIL = { async send() { return {} as EmailSendResult; } };
  assert.equal((await f.call(sendPath, sendOptions)).status, 502);
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  t.mock.method(f.env.DB, "prepare", (sql: string) => {
    if (sql.includes("AS unsubscribed")) throw new Error("Private preferences details");
    return prepare(sql);
  });
  const response = await f.call(sendPath, sendOptions);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "email_preferences_unavailable" });
  assert.equal(f.emails.length, 0);
});

test("public unsubscribe is normalized, permanent, idempotent and independent of the session", async t => {
  const f = adminFixture(t);
  for (const token of [null, "unknown", f.adminToken]) {
    const response = await f.call(unsubscribePath, { method: "POST", token, body: JSON.stringify({ email: " Member@Example.com " }) });
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
  }
  assert.equal(f.sqlite.prepare("SELECT marketing_email_unsubscribed FROM users WHERE id = 'member'").get()!.marketing_email_unsubscribed, 1);
  assert.equal(f.sqlite.prepare("SELECT marketing_email_unsubscribed FROM users WHERE id = 'admin'").get()!.marketing_email_unsubscribed, 0);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM marketing_email_unsubscribes WHERE email = 'member@example.com'").get()!.count, 1);
  const response = await f.call(sendPath, { method: "POST", body: JSON.stringify({ ...input, to: "MEMBER@example.com" }) });
  assert.equal(response.status, 409);
  assert.deepEqual(await response.json(), { error: "recipient_unsubscribed" });
  assert.equal(f.emails.length, 0);
  assert.equal((await f.call(sendPath, sendOptions)).status, 202);
});

test("address opt-outs survive later account creation, and flag-only opt-outs block sends", async t => {
  const f = adminFixture(t);
  const unsubscribe = await f.call(unsubscribePath, { method: "POST", token: null, origin: null, body: JSON.stringify({ email: "Foo@Bar.com" }) });
  assert.equal(unsubscribe.status, 200);
  assert.equal((await f.call(sendPath, sendOptions)).status, 409);
  f.sqlite.prepare("INSERT INTO users(id, email) VALUES ('later', 'foo@bar.com')").run();
  assert.equal((await f.call(sendPath, sendOptions)).status, 409);
  f.sqlite.prepare("UPDATE users SET marketing_email_unsubscribed = 1 WHERE id = 'member'").run();
  await assert.rejects(sendMarketingEmail(f.env, { ...input, to: "Member@example.com" }), /recipient_unsubscribed/);
  assert.equal(f.emails.length, 0);
});

test("invalid public unsubscribe requests do not change preferences", async t => {
  const f = adminFixture(t);
  for (const body of ["{", "[]", "null", "{}", ...[null, "", "bad", [input.to]].map(email => JSON.stringify({ email })), JSON.stringify({ email: input.to, extra: true })]) {
    assert.equal((await f.call(unsubscribePath, { method: "POST", token: null, body })).status, 400);
  }
  assert.equal((await f.call(unsubscribePath, { method: "POST", token: null, origin: "https://example.com", body: JSON.stringify({ email: input.to }) })).status, 403);
  for (const method of ["GET", "HEAD", "PUT", "DELETE"]) {
    assert.equal((await f.call(unsubscribePath, { method })).status, 405);
  }
  assert.equal((await f.call(unsubscribePath, { method: "OPTIONS", token: null })).status, 204);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM marketing_email_unsubscribes").get()!.count, 0);
});

test("unsubscribe failure rolls back address and account preferences and returns a safe error", async t => {
  const f = adminFixture(t);
  t.mock.method(console, "error", () => {});
  f.sqlite.exec("CREATE TRIGGER fail_preferences BEFORE UPDATE OF marketing_email_unsubscribed ON users BEGIN SELECT RAISE(ABORT, 'Private database details'); END");
  const response = await f.call(unsubscribePath, { method: "POST", body: JSON.stringify({ email: "member@example.com" }) });
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "email_preferences_unavailable" });
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM marketing_email_unsubscribes").get()!.count, 0);
  assert.equal(f.sqlite.prepare("SELECT sum(marketing_email_unsubscribed) AS count FROM users").get()!.count, 0);
});

test("email unsubscribe links lead to a working form that scanners cannot submit by reading", async t => {
  const f = adminFixture(t);
  const email = "Member+news@example.com";
  const url = new URL(marketingUnsubscribeUrl(email));
  const response = await f.call(`${url.pathname}${url.search}`, { token: null, origin: null });
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type")!, /text\/html/);
  assert.equal(response.headers.get("referrer-policy"), "strict-origin");
  const html = await response.text();
  assert.match(html, /<form action="\/unsubscribe" method="post">/);
  assert.ok(html.includes(`value="${email}"`));
  assert.doesNotMatch(html, /<script/);
  assert.equal(f.sqlite.prepare("SELECT count(*) AS count FROM marketing_email_unsubscribes").get()!.count, 0);
  const submitted = await f.call("/unsubscribe", {
    token: null, origin: "https://api.yapern.com", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email }).toString(),
  });
  assert.equal(submitted.status, 200);
  assert.match(await submitted.text(), /You have unsubscribed/);
  assert.equal(f.sqlite.prepare("SELECT email FROM marketing_email_unsubscribes").get()!.email, email.toLowerCase());
  assert.equal((await f.call(sendPath, { method: "POST", body: JSON.stringify({ ...input, to: email }) })).status, 409);
  // The same-origin form also works when Wrangler serves it locally.
  const local = await handleRequest(new Request("http://localhost:8787/unsubscribe", {
    method: "POST", headers: { origin: "http://localhost:8787", "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ email: "local@example.com" }),
  }), f.env);
  assert.equal(local.status, 200);
});

test("unsubscribe form escapes query input and preserves the address when saving fails", async t => {
  const f = adminFixture(t);
  t.mock.method(console, "error", () => {});
  const injected = '\"><script>alert(1)</script>';
  const response = await f.call(`/unsubscribe?${new URLSearchParams({ email: injected })}`, { token: null });
  const html = await response.text();
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&quot;&gt;&lt;script&gt;/);
  const invalid = await f.call("/unsubscribe", {
    token: null, origin: "https://api.yapern.com", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: "a@b" }).toString(),
  });
  assert.equal(invalid.status, 400);
  const invalidHtml = await invalid.text();
  assert.match(invalidHtml, /Enter a valid email address/);
  assert.ok(invalidHtml.includes('value="a@b"'));
  t.mock.method(f.env.DB, "batch", async () => { throw new Error("Private database details"); });
  const failure = await f.call("/unsubscribe", {
    token: null, origin: "https://api.yapern.com", method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ email: input.to }).toString(),
  });
  assert.equal(failure.status, 503);
  const errorHtml = await failure.text();
  assert.ok(errorHtml.includes(`value="${input.to}"`));
  assert.match(errorHtml, /Please try again/);
  assert.doesNotMatch(errorHtml, /Private database details/);
});
