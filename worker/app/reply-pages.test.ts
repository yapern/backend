import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createTestDatabase } from "../testing/database";
import { handleRequest } from "./router";

type Row = { id: string; parent_reply_id: string | null; direct_reply_count: number; author_name: string | null };
type Page = { data: Row[]; meta: { next_cursor: string | null } };
const timestamp = "2026-10-21T12:00:00.000Z";

function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  database.sqlite.exec(`INSERT INTO users(id,name) VALUES('author','Author');
    INSERT INTO messages(id,board_id,user_id,title,body) VALUES
      ('thread','general','author','Thread','Body'), ('other','general','author','Other','Body');`);
  const request = (path: string, init: RequestInit = {}) => handleRequest(
    new Request(`https://api.yapern.com${path}`, init), { DB: database.db } as Env,
  );
  const insert = (id: string, parent: string | null = null, message = "thread", createdAt = timestamp) => {
    database.sqlite.prepare("INSERT INTO replies(id,message_id,user_id,body,parent_reply_id,created_at) VALUES(?,?,'author','Reply',?,?)")
      .run(id, message, parent, createdAt);
  };
  const page = async (query = "", message = "thread"): Promise<Page> => {
    const response = await request(`/messages/${message}/replies${query ? `?${query}` : ""}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<Page>;
  };
  return { ...database, request, insert, page };
}

test("reply pages initially return 20 roots, exclude descendants and use the branch index", async t => {
  const f = fixture(t);
  for (let index = 0; index < 23; index++) f.insert(`root-${String(index).padStart(2, "0")}`);
  for (let index = 0; index < 10; index++) f.insert(`child-${index}`, "root-00");
  const newest = await f.page();
  assert.deepEqual(newest.data.slice(0, 3).map(row => row.id), ["root-22", "root-21", "root-20"]);
  const first = await f.page("sort=old");
  assert.equal(first.data.length, 20);
  assert.deepEqual(first.data.map(row => row.id), Array.from({ length: 20 }, (_, index) => `root-${String(index).padStart(2, "0")}`));
  assert.equal(first.data[0].direct_reply_count, 10);
  assert.ok(first.data.every(row => row.author_name === "Author"));
  assert.ok(first.data.every(row => row.parent_reply_id === null));
  assert.match(first.meta.next_cursor!, /^[A-Za-z0-9_-]+$/);
  const second = await f.page(`sort=old&cursor=${first.meta.next_cursor}`);
  assert.deepEqual(second.data.map(row => row.id), ["root-20", "root-21", "root-22"]);
  assert.equal(second.meta.next_cursor, null);
  assert.deepEqual(await f.page("", "other"), { data: [], meta: { next_cursor: null } });
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM replies
    WHERE message_id=? AND parent_reply_id IS ? ORDER BY created_at ASC,id ASC LIMIT ?`).all("thread", null, 21);
  assert.ok(plan.some(row => String(row.detail).includes("idx_replies_thread_parent_created")));
  assert.ok(plan.every(row => !/SCAN replies|TEMP B-TREE/.test(String(row.detail))));
});

test("each parent's immediate-child cursor is independent and cannot be reused across branches", async t => {
  const f = fixture(t);
  f.insert("a"); f.insert("b");
  for (const id of ["a-1", "a-2", "a-3"]) f.insert(id, "a");
  for (const id of ["b-1", "b-2", "b-3"]) f.insert(id, "b");
  f.insert("grandchild", "a-1");
  const branchA = await f.page("parent_reply_id=a&limit=2&sort=old");
  const branchB = await f.page("parent_reply_id=b&limit=2&sort=old");
  assert.deepEqual(branchA.data.map(row => row.id), ["a-1", "a-2"]);
  assert.deepEqual(branchB.data.map(row => row.id), ["b-1", "b-2"]);
  assert.equal(branchA.data[0].direct_reply_count, 1);
  assert.ok(branchA.meta.next_cursor);
  assert.ok(branchB.meta.next_cursor);
  assert.notEqual(branchA.meta.next_cursor, branchB.meta.next_cursor);
  assert.deepEqual((await f.page(`parent_reply_id=a&cursor=${branchA.meta.next_cursor}&limit=2&sort=old`)).data.map(row => row.id), ["a-3"]);
  assert.deepEqual((await f.page(`parent_reply_id=b&cursor=${branchB.meta.next_cursor}&limit=2&sort=old`)).data.map(row => row.id), ["b-3"]);
  for (const path of [
    `/messages/thread/replies?parent_reply_id=b&cursor=${branchA.meta.next_cursor}`,
    `/messages/thread/replies?cursor=${branchA.meta.next_cursor}`,
    `/messages/other/replies?cursor=${branchA.meta.next_cursor}`,
  ]) assert.equal((await f.request(path)).status, 400);
  assert.deepEqual((await f.page("parent_reply_id=a-1&limit=3")).data.map(row => row.id), ["grandchild"]);
});

