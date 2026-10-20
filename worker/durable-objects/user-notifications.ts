import { createHash, randomBytes } from "node:crypto";
import { jsonResponse } from "../shared/http";
import { readNotificationSnapshot } from "../app/notification-store";

interface ConnectionIdentity {
  user_id: string;
  token_hash: string;
  expires_at: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest("hex");

// One object per recipient. D1 is the durable notification log; this object's
// SQLite storage holds single-use socket tickets and monotonic snapshot versions.
export class UserNotifications {
  constructor(private readonly ctx: DurableObjectState, private readonly env: Env) {
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS socket_tickets (
      hash TEXT PRIMARY KEY, identity TEXT NOT NULL, expires INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS snapshot_version (
      id INTEGER PRIMARY KEY CHECK(id=1), version INTEGER NOT NULL
    )`);
    ctx.storage.sql.exec("INSERT OR IGNORE INTO snapshot_version VALUES(1,0)");
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  fetch(request: Request): Promise<Response> {
    // Serialize snapshots, acknowledgements and upgrades across D1 awaits so
    // tabs never receive a stale snapshot after a newer acknowledgement.
    return this.ctx.blockConcurrencyWhile(() => this.handle(request));
  }

  private async active(identity: ConnectionIdentity): Promise<boolean> {
    if (Date.parse(identity.expires_at) <= Date.now()) return false;
    return Boolean(await this.env.DB.prepare(`SELECT user_id FROM sessions
      WHERE token_hash=? AND user_id=? AND expires_at>?`)
      .bind(identity.token_hash, identity.user_id, new Date().toISOString()).first());
  }

  private async snapshot(userId: string) {
    const { version } = this.ctx.storage.sql.exec<{ version: number }>(
      "UPDATE snapshot_version SET version=version+1 WHERE id=1 RETURNING version",
    ).one();
    return readNotificationSnapshot(this.env.DB, userId, version);
  }

  private async broadcast(snapshot: Awaited<ReturnType<typeof readNotificationSnapshot>>) {
    const payload = JSON.stringify(snapshot);
    const checked = new Map<string, boolean>();
    for (const ws of this.ctx.getWebSockets()) {
      try {
        const identity = ws.deserializeAttachment() as ConnectionIdentity;
        if (!checked.has(identity.token_hash)) checked.set(identity.token_hash, await this.active(identity));
        if (checked.get(identity.token_hash)) ws.send(payload);
        else ws.close(4001, "Session expired");
      } catch {
        try { ws.close(1011, "Reconnect to notifications"); } catch { /* Already disconnected. */ }
      }
    }
  }

  private async handle(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/ticket" && request.method === "POST") {
      const identity = await request.json() as ConnectionIdentity;
      const now = Date.now();
      this.ctx.storage.sql.exec("DELETE FROM socket_tickets WHERE expires<=?", now);
      const { count } = this.ctx.storage.sql.exec<{ count: number }>("SELECT COUNT(*) AS count FROM socket_tickets").one();
      if (count >= 50) return jsonResponse({ error: "rate_limited" }, 429);
      const ticket = randomBytes(32).toString("hex");
      this.ctx.storage.sql.exec("INSERT INTO socket_tickets VALUES(?,?,?)", digest(ticket), JSON.stringify(identity), now + 60_000);
      return jsonResponse({ ticket, user_id: identity.user_id });
    }
    if (url.pathname === "/socket" && request.method === "GET") {
      if (request.headers.get("upgrade")?.toLowerCase() !== "websocket") {
        return jsonResponse({ error: "websocket_upgrade_required" }, 400);
      }
      const ticket = url.searchParams.get("ticket") ?? "";
      if (!/^[a-f0-9]{64}$/.test(ticket)) return jsonResponse({ error: "invalid_ticket" }, 401);
      const rows = this.ctx.storage.sql.exec<{ identity: string; expires: number }>(
        "DELETE FROM socket_tickets WHERE hash=? RETURNING identity,expires", digest(ticket),
      ).toArray();
      const saved = rows[0];
      if (!saved || saved.expires <= Date.now()) return jsonResponse({ error: "invalid_ticket" }, 401);
      const identity = JSON.parse(saved.identity) as ConnectionIdentity;
      if (identity.user_id !== url.searchParams.get("user_id") || !await this.active(identity)) {
        return jsonResponse({ error: "invalid_session" }, 401);
      }
      if (this.ctx.getWebSockets().length >= 50) return jsonResponse({ error: "connection_limit" }, 429);
      const snapshot = await this.snapshot(identity.user_id);
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(identity);
      server.send(JSON.stringify(snapshot));
      return new Response(null, { status: 101, webSocket: client });
    }
    // These internal endpoints are reachable only via the Worker binding. The
    // router supplies the authenticated recipient, never a client-supplied one.
    if (["/snapshot", "/read", "/publish"].includes(url.pathname) && request.method === "POST") {
      const input = await request.json() as { user_id: string; through_id?: number };
      if (url.pathname === "/read") {
        await this.env.DB.prepare("UPDATE notifications SET read_at=? WHERE user_id=? AND id<=? AND read_at IS NULL")
          .bind(new Date().toISOString(), input.user_id, input.through_id).run();
      }
      const snapshot = await this.snapshot(input.user_id);
      if (url.pathname !== "/snapshot") await this.broadcast(snapshot);
      return jsonResponse(snapshot);
    }
    return jsonResponse({ error: "not_found" }, 404);
  }

  webSocketMessage(ws: WebSocket) {
    // Clients acknowledge through authenticated HTTP. Other socket messages are
    // unnecessary; ping/pong is answered by the runtime without waking the DO.
    ws.close(1008, "Unsupported message");
  }
  webSocketClose(ws: WebSocket, code: number, reason: string) {
    // A browser close() without a code arrives as the reserved sentinel 1005,
    // which cannot itself be sent in a close frame.
    ws.close([1005, 1006, 1015].includes(code) ? 1000 : code, reason);
  }
  webSocketError(ws: WebSocket) { ws.close(1011, "Reconnect to notifications"); }
}
