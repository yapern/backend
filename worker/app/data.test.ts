import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.com";
const apiKey = "bff_pk_1f9bb9fd543d6a5476ad7ce210577c2479d290a5cdc06282de9eb884d57005c4";

type UserSession = { token: string; user: { id: string; email: string } };
type Row = Record<string, unknown>;
type Payload = { data: Row[]; meta?: { changes: number }; error?: string; [key: string]: unknown };

async function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = { DB: database.db } as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(
    new Request(`${origin}${path}`, init), env,
  );
  const signIn = async (email: string): Promise<UserSession> => {
    const response = await request("/auth/email", {
      method: "POST",
      headers: { apikey: apiKey, "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    const result = await response.json() as UserSession;
    assert.match(result.token, /^bff_us_[0-9a-f]{64}$/);
    return result;
  };
  const authorized = (session: UserSession, headers: HeadersInit = {}) => ({
    apikey: apiKey,
    authorization: `Bearer ${session.token}`,
    ...headers,
  });
  const table = (name: string) => `/tables/${name}`;
  return { database, request, signIn, authorized, table };
}

async function json(response: Response): Promise<Payload> {
  assert.match(response.headers.get("content-type") ?? "", /application\/json/i);
  return response.json() as Promise<Payload>;
}

test("public table reads support the frontend's filters, columns, ordering, and pagination", async (t) => {
  const api = await fixture(t);
  const author = await api.signIn("author@example.com");
  const boardResponse = await api.request(api.table("boards"), {
    method: "POST",
    headers: api.authorized(author, { "content-type": "application/json" }),
    body: JSON.stringify({ slug: "test-room", name: "Test Room", description: "Readable room" }),
  });
  assert.equal(boardResponse.status, 201, await boardResponse.clone().text());
  const board = (await json(boardResponse)).data[0];
  assert.equal(board.user_id, author.user.id);

  const duplicateBoard = await api.request(api.table("boards"), {
    method: "POST",
    headers: api.authorized(author, { "content-type": "application/json" }),
    body: JSON.stringify({ slug: "test-room", name: "Duplicate", description: "" }),
  });
  assert.equal(duplicateBoard.status, 409);

  const post = async (title: string) => {
    const response = await api.request(api.table("messages"), {
      method: "POST",
      headers: api.authorized(author, { "content-type": "application/json" }),
      body: JSON.stringify({ board_id: board.id, title, body: `${title} body` }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    return (await json(response)).data[0];
  };
  const first = await post("First");
  assert.equal(first.reply_count, 0);
  await new Promise((resolve) => setTimeout(resolve, 3));
  const second = await post("Second");

  const messages = await api.request(
    `${api.table("messages")}?select=id,board_id,user_id,title,body,created_at&board_id=eq.${board.id}&order=created_at.desc&limit=1&offset=1`,
    { headers: { apikey: apiKey } },
  );
  assert.equal(messages.status, 200);
  const messageRows = (await json(messages)).data;
  assert.equal(messageRows.length, 1);
  assert.equal(messageRows[0].id, first.id);
  assert.deepEqual(Object.keys(messageRows[0]).sort(), ["board_id", "body", "created_at", "id", "title", "user_id"]);

  const boards = await api.request(`${api.table("boards")}?select=id,slug,name,description&slug=eq.test-room&limit=1`, {
  });
  assert.deepEqual((await json(boards)).data, [{
    id: board.id, slug: board.slug, name: board.name, description: board.description,
  }]);

  const replies: Row[] = [];
  for (const body of ["First reply", "Second reply"]) {
    if (replies.length) await new Promise((resolve) => setTimeout(resolve, 3));
    const response = await api.request(api.table("replies"), {
      method: "POST",
      headers: api.authorized(author, { "content-type": "application/json" }),
      body: JSON.stringify({ message_id: first.id, body }),
    });
    assert.equal(response.status, 201, await response.clone().text());
    replies.push((await json(response)).data[0]);
  }
  const replyList = await api.request(
    `${api.table("replies")}?select=id,message_id,user_id,body,created_at&message_id=eq.${first.id}&order=created_at.asc&limit=100&offset=0`,
    { headers: { apikey: apiKey } },
  );
  assert.equal(replyList.status, 200);
  assert.deepEqual((await json(replyList)).data.map((row) => row.body), replies.map((row) => row.body));
  const counts = await api.request(`${api.table("messages")}?select=id,reply_count&board_id=eq.${board.id}&order=id.asc`);
  assert.equal(counts.status, 200);
  assert.deepEqual((await json(counts)).data, [
    { id: first.id, reply_count: 2 }, { id: second.id, reply_count: 0 },
  ].sort((a, b) => String(a.id).localeCompare(String(b.id))));
  assert.notEqual(second.id, first.id);
});

test("message feeds rank live vote totals before pagination with stable ties and board filters", async t => {
  const api = await fixture(t);
  const author = await api.signIn("ranked-messages@example.com");
  const db = api.database.sqlite;
  for (const id of ["voter-one", "voter-two"]) {
    db.prepare("INSERT INTO users(id,email,name) VALUES(?,?,?)").run(id, `${id}@example.com`, id);
  }
  db.prepare("INSERT INTO boards(id,slug,name) VALUES('other-room','other-room','Other Room')").run();
  for (const [id, boardId, day] of [
    ["popular", "general", "01"],
    ["tie-older", "general", "02"],
    ["tie-b", "general", "03"],
    ["tie-a", "general", "03"],
    ["no-votes", "general", "04"],
    ["negative", "general", "05"],
    ["other-popular", "other-room", "01"],
  ]) {
    db.prepare("INSERT INTO messages(id,board_id,user_id,title,body,created_at) VALUES(?,?,?,'Title','Body',?)")
      .run(id, boardId, author.user.id, `2026-10-${day}T00:00:00.000Z`);
  }
  for (const [id, voter, value] of [
    ["popular", "voter-one", 1],
    ["other-popular", "voter-one", 1],
    ["other-popular", "voter-two", 1],
    ["negative", "voter-one", -1],
    ["negative", "voter-two", -1],
  ] as const) {
    db.prepare("INSERT INTO message_votes(message_id,user_id,value) VALUES(?,?,?)").run(id, voter, value);
  }
  db.prepare("DELETE FROM message_votes WHERE message_id='no-votes'").run();

  const ranked = ["other-popular", "popular", "tie-a", "tie-b", "tie-older", "no-votes", "negative"];
  for (const boardId of [undefined, "general"]) {
    const ids: unknown[] = [];
    const expected = boardId ? ranked.slice(1) : ranked;
    for (let offset = 0; offset < expected.length; offset += 2) {
      const query = new URLSearchParams({ select: "id", order: "votes.desc,created_at.desc", limit: "2", offset: String(offset) });
      if (boardId) query.set("board_id", `eq.${boardId}`);
      const response = await api.request(`${api.table("messages")}?${query}`);
      assert.equal(response.status, 200, await response.clone().text());
      const rows = (await json(response)).data;
      assert.ok(rows.every(row => Object.keys(row).join(",") === "id"));
      ids.push(...rows.map(row => row.id));
    }
    assert.deepEqual(ids, expected);
  }
  const ascending = await api.request(`${api.table("messages")}?select=id&order=votes.asc&limit=2`);
  assert.deepEqual((await json(ascending)).data, [{ id: "negative" }, { id: "no-votes" }]);
  const newest = await api.request(`${api.table("messages")}?select=id&limit=1`);
  assert.deepEqual((await json(newest)).data, [{ id: "negative" }]);

  const changed = await api.request("/votes", {
    method: "PUT", headers: api.authorized(author, { "content-type": "application/json" }),
    body: JSON.stringify({ message_id: "popular", value: 0 }),
  });
  assert.equal(changed.status, 200, await changed.clone().text());
  const updated = await api.request(`${api.table("messages")}?select=id&board_id=eq.general&order=votes.desc,created_at.desc&limit=1`);
  assert.deepEqual((await json(updated)).data, [{ id: "tie-a" }]);
});

test("clients cannot supply or overwrite a message reply count", async t => {
  const api = await fixture(t);
  const author = await api.signIn("reply-count@example.com");
  const response = await api.request(api.table("messages"), {
    method: "POST",
    headers: api.authorized(author, { "content-type": "application/json" }),
    body: JSON.stringify({ board_id: "general", title: "Forged count", body: "Body", reply_count: 999 }),
  });
  assert.equal(response.status, 400);
  assert.equal(api.database.sqlite.prepare("SELECT COUNT(*) AS n FROM messages").get()?.n, 0);
});

test("board creators can update only the description while keeping the board's identity and name", async t => {
  const api = await fixture(t);
  const owner = await api.signIn("board-owner@example.com");
  const other = await api.signIn("board-other@example.com");
  const created = await api.request(api.table("boards"), {
    method: "POST", headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ slug: "my-board", name: "My Board", description: "Original" }),
  });
  const board = (await json(created)).data[0];
  const patch = (query: string, input: unknown, session?: UserSession) => api.request(`${api.table("boards")}${query}`, {
    method: "PATCH", headers: session ? api.authorized(session, { "content-type": "application/json" }) : { "content-type": "application/json" },
    body: JSON.stringify(input),
  });
  const query = `?id=eq.${board.id}&user_id=eq.${owner.user.id}`;
  for (const description of ["  Updated description.  ", ""]) {
    const updated = await patch(query, { description }, owner);
    assert.equal(updated.status, 200, await updated.clone().text());
    assert.deepEqual((await json(updated)).data, [{ ...board, description: description.trim() }]);
  }
  assert.equal((await patch(query, { description: "Stolen" })).status, 401);
  assert.equal((await patch(`?id=eq.${board.id}`, { description: "Stolen" }, other)).status, 403);
  assert.equal((await patch(query, { description: "Stolen" }, other)).status, 403);
  assert.equal((await patch("?id=eq.general", { description: "Stolen" }, owner)).status, 403);
  assert.equal((await patch("?id=eq.missing", { description: "Missing" }, owner)).status, 404);
  for (const input of [
    {}, { description: null }, { description: 123 }, { description: "a".repeat(2001) },
    { description: "Changed", name: "New Name" }, { description: "Changed", slug: "new-slug" },
    { description: "Changed", user_id: other.user.id }, { description: "Changed", id: "other" },
  ]) {
    assert.equal((await patch(query, input, owner)).status, 400);
  }
  for (const invalidQuery of ["", "?id=eq.", `${query}&id=eq.general`, `${query}&slug=eq.general`]) {
    assert.equal((await patch(invalidQuery, { description: "Changed" }, owner)).status, 400);
  }
  const read = await api.request(`${api.table("boards")}?id=eq.${board.id}`);
  assert.deepEqual((await json(read)).data, [{ ...board, description: "" }]);
  await api.request("/auth/session", { method: "DELETE", headers: api.authorized(owner) });
  assert.equal((await patch(query, { description: "Revoked" }, owner)).status, 401);
});

test("profile reads expose only id and name, and a user can update only their own name", async (t) => {
  const api = await fixture(t);
  const owner = await api.signIn("private@example.com");
  const other = await api.signIn("other@example.com");
  const read = await api.request(`${api.table("users")}?select=id,name&id=eq.${owner.user.id}&limit=1`, {
    headers: api.authorized(owner),
  });
  assert.equal(read.status, 200);
  const profile = (await json(read)).data[0];
  assert.deepEqual(Object.keys(profile).sort(), ["id", "name"]);
  assert.equal(profile.id, owner.user.id);

  for (const secretColumn of ["email", "dob", "google_sub", "password", "token_hash"]) {
    const leak = await api.request(`${api.table("users")}?select=id,${secretColumn}&id=eq.${owner.user.id}`, {
      headers: api.authorized(owner),
    });
    assert.ok(leak.status >= 400 && leak.status < 500, `${secretColumn} was readable`);
    assert.deepEqual(await json(leak).then((payload) => payload.data), undefined);
  }

  const update = await api.request(`${api.table("users")}?id=eq.${owner.user.id}`, {
    method: "PATCH",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ name: "New Name" }),
  });
  assert.equal(update.status, 200, await update.clone().text());
  assert.deepEqual((await json(update)).data, [{ id: owner.user.id, name: "New Name" }]);

  const otherUpdate = await api.request(`${api.table("users")}?id=eq.${other.user.id}`, {
    method: "PATCH",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ name: "Stolen Name" }),
  });
  assert.equal(otherUpdate.status, 403);
  const unchanged = await api.request(`${api.table("users")}?select=id,name&id=eq.${other.user.id}`, {
    headers: { apikey: apiKey },
  });
  assert.notEqual((await json(unchanged)).data[0].name, "Stolen Name");
});