test("keyset pages survive deletion of their bookmark and new rows without duplicating earlier siblings", async t => {
  const f = fixture(t);
  for (const id of ["r1", "r2", "r3"]) f.insert(id);
  const first = await f.page("limit=2&sort=old");
  assert.deepEqual(first.data.map(row => row.id), ["r1", "r2"]);
  f.sqlite.exec("DELETE FROM replies WHERE id='r2'");
  f.insert("r0"); f.insert("r4");
  f.insert("newer", null, "thread", "2026-10-22T12:00:00.000Z");
  const second = await f.page(`limit=2&cursor=${first.meta.next_cursor}&sort=old`);
  assert.deepEqual(second.data.map(row => row.id), ["r3", "r4"]);
  const third = await f.page(`limit=2&cursor=${second.meta.next_cursor}&sort=old`);
  assert.deepEqual(third.data.map(row => row.id), ["newer"]);
  assert.equal(third.meta.next_cursor, null);
});

test("branch pages reject invalid queries and mismatched parents without exposing other threads", async t => {
  const f = fixture(t);
  f.insert("parent"); f.insert("foreign", null, "other");
  for (const query of [
    "limit=0", "limit=101", "limit=-1", "limit=01", "limit=2&limit=3", "parent_reply_id=", "__proto__=ignored", "sort=best",
    "parent_reply_id=%20", "parent_reply_id=parent&parent_reply_id=parent", "offset=0", "select=id",
    "cursor=", "cursor=not-a-cursor", "cursor=e30", "cursor=WzFd", "cursor=bad%2Bformat", `cursor=${"a".repeat(8193)}`,
  ]) assert.equal((await f.request(`/messages/thread/replies?${query}`)).status, 400, query);
  for (const path of [
    "/messages/missing/replies", "/messages/thread/replies?parent_reply_id=missing",
    "/messages/thread/replies?parent_reply_id=foreign", "/messages/thread/replies?parent_reply_id=thread",
  ]) assert.equal((await f.request(path)).status, 404, path);
  assert.equal((await f.request("/messages/thread/replies", { headers: { origin: "https://evil.example" } })).status, 403);
  const publicRead = await f.request("/messages/thread/replies", { headers: { origin: "https://yapern.com" } });
  assert.equal(publicRead.status, 200);
  assert.equal(publicRead.headers.get("access-control-allow-origin"), "https://yapern.com");
  assert.equal(publicRead.headers.get("cache-control"), "no-store");
});

test("deep-link context returns only bounded nearest ancestry with no siblings or descendants", async t => {
  const f = fixture(t);
  for (let depth = 0; depth < 160; depth++) f.insert(`deep-${depth}`, depth ? `deep-${depth - 1}` : null);
  f.insert("sibling", "deep-157"); f.insert("descendant", "deep-159");
  const read = async (reply: string, query = "") => {
    const response = await f.request(`/messages/thread/replies/${reply}/context${query ? `?${query}` : ""}`);
    assert.equal(response.status, 200, await response.clone().text());
    return response.json() as Promise<{ data: Row[]; meta: { has_more: boolean } }>;
  };
  const context = await read("deep-159");
  assert.deepEqual(context.data.map(row => row.id), ["deep-154", "deep-155", "deep-156", "deep-157", "deep-158", "deep-159"]);
  assert.equal(context.data[0].parent_reply_id, "deep-153");
  assert.equal(context.meta.has_more, true);
  const targetOnly = await read("deep-159", "limit=1");
  assert.deepEqual(targetOnly.data.map(row => row.id), ["deep-159"]);
  assert.equal(targetOnly.meta.has_more, true);
  const nearRoot = await read("deep-2");
  assert.deepEqual(nearRoot.data.map(row => row.id), ["deep-0", "deep-1", "deep-2"]);
  assert.equal(nearRoot.meta.has_more, false);
  const max = await read("deep-159", "limit=100");
  assert.equal(max.data.length, 100);
  assert.equal(max.meta.has_more, true);
  assert.deepEqual((await read("deep-0")).data.map(row => row.id), ["deep-0"]);
});

