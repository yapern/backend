import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTestDatabase } from "../testing/database";
import { handleRequest } from "./router";

test("reply counts backfill historical messages and replies without changing them", () => {
  const sqlite = new DatabaseSync(":memory:");
  try {
    sqlite.exec("PRAGMA foreign_keys=ON");
    const path = resolve(import.meta.dirname, "../../migrations");
    const files = readdirSync(path).filter(file => /^\d+.*\.sql$/.test(file)).sort();
    for (const file of files.filter(file => file < "013")) sqlite.exec(readFileSync(resolve(path, file), "utf8"));
    sqlite.exec(`INSERT INTO users(id,name) VALUES('author','Author');
      INSERT INTO messages(id,board_id,user_id,title,body) VALUES
        ('empty','general','author','Empty','Body'),
        ('active','general','author','Active','Body');
      INSERT INTO replies(id,message_id,user_id,body) VALUES
        ('first','active','author','First reply'), ('second','active','author','Second reply');`);
    const before = sqlite.prepare("SELECT * FROM replies ORDER BY id").all();
    sqlite.exec(readFileSync(resolve(path, "013_reply_counts.sql"), "utf8"));
    assert.deepEqual(sqlite.prepare("SELECT id,reply_count FROM messages ORDER BY id").all().map(row => ({ ...row })), [
      { id: "active", reply_count: 2 }, { id: "empty", reply_count: 0 },
    ]);
    assert.deepEqual(sqlite.prepare("SELECT * FROM replies ORDER BY id").all(), before);
    sqlite.exec("DELETE FROM replies WHERE id='first'");
    assert.equal(sqlite.prepare("SELECT reply_count FROM messages WHERE id='active'").get()?.reply_count, 1);
  } finally {
    sqlite.close();
  }
});

test("reply counters track bulk writes, reassignment, deletion and rollback atomically", t => {
  const database = createTestDatabase();
  t.after(() => database.close());
  const { sqlite } = database;
  sqlite.exec(`INSERT INTO users(id,name) VALUES('author','Author');
    INSERT INTO messages(id,board_id,user_id,title,body) VALUES
      ('first','general','author','First','Body'), ('second','general','author','Second','Body');`);
  const counts = () => sqlite.prepare("SELECT reply_count FROM messages ORDER BY id").all().map(row => row.reply_count);
  assert.deepEqual(counts(), [0, 0]);
  sqlite.exec(`INSERT INTO replies(id,message_id,user_id,body) VALUES
    ('a','first','author','A'), ('b','first','author','B'), ('c','second','author','C');`);
  assert.deepEqual(counts(), [2, 1]);
  sqlite.exec("UPDATE replies SET body='Edited' WHERE id='a'");
  sqlite.exec("UPDATE replies SET message_id=message_id WHERE id='a'");
  assert.deepEqual(counts(), [2, 1]);
  sqlite.exec("UPDATE replies SET message_id='second' WHERE id='a'");
  assert.deepEqual(counts(), [1, 2]);
  sqlite.exec(`BEGIN;
    INSERT INTO replies(id,message_id,user_id,body) VALUES('rolled-back','first','author','Temporary');
    DELETE FROM replies WHERE id='a';
    ROLLBACK;`);
  assert.deepEqual(counts(), [1, 2]);
  assert.throws(() => sqlite.exec(`INSERT INTO replies(id,message_id,user_id,body) VALUES
    ('valid','first','author','Valid'), ('invalid','missing','author','Invalid');`));
  assert.deepEqual(counts(), [1, 2], "a failed statement rolls back earlier rows and their increments");
  sqlite.exec("DELETE FROM replies WHERE message_id='second'");
  assert.deepEqual(counts(), [1, 0]);
  sqlite.exec("DELETE FROM messages WHERE id='first'");
  assert.deepEqual(counts(), [0], "parent deletion and its cascaded replies leave other counters intact");
  assert.equal(sqlite.prepare("SELECT COUNT(*) AS n FROM replies").get()?.n, 0);
});

test("public message totals are read from messages without querying replies", async t => {
  const database = createTestDatabase();
  t.after(() => database.close());
  database.sqlite.exec(`INSERT INTO users(id,name) VALUES('author','Author');
    INSERT INTO messages(id,board_id,user_id,title,body) VALUES('post','general','author','Title','Body');
    INSERT INTO replies(message_id,user_id,body) VALUES('post','author','Reply');`);
  const queries: string[] = [];
  const db = {
    prepare(query: string) {
      queries.push(query);
      return database.db.prepare(query);
    },
  } as D1Database;
  const response = await handleRequest(new Request("https://api.yapern.com/tables/messages?select=id,reply_count&id=eq.post"), { DB: db } as Env);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { data: [{ id: "post", reply_count: 1 }] });
  assert.equal(queries.length, 1);
  assert.doesNotMatch(queries[0], /\breplies\b|\bcount\s*\(|\bjoin\b/i);
});
