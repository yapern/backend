import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../testing/database";
import { handleRequest } from "./router";

type Result = { type: string; id: string; snippet: string; author_name?: string; board_slug?: string };
type Payload = { data: Result[]; meta: { has_more: boolean; limit: number; offset: number } };

function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(database.close);
  database.sqlite.exec(`INSERT INTO users(id,email,name) VALUES('author','author@example.test','Taylor');
    INSERT INTO boards(id,slug,name,description) VALUES('other','other','Other','Another board');`);
  const message = (id: string, title: string, body = "A guide to useful database structures.", board = "general", date = "2026-10-20T00:00:00.000Z") =>
    database.sqlite.prepare("INSERT INTO messages(id,board_id,user_id,title,body,created_at) VALUES(?,?,'author',?,?,?)")
      .run(id, board, title, body, date);
  const request = (query: string, init?: RequestInit) => handleRequest(
    new Request(`https://api.yapern.com/search?${query}`, init), { DB: database.db } as Env,
  );
  const search = async (query: Record<string, string>) => {
    const response = await request(new URLSearchParams(query).toString());
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Payload>;
  };
  return { ...database, message, request, search };
}

test("search ranks titles above bodies and returns joined, current public metadata", async t => {
  const f = fixture(t);
  f.message("title", "SQLite indexes");
  f.message("body", "Database notes", "SQLite indexes for useful database structures.");
  f.message("unrelated", "Gardening notes", "Growing herbs.");
  f.sqlite.prepare("UPDATE users SET name='New name' WHERE id='author'").run();
  const result = await f.search({ q: "SQLite indexes" });
  assert.deepEqual(result.data.map(row => row.id), ["title", "body"]);
  assert.equal(result.data[0].author_name, "New name");
  assert.equal(result.data[0].board_slug, "general");
  assert.equal(result.data[0].type, "message");
  assert.equal(result.data[1].snippet.includes("SQLite indexes"), true);
  assert.equal("email" in result.data[0], false);
  assert.deepEqual(result.meta, { has_more: false, limit: 20, offset: 0 });
});

test("search matches Unicode, diacritics, all words, and the final word's prefix", async t => {
  const f = fixture(t);
  f.message("match", "Café SQLite indexes", "Unicode works: 日本語.");
  f.message("partial", "SQLite alone");
  assert.deepEqual((await f.search({ q: "cafe sqlite ind" })).data.map(row => row.id), ["match"]);
  assert.deepEqual((await f.search({ q: "日本語" })).data.map(row => row.id), ["match"]);
  assert.equal((await f.search({ q: "absent sqlite" })).data.length, 0);
});

test("board scope is applied before pagination and newest sorting is deterministic", async t => {
  const f = fixture(t);
  f.message("a", "SQLite", "Old", "general", "2026-10-18T00:00:00.000Z");
  f.message("b", "SQLite", "New", "general");
  f.message("c", "SQLite", "Same time", "general");
  f.message("outside", "SQLite", "Different board", "other", "2026-10-21T00:00:00.000Z");
  const options = { q: "sqlite", board: "general", sort: "newest", limit: "2" };
  const first = await f.search(options);
  assert.deepEqual(first.data.map(row => row.id), ["b", "c"]);
  assert.equal(first.meta.has_more, true);
  const second = await f.search({ ...options, offset: "2" });
  assert.deepEqual(second.data.map(row => row.id), ["a"]);
  assert.equal(second.meta.has_more, false);
  assert.equal((await f.search({ q: "sqlite", board: "missing" })).data.length, 0);
  assert.equal((await f.search({ ...options, offset: "1000" })).meta.has_more, false);
});

test("sub-yaps search names, slugs, and descriptions independently of messages", async t => {
  const f = fixture(t);
  f.sqlite.exec(`INSERT INTO boards(id,slug,name,description) VALUES
    ('name','building','SQLite','A discussion board'),
    ('description','notes','Notes','SQLite discussion board');`);
  f.message("post", "SQLite");
  assert.deepEqual((await f.search({ q: "sqlite", type: "boards" })).data.map(row => row.id), ["name", "description"]);
  assert.deepEqual((await f.search({ q: "build", type: "boards" })).data.map(row => row.id), ["name"]);
  assert.equal((await f.search({ q: "sqlite", type: "boards", board: "notes" })).data[0].type, "board");
});