test("writes derive the author from the bearer and reject missing, expired, or revoked sessions", async (t) => {
  const api = await fixture(t);
  const owner = await api.signIn("write@example.com");
  const board = (await json(await api.request(`${api.table("boards")}?select=id&slug=eq.general`, {
    headers: { apikey: apiKey },
  }))).data[0];
  const createMessage = (headers: HeadersInit, userId?: string) => api.request(api.table("messages"), {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ board_id: board.id, title: "A post", body: "A body", ...(userId ? { user_id: userId } : {}) }),
  });

  const missing = await createMessage({ apikey: apiKey });
  assert.equal(missing.status, 401);
  const spoof = await createMessage(api.authorized(owner), "someone-else");
  assert.equal(spoof.status, 403);

  const created = await createMessage(api.authorized(owner));
  assert.equal(created.status, 201, await created.clone().text());
  assert.equal((await json(created)).data[0].user_id, owner.user.id);

  const nonexistentBoard = await api.request(api.table("messages"), {
    method: "POST",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ board_id: "missing-board", title: "A post", body: "A body" }),
  });
  assert.equal(nonexistentBoard.status, 404);
  const invalidBody = await api.request(api.table("messages"), {
    method: "POST",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ board_id: board.id, title: "", body: "A body" }),
  });
  assert.equal(invalidBody.status, 400);
  const nonexistentReply = await api.request(api.table("replies"), {
    method: "POST",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ message_id: "missing-message", body: "A reply" }),
  });
  assert.equal(nonexistentReply.status, 404);
  api.database.sqlite.exec("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z'");
  const expired = await createMessage(api.authorized(owner));
  assert.equal(expired.status, 401);

  const fresh = await api.signIn("revoked@example.com");
  const revoked = await api.request("/auth/session", {
    method: "DELETE", headers: api.authorized(fresh),
  });
  assert.equal(revoked.status, 200);
  const afterRevoke = await createMessage(api.authorized(fresh));
  assert.equal(afterRevoke.status, 401);
});

