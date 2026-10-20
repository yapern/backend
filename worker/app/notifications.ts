import { z } from "@hono/zod-openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";
import { NotificationSnapshot } from "./notification-store";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";

function recipient(env: Env, userId: string) {
  if (!env.NOTIFICATIONS) throw new ApiError(503, "notifications_unavailable");
  return env.NOTIFICATIONS.get(env.NOTIFICATIONS.idFromName(userId));
}

function internalRequest(path: string, body: unknown) {
  return new Request(`https://notifications.internal${path}`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
}

export async function publishNotifications(env: Env, userId: string): Promise<void> {
  // Failed pushes leave the D1 outbox intact for the scheduled retry. The next
  // visit also reads D1 directly through the DO, independently of delivery.
  if (!env.NOTIFICATIONS) return;
  try {
    const response = await recipient(env, userId).fetch(internalRequest("/publish", { user_id: userId }));
    if (!response.ok) throw new Error("notification_push_failed");
    const snapshot = NotificationSnapshot.parse(await response.json());
    await env.DB.prepare("UPDATE notifications SET delivered_at=? WHERE user_id=? AND id<=? AND delivered_at IS NULL")
      .bind(new Date().toISOString(), userId, snapshot.last_id).run();
  } catch (error) {
    console.error("notification_delivery_pending", { userId, error });
  }
}

export async function notifyReply(env: Env, replyId: string): Promise<void> {
  try {
    const notification = await env.DB.prepare("SELECT user_id FROM notifications WHERE reply_id=?")
      .bind(replyId).first<{ user_id: string }>();
    if (notification) await publishNotifications(env, notification.user_id);
  } catch (error) {
    // The reply and outbox already committed. Never turn a delivery failure
    // into a failed reply response, which could encourage a duplicate post.
    console.error("notification_delivery_pending", { replyId, error });
  }
}

export async function retryNotificationDelivery(env: Env): Promise<void> {
  if (!env.NOTIFICATIONS) return;
  const pending = await env.DB.prepare("SELECT DISTINCT user_id FROM notifications WHERE delivered_at IS NULL LIMIT 50")
    .all<{ user_id: string }>();
  for (const row of pending.results) await publishNotifications(env, row.user_id);
}

export function registerNotificationRoutes(app: Api): void {
  const errors = {
    401: errorResult("A valid, unexpired bearer session is required."),
    503: errorResult("Notifications are temporarily unavailable."),
  };
  registerRoute(app, {
    method: "get", path: "/notifications", operationId: "listNotifications",
    tags: ["Notifications"], summary: "Read your latest 50 reply and upvote notifications and total unread count", security: protectedSecurity,
    responses: { ...errors, 200: jsonResult(NotificationSnapshot, "Recipient-scoped notification snapshot.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    return recipient(c.env, session.user_id).fetch(internalRequest("/snapshot", { user_id: session.user_id }));
  });
  const acknowledgement = z.object({ through_id: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER) }).strict();
  registerRoute(app, {
    method: "post", path: "/notifications/read", operationId: "readNotifications",
    tags: ["Notifications"], summary: "Mark notifications through an observed ID as read across your tabs", security: protectedSecurity,
    request: { body: { required: true, content: jsonContent(acknowledgement) } },
    responses: { ...errors, 400: errorResult("Invalid acknowledgement."), 200: jsonResult(NotificationSnapshot, "Newer replies remain unread.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const input = acknowledgement.parse(await c.req.json());
    return recipient(c.env, session.user_id).fetch(internalRequest("/read", { user_id: session.user_id, ...input }));
  });
  registerRoute(app, {
    method: "post", path: "/notifications/ticket", operationId: "createNotificationTicket",
    tags: ["Notifications"], summary: "Get a single-use WebSocket ticket valid for 60 seconds", security: protectedSecurity,
    responses: { ...errors, 429: errorResult("Too many outstanding tickets."), 200: jsonResult(z.object({
      ticket: z.string(), user_id: z.string(),
    }), "Pass this ticket to the notification socket; never put a bearer token in the URL.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    return recipient(c.env, session.user_id).fetch(internalRequest("/ticket", {
      user_id: session.user_id, token_hash: session.token_hash, expires_at: session.expires_at,
    }));
  });
  registerRoute(app, {
    method: "get", path: "/notifications/socket", operationId: "connectNotifications",
    tags: ["Notifications"], summary: "Upgrade to a hibernating WebSocket using a single-use ticket", security: [],
    description: "Requires an allowed browser Origin and an unexpired ticket from POST /notifications/ticket. Sends NotificationSnapshot on connect and on reply/upvote/read changes. Send ping for a runtime-level pong. Rejects reused tickets and revoked sessions.",
    request: { query: z.object({ user_id: z.string().min(1).max(512), ticket: z.string().regex(/^[a-f0-9]{64}$/) }).strict() },
    responses: {
      101: { description: "WebSocket connected." },
      400: errorResult("Invalid ticket query or missing WebSocket upgrade."),
      401: errorResult("Ticket expired, used or invalid; or session revoked."),
      403: errorResult("Missing or unapproved browser Origin."),
      429: errorResult("Too many connections."), 503: errors[503],
    },
  }, c => {
    if (!c.req.header("origin")) throw new ApiError(403, "origin_not_allowed");
    const userId = c.req.query("user_id")!;
    const url = new URL(c.req.url);
    url.pathname = "/socket";
    return recipient(c.env, userId).fetch(new Request(url, c.req.raw));
  });
}