test("deep-link context validates root membership, bounded limits and browser origins", async t => {
  const f = fixture(t);
  f.insert("parent"); f.insert("foreign", null, "other");
  for (const query of ["limit=0", "limit=101", "limit=2&limit=3", "cursor=unused", "parent_reply_id=parent"]) {
    assert.equal((await f.request(`/messages/thread/replies/parent/context?${query}`)).status, 400, query);
  }
  for (const path of [
    "/messages/thread/replies/missing/context", "/messages/thread/replies/foreign/context",
    "/messages/missing/replies/parent/context",
  ]) assert.equal((await f.request(path)).status, 404, path);
  assert.equal((await f.request("/messages/thread/replies/parent/context", { headers: { origin: "https://evil.example" } })).status, 403);
});

test("top reply pages use cached vote scores and sort-scoped keyset cursors", async t => {
  const f = fixture(t);
  for (const id of ["a", "b", "c"]) f.insert(id);
  f.insert("nested", "a");
  for (let index = 0; index < 4; index++) {
    const voter = `voter-${index}`;
    f.sqlite.prepare("INSERT INTO users(id,name) VALUES(?,?)").run(voter, voter);
    f.sqlite.prepare("INSERT INTO reply_votes(reply_id,user_id,value) VALUES('b',?,1)").run(voter);
    if (index < 2) f.sqlite.prepare("INSERT INTO reply_votes(reply_id,user_id,value) VALUES('a',?,1)").run(voter);
  }
  const score = (id: string) => f.sqlite.prepare("SELECT vote_score FROM replies WHERE id=?").get(id)?.vote_score;
  assert.equal(score("a"), 3); assert.equal(score("b"), 5); assert.equal(score("c"), 1);
  const first = await f.page("sort=top&limit=2");
  assert.deepEqual(first.data.map(row => row.id), ["b", "a"]);
  assert.ok(first.data.every(row => !("vote_score" in row)));
  assert.deepEqual((await f.page(`sort=top&limit=2&cursor=${first.meta.next_cursor}`)).data.map(row => row.id), ["c"]);
  assert.equal((await f.request(`/messages/thread/replies?sort=new&cursor=${first.meta.next_cursor}`)).status, 400);
  f.sqlite.exec("UPDATE reply_votes SET value=-1 WHERE reply_id='b' AND user_id='voter-0'");
  f.sqlite.exec("DELETE FROM reply_votes WHERE reply_id='b' AND user_id='voter-1'");
  assert.equal(score("b"), 2);
  assert.deepEqual((await f.page("sort=top&limit=3")).data.map(row => row.id), ["a", "b", "c"]);
  f.sqlite.exec("BEGIN; UPDATE reply_votes SET value=-1 WHERE reply_id='a'; ROLLBACK;");
  assert.equal(score("a"), 3);
  for (const row of f.sqlite.prepare("SELECT id,vote_score FROM replies").all()) {
    assert.equal(row.vote_score, f.sqlite.prepare("SELECT COALESCE(SUM(value),0) AS n FROM reply_votes WHERE reply_id=?").get(row.id)?.n);
  }
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT r.id,u.name FROM replies r LEFT JOIN users u ON u.id=r.user_id
    WHERE r.message_id=? AND r.parent_reply_id IS ? AND (r.vote_score,r.id)<(?,?)
    ORDER BY r.vote_score DESC,r.id DESC LIMIT ?`).all("thread", null, 5, "b", 21);
  assert.ok(plan.some(row => String(row.detail).includes("idx_replies_thread_parent_score")));
  assert.ok(plan.every(row => !/SCAN r\b|TEMP B-TREE/.test(String(row.detail))));
});

test("10,000 siblings page without descendants or aggregate scans, including far keyset positions", async t => {
  const f = fixture(t);
  f.insert("parent");
  f.sqlite.exec("BEGIN");
  for (let index = 0; index < 10_000; index++) f.insert(`child-${String(index).padStart(5, "0")}`, "parent");
  f.insert("grandchild", "child-09999");
  f.sqlite.exec("COMMIT");
  assert.equal(f.sqlite.prepare("SELECT direct_reply_count FROM replies WHERE id='parent'").get()?.direct_reply_count, 10_000);
  const first = await f.page("parent_reply_id=parent&limit=3");
  assert.deepEqual(first.data.map(row => row.id), ["child-09999", "child-09998", "child-09997"]);
  assert.ok(first.data.every(row => row.parent_reply_id === "parent"));
  const scopedCursor = Buffer.from(JSON.stringify([2, "thread", "parent", "new", timestamp, "child-00025"])).toString("base64url");
  const nearEnd = await f.page(`parent_reply_id=parent&limit=20&cursor=${scopedCursor}`);
  assert.equal(nearEnd.data.length, 20);
  assert.equal(nearEnd.data[0].id, "child-00024");
  assert.equal(nearEnd.data.at(-1)!.id, "child-00005");
  const last = await f.page(`parent_reply_id=parent&limit=20&cursor=${nearEnd.meta.next_cursor}`);
  assert.equal(last.data.length, 5);
  assert.equal(last.meta.next_cursor, null);
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT * FROM replies
    WHERE message_id=? AND parent_reply_id IS ? AND (created_at,id)<(?,?)
    ORDER BY created_at DESC,id DESC LIMIT ?`).all("thread", "parent", timestamp, "child-00025", 21);
  assert.ok(plan.some(row => /idx_replies_thread_parent_created.*created_at/.test(String(row.detail))));
  assert.ok(plan.every(row => !/SCAN replies|TEMP B-TREE/.test(String(row.detail))));
});

