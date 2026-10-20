import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { handleRequest } from "./router";
import { createTestDatabase } from "../testing/database";

const base = "https://api.yapern.com/auth";

interface AuthResponse {
  token: string;
  session: { id: string; user_id: string; expires_at: string; created_at: string };
  user: { id: string; email: string };
  created: boolean;
}

function fixture(t: { after: (callback: () => void) => void }) {
  const store = createTestDatabase();
  t.after(() => store.close());
  const env = { DB: store.db } as Env;
  const request = (path: string, method = "GET", token?: string, body?: unknown) =>
    handleRequest(new Request(`${base}/${path}`, {
      method,
      headers: {
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...(body ? { "content-type": "application/json" } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }), env);
  const email = (address: string, password: string) =>
    request("email", "POST", undefined, { email: address, password });
  return { ...store, request, email };
}

test("signup normalizes email, preserves password bytes, and stores only salted hashes", async t => {
  const f = fixture(t);
  const response = await f.email("  Person@Example.COM  ", " Exact password ");
  assert.equal(response.status, 201);
  const created = await response.json() as AuthResponse;
  assert.match(created.token, /^bff_us_[a-f0-9]{64}$/);
  assert.equal(created.created, true);
  assert.equal(created.user.email, "person@example.com");
  assert.equal(created.user.id, created.session.user_id);
  assert.ok(Date.parse(created.session.expires_at) > Date.now() + 29 * 24 * 60 * 60_000);
  const credential = f.sqlite.prepare("SELECT password_salt, password_hash FROM email_credentials WHERE user_id = ?")
    .get(created.user.id) as { password_salt: string; password_hash: string };
  assert.match(credential.password_salt, /^[a-f0-9]{32}$/);
  assert.match(credential.password_hash, /^[a-f0-9]{128}$/);
  assert.ok(!JSON.stringify(credential).includes(" Exact password "));
  const session = f.sqlite.prepare("SELECT token_hash FROM sessions WHERE user_id = ?")
    .get(created.user.id) as { token_hash: string };
  assert.equal(session.token_hash, createHash("sha256").update(created.token).digest("hex"));
  assert.ok(!session.token_hash.includes(created.token));
  assert.ok(!JSON.stringify(created).includes("password_hash"));
});

test("login checks the exact password and cannot claim a legacy email user", async t => {
  const f = fixture(t);
  const first = await (await f.email("person@example.com", " Valid pass ")).json() as AuthResponse;
  assert.equal((await f.email("person@example.com", "Valid pass")).status, 401);
  const login = await f.email("PERSON@example.com", " Valid pass ");
  assert.equal(login.status, 200);
  const again = await login.json() as AuthResponse;
  assert.equal(again.created, false);
  assert.equal(again.user.id, first.user.id);
  assert.notEqual(again.token, first.token);

  f.sqlite.prepare("INSERT INTO users(id,email) VALUES (?,?)").run("legacy", "Legacy@Example.com");
  const takeover = await f.email("legacy@example.com", "attacker password");
  assert.equal(takeover.status, 401);
  assert.deepEqual(await takeover.json(), { error: "invalid_credentials" });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM email_credentials WHERE user_id = 'legacy'")
    .get()?.count, 0);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE lower(email) = 'legacy@example.com'")
    .get()?.count, 1);
});

test("session check rejects expiry and spoofed identity; revoke is exact and idempotent", async t => {
  const f = fixture(t);
  const first = await (await f.email("one@example.com", "password one")).json() as AuthResponse;
  const second = await (await f.email("two@example.com", "password two")).json() as AuthResponse;
  const check = await f.request("session", "GET", first.token);
  assert.equal(check.status, 200);
  assert.deepEqual(await check.json(), { session: first.session, user: first.user });
  assert.equal((await f.request("session", "GET", "bff_us_" + "a".repeat(64))).status, 401);

  assert.deepEqual(await (await f.request("session", "DELETE", first.token)).json(), { revoked: true });
  assert.deepEqual(await (await f.request("session", "DELETE", first.token)).json(), { revoked: true });
  assert.equal((await f.request("session", "GET", first.token)).status, 401);
  assert.equal((await f.request("session", "GET", second.token)).status, 200);

  f.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE token_hash = ?")
    .run(second.session.id);
  assert.equal((await f.request("session", "GET", second.token)).status, 401);
  assert.deepEqual(await (await f.request("session", "DELETE", second.token)).json(), { revoked: true });
});

test("invalid bodies and weak new passwords receive stable errors", async t => {
  const f = fixture(t);
  for (const body of [
    { email: "not-an-email", password: "password123" },
    { email: "person@example.com", password: "x".repeat(129) },
    { email: "person@example.com", password: "password123", user_id: "admin" },
  ]) {
    const response = await f.request("email", "POST", undefined, body);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
  const weak = await f.email("new@example.com", "short");
  assert.equal(weak.status, 400);
  assert.deepEqual(await weak.json(), { error: "weak_password" });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM users WHERE email = 'new@example.com'").get()?.count, 0);
});

test("accepts the 128-character password boundary", async t => {
  const f = fixture(t);
  const password = "p".repeat(128);
  assert.equal((await f.email("boundary@example.com", password)).status, 201);
  assert.equal((await f.email("boundary@example.com", password)).status, 200);
});

test("expired sessions are cleaned and the active-session cap is enforced", async t => {
  const f = fixture(t);
  const signup = await (await f.email("capped@example.com", "a sufficiently long password")).json() as AuthResponse;
  f.sqlite.prepare("DELETE FROM sessions WHERE user_id = ?").run(signup.user.id);
  f.sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)")
    .run("expired", signup.user.id, "2000-01-01T00:00:00.000Z", "2000-01-01T00:00:00.000Z");
  const insertActive = f.sqlite.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)");
  for (let index = 0; index < 50; index++) {
    insertActive.run(`active-${index}`, signup.user.id, "2999-01-01T00:00:00.000Z");
  }

  const response = await f.email("capped@example.com", "a sufficiently long password");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "session_limit" });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND expires_at > ?")
    .get(signup.user.id, new Date().toISOString())?.count, 50);
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM sessions WHERE user_id = ? AND expires_at <= ?")
    .get(signup.user.id, new Date().toISOString())?.count, 0);
});

test("rate counters persist and block repeated failed attempts", async t => {
  const f = fixture(t);
  await f.email("person@example.com", "correct password");
  for (let index = 0; index < 9; index++) {
    assert.equal((await f.email("person@example.com", "wrong password")).status, 401);
  }
  const limited = await f.email("person@example.com", "correct password");
  assert.equal(limited.status, 429);
  assert.deepEqual(await limited.json(), { error: "rate_limited" });
  assert.equal(f.sqlite.prepare("SELECT COUNT(*) AS count FROM auth_rate_limits").get()?.count, 1);
});
