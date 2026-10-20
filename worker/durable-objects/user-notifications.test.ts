import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { UserNotifications } from "./user-notifications";
import { createTestDatabase } from "../testing/database";

type SocketIdentity = { user_id: string; token_hash: string; expires_at: string };

class SqliteObjectStorage {
  constructor(readonly sqlite = new DatabaseSync(":memory:")) {}

  exec<T>(query: string, ...values: unknown[]) {
    const statement = this.sqlite.prepare(query);
    const rows = statement.all(...values as SQLInputValue[]) as T[];
    return {
      one: () => {
        if (!rows.length) throw new Error("Expected a row");
        return rows[0];
      },
      toArray: () => rows,
    };
  }
}

class FakeSocket {
  sent: string[] = [];
  closed: Array<{ code: number; reason: string }> = [];
  constructor(private identity: SocketIdentity) {}
  deserializeAttachment() { return this.identity; }
  serializeAttachment(identity: SocketIdentity) { this.identity = identity; }
  send(value: string) { this.sent.push(value); }
  close(code: number, reason: string) { this.closed.push({ code, reason }); }
}

function context(storage: SqliteObjectStorage, sockets: FakeSocket[] = []) {
  return {
    storage: { sql: { exec: storage.exec.bind(storage) } },
    blockConcurrencyWhile: <T>(callback: () => Promise<T>) => callback(),
    setWebSocketAutoResponse: () => undefined,
    getWebSockets: () => sockets,
    acceptWebSocket: (socket: FakeSocket) => sockets.push(socket),
  } as unknown as DurableObjectState;
}

function installWebSocketPairStub() {
  const globals = globalThis as unknown as Record<string, unknown>;
  if (globals.WebSocketRequestResponsePair) return;
  globals.WebSocketRequestResponsePair = class {
    constructor(readonly request: string, readonly response: string) {}
  };
}

function seedUsers(db: ReturnType<typeof createTestDatabase>["sqlite"], identities: SocketIdentity[]) {
  for (const identity of identities) {
    db.prepare("INSERT INTO users(id,email,name) VALUES(?,?,?)")
      .run(identity.user_id, `${identity.user_id}@example.com`, identity.user_id);
    db.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
      .run(identity.token_hash, identity.user_id, identity.expires_at);
  }
}

function addNotificationFixture(db: ReturnType<typeof createTestDatabase>["sqlite"], ownerId: string, actorId: string) {
  db.prepare("INSERT INTO messages(id,board_id,user_id,title,body) VALUES('notify-message','general',?,'Notification title','Body')")
    .run(ownerId);
  db.prepare("INSERT INTO replies(id,message_id,user_id,body) VALUES('notify-reply','notify-message',?,'Reply')")
    .run(actorId);
}

function env(database: ReturnType<typeof createTestDatabase>): Env {
  return { DB: database.db } as Env;
}

function request(path: string, body: unknown, method = "POST") {
  return new Request(`https://notifications.internal${path}`, {
    method, headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

installWebSocketPairStub();

test("single-use tickets persist across hibernation, are consumed, expire, and require a live session", async t => {
  const database = createTestDatabase();
  const storage = new SqliteObjectStorage();
  t.after(() => { database.close(); storage.sqlite.close(); });
  const identity: SocketIdentity = {
    user_id: "ticket-user", token_hash: "ticket-hash", expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  seedUsers(database.sqlite, [identity]);
  const first = new UserNotifications(context(storage), env(database));
  const issued = await first.fetch(request("/ticket", identity));
  assert.equal(issued.status, 200);
  const ticket = (await issued.json() as { ticket: string; user_id: string }).ticket;
  assert.match(ticket, /^[a-f0-9]{64}$/);

  // A new object instance represents a hibernated DO resuming from its SQLite state.
  const resumed = new UserNotifications(context(storage), env(database));
  database.sqlite.prepare("DELETE FROM sessions WHERE token_hash=?").run(identity.token_hash);
  const upgradeRequest = () => new Request(`https://notifications.internal/socket?user_id=${identity.user_id}&ticket=${ticket}`, {
    headers: { upgrade: "websocket" },
  });
  const revoked = await resumed.fetch(upgradeRequest());
  assert.equal(revoked.status, 401);
  assert.equal(storage.sqlite.prepare("SELECT COUNT(*) AS count FROM socket_tickets").get()?.count, 0);
  assert.equal((await resumed.fetch(upgradeRequest())).status, 401);

  // Expired tickets are also deleted as part of the attempted single use.
  database.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(?,?,?)")
    .run(identity.token_hash, identity.user_id, identity.expires_at);
  const another = await resumed.fetch(request("/ticket", identity));
  assert.equal(another.status, 200);
  const nextTicket = (await another.json() as { ticket: string }).ticket;
  const hash = createHash("sha256").update(nextTicket).digest("hex");
  storage.sqlite.prepare("UPDATE socket_tickets SET expires=? WHERE hash=?").run(Date.now() - 1, hash);
  const expired = await resumed.fetch(new Request(`https://notifications.internal/socket?user_id=${identity.user_id}&ticket=${nextTicket}`, {
    headers: { upgrade: "websocket" },
  }));
  assert.equal(expired.status, 401);
});

test("snapshot versions survive reconstruction and broadcasts validate each saved session", async t => {
  const database = createTestDatabase();
  const storage = new SqliteObjectStorage();
  t.after(() => { database.close(); storage.sqlite.close(); });
  const valid: SocketIdentity = {
    user_id: "snapshot-owner", token_hash: "live-hash", expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const revoked: SocketIdentity = {
    user_id: "snapshot-owner", token_hash: "revoked-hash", expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  const actor: SocketIdentity = {
    user_id: "snapshot-actor", token_hash: "actor-hash", expires_at: new Date(Date.now() + 60_000).toISOString(),
  };
  seedUsers(database.sqlite, [valid, actor]);
  addNotificationFixture(database.sqlite, valid.user_id, actor.user_id);
  const currentSocket = new FakeSocket(valid);
  const revokedSocket = new FakeSocket(revoked);
  const sockets = [currentSocket, revokedSocket];
  const first = new UserNotifications(context(storage, sockets), env(database));

  const firstSnapshot = await first.fetch(request("/snapshot", { user_id: valid.user_id }));
  assert.equal((await firstSnapshot.json() as { version: number }).version, 1);
  const resumed = new UserNotifications(context(storage, sockets), env(database));
  const published = await resumed.fetch(request("/publish", { user_id: valid.user_id }));
  const event = await published.json() as { version: number; unread_count: number; notifications: Array<{ reply_id: string }> };
  assert.equal(event.version, 2);
  assert.equal(event.unread_count, 1);
  assert.equal(event.notifications[0].reply_id, "notify-reply");
  assert.equal(currentSocket.sent.length, 1);
  assert.deepEqual(JSON.parse(currentSocket.sent[0]), event);
  assert.deepEqual(revokedSocket.closed, [{ code: 4001, reason: "Session expired" }]);
});

test("browser close sentinel is normalized before forwarding a close frame", async () => {
  const database = createTestDatabase();
  const storage = new SqliteObjectStorage();
  try {
    const socket = new FakeSocket({ user_id: "u", token_hash: "h", expires_at: "" });
    const object = new UserNotifications(context(storage), env(database));
    object.webSocketClose(socket as unknown as WebSocket, 1005, "browser closed");
    assert.deepEqual(socket.closed, [{ code: 1000, reason: "browser closed" }]);
  } finally {
    database.close(); storage.sqlite.close();
  }
});
