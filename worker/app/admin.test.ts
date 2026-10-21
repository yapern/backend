import test from "node:test";
import assert from "node:assert/strict";
import { adminFixture } from "../testing/admin";

type Row = Record<string, unknown>;
type UserPage = { users: Row[]; total: number; offset: number; limit: number };
type TablePage = { items: Row[]; total: number; offset: number; limit: number };
const paths = ["/admin/users", "/admin/users/member", "/admin/tables", "/admin/tables/users", "/api/get-marketing-users"];

test("every admin read requires the current allowlisted bearer session and a trusted origin", async t => {
  const f = adminFixture(t);
  for (const path of paths) {
    assert.equal((await f.call(path, { token: null })).status, 401, path);
    assert.equal((await f.call(path, { token: "bff_us_" + "c".repeat(64) })).status, 401, path);
    assert.equal((await f.call(path, { token: f.memberToken })).status, 403, path);
    assert.equal((await f.call(path, { origin: "https://example.com" })).status, 403, path);
    const response = await f.call(path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.equal(response.headers.get("access-control-allow-origin"), "https://yapern.com");
    const preflight = await f.call(path, { method: "OPTIONS", token: null });
    assert.equal(preflight.status, 204);
    assert.match(preflight.headers.get("access-control-allow-headers")!, /Authorization/i);
    assert.equal((await f.call(path, { method: "OPTIONS", origin: "https://example.com" })).status, 403);
    for (const method of ["POST", "PATCH", "DELETE", "HEAD"]) {
      const unsupported = await f.call(path, { method });
      assert.equal(unsupported.status, 405, `${method} ${path}`);
      assert.equal(unsupported.headers.get("allow"), "GET, OPTIONS");
    }
  }
  f.sqlite.prepare("UPDATE users SET email = 'former@example.com' WHERE id = 'admin'").run();
  assert.equal((await f.call("/admin/users")).status, 403);
  f.sqlite.prepare("UPDATE users SET email = 'oneone@gmail.com' WHERE id = 'admin'").run();
  f.sqlite.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'").run();
  for (const path of paths) assert.equal((await f.call(path)).status, 401);
});

test("admin origins honor the configured allowlist", async t => {
  const f = adminFixture(t);
  f.env.YAPERN_ORIGINS = "https://admin.example.com";
  assert.equal((await f.call("/admin/users")).status, 403);
  const response = await f.call("/admin/users", { origin: "https://admin.example.com" });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://admin.example.com");
});

test("admin user lists and details expose only safe profile fields", async t => {
  const f = adminFixture(t);
  f.sqlite.prepare("INSERT INTO email_credentials(user_id, password_salt, password_hash) VALUES ('member', 'private-salt', 'private-hash')").run();
  const { users } = await (await f.call("/admin/users")).json() as { users: Row[] };
  assert.deepEqual(users.map(user => user.id), ["member", "admin"]);
  for (const user of users) {
    assert.deepEqual(Object.keys(user).sort(), ["created_at", "dob", "email", "id", "marketing_email_unsubscribed", "name"]);
    assert.equal(user.dob, null);
  }
  const detail = await (await f.call("/admin/users/member")).json();
  assert.deepEqual(detail, { user: users[0] });
  assert.equal((await f.call("/admin/users/missing")).status, 404);
  for (const id of ["%ZZ", "x".repeat(201), "member%27%20OR%201%3D1"]) {
    const response = await f.call(`/admin/users/${id}`);
    assert.equal(response.status, id.includes("OR") ? 404 : 400);
  }
});

test("admin tables allow only discussion and profile columns, with literal search and stable pages", async t => {
  const f = adminFixture(t);
  const catalog = await (await f.call("/admin/tables")).json() as { tables: { id: string; columns: string[] }[] };
  assert.deepEqual(catalog.tables.map(table => table.id), ["users", "boards", "messages", "replies"]);
  assert.doesNotMatch(JSON.stringify(catalog), /password|token|google_sub/);
  for (const table of catalog.tables) assert.equal((await f.call(`/admin/tables/${table.id}`)).status, 200);
  for (const table of ["sessions", "email-credentials", "auth-rate-limits", "users%27", "herds"]) {
    assert.equal((await f.call(`/admin/tables/${table}`)).status, 404, table);
  }
  f.sqlite.prepare("UPDATE boards SET created_at = '2020-01-01T00:00:00.000Z'").run();
  for (let index = 0; index < 27; index++) {
    f.sqlite.prepare("INSERT INTO boards(id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')")
      .run(`board-${String(index).padStart(2, "0")}`, `board-${index}`, index === 0 ? "100%_\\literal" : `Board ${index}`);
  }
  const first = await (await f.call("/admin/tables/boards")).json() as TablePage;
  assert.equal(first.items.length, 25);
  assert.equal(first.total, 28);
  assert.equal(first.limit, 25);
  assert.equal(first.items[0].id, "board-26");
  const second = await (await f.call("/admin/tables/boards?offset=25")).json() as TablePage;
  assert.equal(second.items.length, 3);
  assert.equal(second.offset, 25);
  assert.equal(new Set([...first.items, ...second.items].map(item => item.id)).size, 28);
  for (const q of ["%", "_", "\\", "100%_\\literal"]) {
    const search = await (await f.call(`/admin/tables/boards?${new URLSearchParams({ q })}`)).json() as TablePage;
    assert.equal(search.total, 1, q);
    assert.equal(search.items[0].id, "board-00");
  }
  const injection = await (await f.call("/admin/tables/boards?q=%27%20OR%201%3D1--")).json() as TablePage;
  assert.equal(injection.total, 0);
  assert.equal((await (await f.call("/admin/tables/boards?offset=1000000")).json() as TablePage).items.length, 0);
  for (const query of ["offset=-1", "offset=1e2", "offset=1.1", "offset=1000001", "offset=", "offset=0&offset=1", `q=${"x".repeat(101)}`, "q=a&q=b", "other=x"]) {
    assert.equal((await f.call(`/admin/tables/boards?${query}`)).status, 400, query);
  }
});

test("marketing recipients honor normalized address and account opt-outs without exposing private fields", async t => {
  const f = adminFixture(t);
  f.sqlite.prepare("UPDATE users SET marketing_email_unsubscribed = 1 WHERE id = 'member'").run();
  f.sqlite.prepare("INSERT INTO marketing_email_unsubscribes(email) VALUES ('address@example.com'), ('later@example.com')").run();
  for (const [id, email, unsubscribed] of [
    ["eligible", "Eligible@Example.com", 0], ["flag-only", "flag@example.com", 1],
    ["shared-flag", " FLAG@example.com ", 0], ["address-only", " Address@Example.com ", 0],
    ["later-account", "LATER@example.com", 0], ["no-email", null, 0],
  ]) {
    f.sqlite.prepare("INSERT INTO users(id, email, marketing_email_unsubscribed, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')")
      .run(id, email, unsubscribed);
  }
  const first = await (await f.call("/api/get-marketing-users?limit=1")).json() as UserPage;
  assert.equal(first.total, 3);
  assert.equal(first.offset, 0);
  assert.equal(first.limit, 1);
  assert.deepEqual(first.users.map(user => user.id), ["no-email"]);
  const second = await (await f.call("/api/get-marketing-users?limit=1&offset=1")).json() as UserPage;
  assert.deepEqual(second.users.map(user => user.id), ["eligible"]);
  const all = await (await f.call("/api/get-marketing-users")).json() as UserPage;
  assert.deepEqual(all.users.map(user => user.id), ["no-email", "eligible", "admin"]);
  for (const user of all.users) assert.deepEqual(Object.keys(user).sort(), ["created_at", "email", "id", "name"]);
  const empty = await (await f.call("/api/get-marketing-users?offset=3")).json() as UserPage;
  assert.deepEqual(empty.users, []);
  assert.equal(empty.total, 3);
  for (const query of ["offset=", "offset=-1", "offset=1e2", "offset=1000001", "limit=0", "limit=101", "limit=1.5", "limit=", "limit=1&limit=2", "other=x"]) {
    assert.equal((await f.call(`/api/get-marketing-users?${query}`)).status, 400, query);
  }
});

test("admin read and authentication failures return safe unavailable errors", async t => {
  const f = adminFixture(t);
  t.mock.method(console, "error", () => {});
  const prepare = f.env.DB.prepare.bind(f.env.DB);
  t.mock.method(f.env.DB, "prepare", (sql: string) => {
    if (sql.includes("FROM sessions")) return prepare(sql);
    throw new Error("Private database details");
  });
  for (const path of ["/admin/users", "/admin/users/member", "/admin/tables/users", "/api/get-marketing-users"]) {
    const response = await f.call(path);
    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), { error: "admin_unavailable" });
  }
  f.env.DB = { prepare() { throw new Error("Private authentication details"); } } as unknown as D1Database;
  const response = await f.call("/admin/users");
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "admin_unavailable" });
});