test("a 100,000-node branched thread still reads only 20 roots or 3 immediate children", async t => {
  const f = fixture(t);
  const insert = f.sqlite.prepare(`INSERT INTO replies(id,message_id,user_id,body,parent_reply_id,created_at)
    VALUES(?,'thread','author','Reply',?,?)`);
  f.sqlite.exec("BEGIN");
  for (let index = 0; index < 100; index++) insert.run(`root-${String(index).padStart(3, "0")}`, null, timestamp);
  for (let index = 0; index < 1000; index++) insert.run(`child-${String(index).padStart(4, "0")}`, `root-${String(index % 100).padStart(3, "0")}`, timestamp);
  for (let index = 0; index < 98_900; index++) insert.run(`leaf-${String(index).padStart(5, "0")}`, `child-${String(index % 1000).padStart(4, "0")}`, timestamp);
  f.sqlite.exec("COMMIT");
  assert.equal(f.sqlite.prepare("SELECT reply_count FROM messages WHERE id='thread'").get()?.reply_count, 100_000);
  const queries: Array<{ sql: string; values: unknown[] }> = [];
  const db = {
    prepare(sql: string) {
      return {
        bind(...values: unknown[]) {
          queries.push({ sql, values });
          return f.db.prepare(sql).bind(...values);
        },
      };
    },
  } as D1Database;
  const read = (query: string) => handleRequest(new Request(`https://api.yapern.com/messages/thread/replies?${query}`), { DB: db } as Env);
  const initial = await read("limit=20");
  assert.equal(initial.status, 200);
  const initialPage = await initial.json() as Page;
  assert.equal(initialPage.data.length, 20);
  assert.ok(initialPage.data.every(row => row.parent_reply_id === null));
  assert.equal(initialPage.data[0].direct_reply_count, 10);
  assert.equal(queries.length, 2);
  assert.equal(queries[1].values.at(-1), 21);
  const child = await read("parent_reply_id=root-099&limit=3");
  assert.equal(child.status, 200);
  const childPage = await child.json() as Page;
  assert.equal(childPage.data.length, 3);
  assert.ok(childPage.data.every(row => row.parent_reply_id === "root-099"));
  assert.equal(queries.length, 4);
  assert.equal(queries[3].values.at(-1), 4);
  assert.ok(queries.every(query => !/COUNT\s*\(|SUM\s*\(|WITH RECURSIVE/i.test(query.sql)));
  const plan = f.sqlite.prepare(`EXPLAIN QUERY PLAN SELECT r.id,u.name FROM replies r LEFT JOIN users u ON u.id=r.user_id
    WHERE r.message_id=? AND r.parent_reply_id IS ? ORDER BY r.created_at DESC,r.id DESC LIMIT ?`).all("thread", "root-099", 4);
  assert.ok(plan.some(row => String(row.detail).includes("idx_replies_thread_parent_created")));
  assert.ok(plan.every(row => !/SCAN r\b|TEMP B-TREE/.test(String(row.detail))));
});