test("message deletion enforces ownership, applies all frontend filters, and cascades replies", async (t) => {
  const api = await fixture(t);
  const owner = await api.signIn("message-owner@example.com");
  const other = await api.signIn("message-other@example.com");
  const boardId = (await json(await api.request(`${api.table("boards")}?select=id&slug=eq.general`, {
    headers: { apikey: apiKey },
  }))).data[0].id;
  const created = await api.request(api.table("messages"), {
    method: "POST",
    headers: api.authorized(owner, { "content-type": "application/json" }),
    body: JSON.stringify({ board_id: boardId, title: "To delete", body: "Delete me" }),
  });
  const message = (await json(created)).data[0];
  const createdReply = await api.request(api.table("replies"), {
    method: "POST",
    headers: api.authorized(other, { "content-type": "application/json" }),
    body: JSON.stringify({ message_id: message.id, body: "Will cascade" }),
  });
  assert.equal(createdReply.status, 201);

  const filtered = `?id=eq.${message.id}&board_id=eq.${boardId}&user_id=eq.${owner.user.id}`;
  const denied = await api.request(`${api.table("messages")}${filtered}`, {
    method: "DELETE", headers: api.authorized(other),
  });
  assert.equal(denied.status, 403);
  const deleted = await api.request(`${api.table("messages")}${filtered}`, {
    method: "DELETE", headers: api.authorized(owner),
  });
  assert.equal(deleted.status, 200, await deleted.clone().text());
  assert.deepEqual(await json(deleted), { data: [], meta: { changes: 1 } });

  const remaining = await api.request(`${api.table("replies")}?select=id&message_id=eq.${message.id}`, {
    headers: { apikey: apiKey },
  });
  assert.deepEqual((await json(remaining)).data, []);
  const absent = await api.request(`${api.table("messages")}${filtered}`, {
    method: "DELETE", headers: api.authorized(owner),
  });
  assert.equal(absent.status, 404);
});

