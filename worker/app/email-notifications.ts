import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { MarketingEmailPreferenceError, sendMarketingEmail } from "../lib/marketing-email";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";

const Preferences = z.object({
  email_notify_replies: z.boolean(),
  email_notify_votes: z.boolean(),
  email_notify_sub_yap_messages: z.boolean(),
}).strict().openapi("EmailNotificationPreferences");
type PreferencesRow = { [Key in keyof z.infer<typeof Preferences>]: number };
const preferenceFields = Object.keys(Preferences.shape) as (keyof PreferencesRow)[];
const preferences = (row: PreferencesRow) => Object.fromEntries(preferenceFields.map(key => [key, row[key] === 1]));

export function registerEmailNotificationRoutes(app: Api): void {
  const path = "/account/email-notifications";
  const responses = {
    200: jsonResult(Preferences, "Your three email notification preferences."),
    400: errorResult("Invalid request; preferences must be booleans."),
    401: errorResult("A valid, unexpired bearer session is required."),
    404: errorResult("Your account was not found."),
  };
  for (const method of ["get", "patch"] as const) {
    registerRoute(app, {
      method, path, operationId: method === "get" ? "getEmailNotificationPreferences" : "updateEmailNotificationPreferences",
      tags: ["Profiles"], summary: method === "get" ? "Read your email notification preferences" : "Save your email notification preferences",
      description: "Private to the current bearer session. All three preferences default to true for existing and new accounts. Global marketing unsubscribes still apply. Sub-yap participation includes messages and replies. Saving does not subscribe an address that previously unsubscribed.",
      security: protectedSecurity,
      request: { query: z.object({}).strict(), ...(method === "patch" ? {
        body: { required: true, content: jsonContent(Preferences) },
      } : {}) },
      responses,
    }, async c => {
      const session = await requireSession(c.req.raw, c.env);
      let row: PreferencesRow | null;
      if (method === "patch") {
        const input = Preferences.parse(await c.req.json());
        row = await c.env.DB.prepare(`UPDATE users SET ${preferenceFields.map(key => `${key}=?`).join(",")}
          WHERE id=? RETURNING ${preferenceFields.join(",")}`)
          .bind(...preferenceFields.map(key => Number(input[key])), session.user_id).first<PreferencesRow>();
      } else {
        row = await c.env.DB.prepare(`SELECT ${preferenceFields.join(",")} FROM users WHERE id=?`)
          .bind(session.user_id).first<PreferencesRow>();
      }
      if (!row) throw new ApiError(404, "not_found");
      return c.json(preferences(row));
    });
  }
}

type Job = {
  id: number; user_id: string; kind: "reply" | "upvote" | "downvote" | "new_message";
  message_id: string; reply_id: string | null; attempts: number;
};
type EmailDetails = PreferencesRow & {
  email: string | null; actor_name: string; board_slug: string; message_title: string;
  message_body: string; reply_body: string | null; parent_reply_id: string | null;
};

function eventEmail(job: Job, details: EmailDetails) {
  const actor = details.actor_name.trim() || "Someone";
  const board = `y/${details.board_slug}`;
  const target = job.reply_id ? "reply" : "message";
  const link = `https://yapern.com/y/${encodeURIComponent(details.board_slug)}/${encodeURIComponent(job.message_id)}` +
    (job.reply_id ? `#reply-${encodeURIComponent(job.reply_id)}` : "");
  if (job.kind === "reply") {
    const answered = details.parent_reply_id ? "reply" : "message";
    return {
      subj: `New reply to your ${answered} on Yapern`,
      message: `${actor} replied to your ${answered} in ${board}.\n\n${details.message_title}\n\n${details.reply_body}\n\nView reply: ${link}`,
    };
  }
  if (job.kind === "new_message") {
    return {
      subj: `New message in ${board} on Yapern`,
      message: `${actor} posted in ${board}.\n\n${details.message_title}\n\n${details.message_body}\n\nView message: ${link}`,
    };
  }
  const action = job.kind === "upvote" ? "upvoted" : "downvoted";
  return {
    subj: `Someone ${action} your ${target} on Yapern`,
    message: `${actor} ${action} your ${target} in ${board}.\n\n${details.message_title}` +
      (job.reply_id ? `\n\n${details.reply_body}` : "") + `\n\nView ${target}: ${link}`,
  };
}

export async function deliverEmailNotifications(env: Env): Promise<void> {
  if (!env.MARKETING_EMAIL) return;
  try {
    const now = Date.now();
    const claim = randomUUID();
    // One atomic claim prevents requests and scheduled retries sending the same
    // jobs concurrently. Abandoned claims become available after five minutes.
    const pending = await env.DB.prepare(`UPDATE email_notifications SET claim_token=?,available_at=?,attempts=attempts+1
      WHERE id IN (SELECT id FROM email_notifications WHERE completed_at IS NULL AND available_at<=? ORDER BY id LIMIT 20)
      RETURNING id,user_id,kind,message_id,reply_id,attempts`)
      .bind(claim, now + 300_000, now).all<Job>();
    for (const job of pending.results) {
      try {
        const details = await env.DB.prepare(`SELECT u.email,u.email_notify_replies,u.email_notify_votes,
          u.email_notify_sub_yap_messages,a.name AS actor_name,b.slug AS board_slug,
          m.title AS message_title,m.body AS message_body,r.body AS reply_body,r.parent_reply_id
          FROM email_notifications n JOIN users u ON u.id=n.user_id JOIN users a ON a.id=n.actor_id
          JOIN messages m ON m.id=n.message_id JOIN boards b ON b.id=m.board_id
          LEFT JOIN replies r ON r.id=n.reply_id WHERE n.id=? AND n.claim_token=?`)
          .bind(job.id, claim).first<EmailDetails>();
        const preference = job.kind === "reply" ? "email_notify_replies"
          : job.kind === "new_message" ? "email_notify_sub_yap_messages" : "email_notify_votes";
        // Recheck immediately before sending, including changes since enqueue.
        if (details?.email?.trim() && details[preference] === 1) {
          const result = await sendMarketingEmail(env, {
            to: details.email.trim(), from: "Yapern <hello@yapern.com>", ...eventEmail(job, details),
          });
          if (!result?.messageId) throw new Error("missing_message_id");
        }
        await env.DB.prepare("UPDATE email_notifications SET completed_at=? WHERE id=? AND claim_token=?")
          .bind(Date.now(), job.id, claim).run();
      } catch (error) {
        if (error instanceof MarketingEmailPreferenceError && error.message === "recipient_unsubscribed") {
          await env.DB.prepare("UPDATE email_notifications SET completed_at=? WHERE id=? AND claim_token=?")
            .bind(Date.now(), job.id, claim).run();
        } else {
          const delay = Math.min(3_600_000, 30_000 * 2 ** Math.min(job.attempts - 1, 7));
          await env.DB.prepare("UPDATE email_notifications SET available_at=? WHERE id=? AND claim_token=?")
            .bind(Date.now() + delay, job.id, claim).run();
          console.error("email_notification_delivery_pending", { id: job.id });
        }
      }
    }
    await env.DB.prepare("DELETE FROM email_notifications WHERE completed_at<?")
      .bind(now - 30 * 86_400_000).run();
  } catch {
    // Events have already committed; email delivery must not fail their response.
    console.error("email_notification_delivery_unavailable");
  }
}
