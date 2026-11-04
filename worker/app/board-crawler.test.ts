import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";
import { createTestDatabase } from "../testing/database";

type Row = { id: string; board_id: string; url: string; created_at: string };

async function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const request = (path: string, init: RequestInit = {}) =>
    handleRequest(new Request(`https://api.yapern.com${path}`, init), { DB: database.db } as Env);
  async function signIn(email: string) {
    const response = await request("/auth/email", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }),
    });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ token: string; user: { id: string } }>;
  }
  const owner = await signIn("crawler-owner@example.com");
  for (const id of ["crawler-board", "other-board"]) {
    database.sqlite.prepare("INSERT INTO boards(id,slug,name,user_id) VALUES(?,?,?,?)")
      .run(id, id, id, owner.user.id);
  }
  const path = "/boards/crawler-board/crawler-urls";
  const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json", origin: "https://yapern.com" };
  const add = (url: unknown) => request(path, { method: "POST", headers, body: JSON.stringify({ url }) });
  const list = () => request(path, { headers });
  return { database, request, signIn, path, headers, add, list, owner };
}

async function rows(response: Response, status = 200): Promise<Row[]> {
  assert.equal(response.status, status, await response.clone().text());
  return ((await response.json()) as { data: Row[] }).data;
}

test("crawler URLs save individually, normalize duplicates, retain insertion order, and delete only the selected URL", async t => {
  const api = await fixture(t);
  assert.deepEqual(await rows(await api.list()), []);
  const first = (await rows(await api.add(" HTTPS://Example.COM "), 201))[0];
  const second = (await rows(await api.add("https://example.com/news?q=one&next=two#latest"), 201))[0];
  assert.equal(first.url, "https://example.com/");
  assert.equal(first.board_id, "crawler-board");
  assert.equal((await api.add("https://example.com")).status, 409);
  assert.deepEqual(await rows(await api.list()), [first, second]);
  const otherPath = "/boards/other-board/crawler-urls";
  assert.equal((await api.request(otherPath, {
    method: "POST", headers: api.headers, body: JSON.stringify({ url: first.url }),
  })).status, 201, "the same URL can be used on another board");
  assert.equal((await api.request(`${otherPath}/${first.id}`, { method: "DELETE", headers: api.headers })).status, 404);
  assert.deepEqual(await rows(await api.request(`${api.path}/${first.id}`, { method: "DELETE", headers: api.headers })), [first]);
  assert.deepEqual(await rows(await api.list()), [second]);
  assert.equal((await api.request(`${api.path}/${first.id}`, { method: "DELETE", headers: api.headers })).status, 404);
  await rows(await api.request(`${api.path}/${second.id}`, { method: "DELETE", headers: api.headers }));
  assert.deepEqual(await rows(await api.list()), []);
});

test("crawler URL storage supports more than one page and preserves order for identical timestamps", async t => {
  const api = await fixture(t);
  const insert = api.database.sqlite.prepare("INSERT INTO board_crawler_urls(id,board_id,url,created_at) VALUES(?,'crawler-board',?,'2026-11-04T00:00:00.000Z')");
  const expected = Array.from({ length: 125 }, (_, index) => `https://example.com/${index}`);
  expected.forEach((url, index) => insert.run(`url-${125 - index}`, url));
  assert.deepEqual((await rows(await api.list())).map(row => row.url), expected);
  api.database.sqlite.prepare("DELETE FROM boards WHERE id='crawler-board'").run();
  assert.equal(api.database.sqlite.prepare("SELECT COUNT(*) AS count FROM board_crawler_urls").get()?.count, 0);
  assert.equal(api.database.sqlite.prepare("SELECT description FROM boards WHERE id='general'").get()?.description, "General discussion.");
});

test("crawler URLs reject invalid requests without changing the saved list", async t => {
  const api = await fixture(t);
  for (const value of [null, [], 42, "", "example.com", "javascript:alert(1)", "ftp://example.com", "https://person:secret@example.com", "https://example.com/\nhttps://other.com", `https://example.com/${"a".repeat(2048)}`]) {
    assert.equal((await api.add(value)).status, 400, String(value));
  }
  for (const body of [{ url: "https://example.com", board_id: "other-board" }, { urls: ["https://example.com"] }]) {
    assert.equal((await api.request(api.path, { method: "POST", headers: api.headers, body: JSON.stringify(body) })).status, 400);
  }
  assert.deepEqual(await rows(await api.list()), []);
});

test("crawler URLs require the board owner for every operation and support browser CORS", async t => {
  const api = await fixture(t);
  const saved = (await rows(await api.add("http://example.com/feed"), 201))[0];
  const other = await api.signIn("other-crawler@example.com");
  for (const [method, path, body] of [
    ["GET", api.path, undefined], ["POST", api.path, JSON.stringify({ url: "https://example.com/new" })],
    ["DELETE", `${api.path}/${saved.id}`, undefined],
  ]) {
    assert.equal((await api.request(path!, { method, headers: { "content-type": "application/json" }, body })).status, 401);
    assert.equal((await api.request(path!, { method, headers: { ...api.headers, authorization: `Bearer ${other.token}` }, body })).status, 403);
    assert.equal((await api.request(path!.replace("crawler-board", "missing"), { method, headers: api.headers, body })).status, 404);
    assert.equal((await api.request(path!, { method, headers: { ...api.headers, origin: "https://elsewhere.example" }, body })).status, 403);
  }
  const preflight = await api.request(api.path, {
    method: "OPTIONS", headers: { origin: "https://yapern.com", "access-control-request-method": "POST", "access-control-request-headers": "authorization,content-type" },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://yapern.com");
  const list = await api.list();
  assert.equal(list.headers.get("cache-control"), "no-store");
  assert.equal(list.headers.get("access-control-allow-origin"), "https://yapern.com");
  assert.deepEqual(await rows(list), [saved]);
});