test("table routes reject unsafe queries, invalid paging, legacy paths, and unknown tables as JSON", async (t) => {
  const api = await fixture(t);
  const invalidRequests = [
    `${api.table("messages")}?select=*`,
    `${api.table("messages")}?select=id%3Bdrop%20table%20users`,
    `${api.table("messages")}?id=ne.anything`,
    `${api.table("messages")}?id=eq.one&id=eq.two`,
    `${api.table("messages")}?order=body.asc;drop%20table%20users`,
    `${api.table("messages")}?limit=101`,
    `${api.table("messages")}?offset=-1`,
    "/tables/unknown",
    "/bff/data/legacy/tables/messages",
  ];
  for (const path of invalidRequests) {
    const response = await api.request(path, { headers: { apikey: apiKey } });
    assert.ok(response.status >= 400 && response.status < 500, `${path}: ${response.status}`);
    const payload = await json(response);
    assert.equal(typeof payload.error, "string", path);
  }

  const stillExists = await api.request(`${api.table("users")}?select=id,name&limit=1`, {
    headers: { apikey: apiKey },
  });
  assert.equal(stillExists.status, 200);
  assert.equal((await json(stillExists)).data.length, 0);
});

test("CORS preflight allows the frontend's public key, bearer, and JSON headers for approved origins", async (t) => {
  const api = await fixture(t);
  const response = await api.request(api.table("messages"), {
    method: "OPTIONS",
    headers: {
      origin: "https://yapern.com",
      "access-control-request-method": "POST",
      "access-control-request-headers": "apikey,authorization,content-type",
    },
  });
  assert.ok(response.status === 200 || response.status === 204);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://yapern.com");
  const allowedHeaders = response.headers.get("access-control-allow-headers")?.toLowerCase() ?? "";
  for (const header of ["apikey", "authorization", "content-type"]) assert.ok(allowedHeaders.includes(header));
  assert.equal(response.headers.get("access-control-allow-credentials"), null);

  const blocked = await api.request(api.table("messages"), {
    headers: { origin: "https://attacker.example" },
  });
  assert.equal(blocked.status, 403);
  assert.equal(blocked.headers.get("access-control-allow-origin"), null);
});

test("D1 batch rolls back earlier writes if a later statement fails", async (t) => {
  const api = await fixture(t);
  const { db } = api.database;
  await assert.rejects(db.batch([
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("batch-first", "same@example.com"),
    db.prepare("INSERT INTO users (id, email) VALUES (?, ?)").bind("batch-second", "same@example.com"),
  ]));
  const count = await db.prepare("SELECT count(*) AS count FROM users").first<{ count: number }>();
  assert.equal(count?.count, 0);
});