test("insert, edit, deletion, and transaction rollback keep both indexes consistent", async t => {
  const f = fixture(t);
  f.message("post", "Originalword");
  assert.equal((await f.search({ q: "originalword" })).data.length, 1);
  f.sqlite.exec("UPDATE messages SET title='Replacementword' WHERE id='post'");
  assert.equal((await f.search({ q: "originalword" })).data.length, 0);
  assert.equal((await f.search({ q: "replacementword" })).data.length, 1);
  f.sqlite.exec(`INSERT INTO replies(message_id,user_id,body) VALUES('post','author','Replyword');
    DELETE FROM messages WHERE id='post';
    BEGIN; INSERT INTO messages(board_id,user_id,title,body) VALUES('general','author','Rollbackword','Body'); ROLLBACK;
    UPDATE boards SET description='Changedword' WHERE id='other';`);
  assert.equal((await f.search({ q: "replacementword" })).data.length, 0);
  assert.equal((await f.search({ q: "rollbackword" })).data.length, 0);
  assert.equal((await f.search({ q: "replyword" })).data.length, 0);
  assert.equal((await f.search({ q: "changedword", type: "boards" })).data.length, 1);
  f.sqlite.exec("DELETE FROM boards WHERE id='other'");
  assert.equal((await f.search({ q: "changedword", type: "boards" })).data.length, 0);
  f.sqlite.exec("INSERT INTO messages_fts(messages_fts,rank) VALUES('integrity-check',1)");
  f.sqlite.exec("INSERT INTO boards_fts(boards_fts,rank) VALUES('integrity-check',1)");
});

test("migration backfills existing content", t => {
  const sqlite = new DatabaseSync(":memory:");
  t.after(() => sqlite.close());
  const migrations = new URL("../../migrations/", import.meta.url);
  for (const file of readdirSync(migrations).filter(name => name.endsWith(".sql") && !name.startsWith("011_")).sort()) {
    sqlite.exec(readFileSync(new URL(file, migrations), "utf8"));
  }
  sqlite.exec(`INSERT INTO users(id,email) VALUES('old','old@example.test');
    INSERT INTO messages(id,board_id,user_id,title,body) VALUES('old-post','general','old','Backfillword','Existing body');`);
  sqlite.exec(readFileSync(new URL("011_full_text_search.sql", migrations), "utf8"));
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM messages_fts WHERE messages_fts MATCH 'Backfillword'").get()?.n, 1);
  assert.equal(sqlite.prepare("SELECT count(*) AS n FROM boards_fts WHERE boards_fts MATCH 'general'").get()?.n, 1);
});

test("literal punctuation and FTS/SQL syntax never become executable queries", async t => {
  const f = fixture(t);
  f.message("post", "SQLite", "<script>alert('x')</script> SQLite notes");
  for (const q of ["***", '"', "(){}:-", "sqlite OR absent", "sqlite NEAR absent", "' OR 1=1 --", 'title:absent NOT "sqlite"']) {
    assert.equal((await f.search({ q })).data.length, 0, q);
  }
  assert.equal((await f.search({ q: "sqlite!!!" })).data.length, 1);
  assert.equal((await f.search({ q: "sqlite" })).data[0].snippet.includes("<script>"), true);
});

test("validates queries and applies the same browser-origin rules as collections", async t => {
  const f = fixture(t);
  for (const query of ["", "q=", "q=%20", `q=${"a".repeat(201)}`, "q=x&q=y", "q=x&type=users", "q=x&sort=random",
    "q=x&limit=51", "q=x&limit=0", "q=x&offset=1001", "q=x&offset=-1", "q=x&board=../other", "q=x&unknown=y",
    new URLSearchParams({ q: Array(21).fill("word").join(" ") }).toString()]) {
    assert.equal((await f.request(query)).status, 400, query);
  }
  const allowed = await f.request("q=sqlite", { headers: { origin: "https://yapern.com" } });
  assert.equal(allowed.headers.get("access-control-allow-origin"), "https://yapern.com");
  assert.equal(allowed.headers.get("cache-control"), "no-store");
  assert.equal((await f.request("q=sqlite", { headers: { origin: "https://other.test" } })).status, 403);
  const preflight = await f.request("q=sqlite", { method: "OPTIONS", headers: {
    origin: "https://yapern.com", "access-control-request-method": "GET",
  } });
  assert.equal(preflight.status, 204);
});
