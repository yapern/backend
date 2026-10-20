import { z } from "@hono/zod-openapi";

export const NotificationSnapshot = z.object({
  type: z.literal("notifications"),
  version: z.number().int().positive(),
  unread_count: z.number().int().nonnegative(),
  last_id: z.number().int().nonnegative(),
  notifications: z.array(z.object({
    id: z.number().int().positive(), kind: z.enum(["reply", "upvote"]),
    reply_id: z.string().nullable(), message_id: z.string(),
    board_slug: z.string(), message_title: z.string(), actor_name: z.string(),
    created_at: z.string(), read_at: z.string().nullable(),
  })),
}).openapi("NotificationSnapshot");

export async function readNotificationSnapshot(db: D1Database, userId: string, version: number) {
  // One D1 transaction gives the list, unread count and acknowledgement cutoff
  // the same view of concurrent reply inserts.
  const results = await db.batch([
    db.prepare(`SELECT COUNT(CASE WHEN read_at IS NULL THEN 1 END) AS unread_count,
      COALESCE(MAX(id), 0) AS last_id FROM notifications WHERE user_id=?`).bind(userId),
    db.prepare(`SELECT n.id, n.kind, n.reply_id, COALESCE(r.message_id,n.message_id) AS message_id, b.slug AS board_slug,
      m.title AS message_title, u.name AS actor_name, n.created_at, n.read_at
      FROM notifications n LEFT JOIN replies r ON r.id=n.reply_id
      JOIN messages m ON m.id=COALESCE(r.message_id,n.message_id) JOIN boards b ON b.id=m.board_id
      JOIN users u ON u.id=COALESCE(n.actor_id,r.user_id)
      WHERE n.user_id=? ORDER BY n.id DESC LIMIT 50`).bind(userId),
  ]);
  const counts = results[0].results[0] as { unread_count: number; last_id: number };
  return NotificationSnapshot.parse({ type: "notifications", version, ...counts, notifications: results[1].results });
}
