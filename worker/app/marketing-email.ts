import { z } from "@hono/zod-openapi";
import { MarketingEmailPreferenceError, sendMarketingEmail } from "../lib/marketing-email";
import { marketingEmailSchema, marketingUnsubscribeSchema } from "../shared/marketing-email-contract";
import { errorResult, jsonContent, jsonResult, OkSchema, registerRoute, type Api } from "../shared/openapi";
import { limitBody } from "../shared/body-limit";
import { renderUnsubscribePage } from "../templates/marketing-email";
import { requireAdmin } from "./admin-auth";
import { protectedSecurity } from "./contracts";

async function unsubscribeEmail(env: Env, email: string): Promise<void> {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO marketing_email_unsubscribes (email) VALUES (?) ON CONFLICT(email) DO NOTHING").bind(email),
    env.DB.prepare("UPDATE users SET marketing_email_unsubscribed = 1 WHERE lower(trim(email)) = ?").bind(email),
  ]);
}

const preferenceErrors = {
  400: errorResult("Invalid email or JSON request."), 403: errorResult("Origin not allowed."),
  405: errorResult("Only POST is supported."), 413: errorResult("Request exceeds the byte limit."),
  503: errorResult("Email preferences are unavailable; no send is allowed until they can be checked."),
};
const pageHeaders = {
  // Hide the email query without making native POST forms send Origin: null.
  "referrer-policy": "strict-origin", "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
};
const htmlResponse = (description: string) => ({ description, content: { "text/html": { schema: { type: "string" as const } } } });

export function registerMarketingEmailRoutes(app: Api): void {
  registerRoute(app, {
    method: "post", path: "/api/send-marketing-email", operationId: "sendMarketingEmail", tags: ["Marketing"],
    summary: "Send one marketing email using the Yapern template", security: protectedSecurity,
    description: "Requires the current bearer session of oneone@gmail.com and a trusted Origin header. Accepts one recipient and one bare or named sender from an onboarded Cloudflare Email Sending domain. The message is plain text; HTML is escaped and line breaks are preserved. fancy defaults to true for Yapern branding; false uses plain white HTML. Both parts contain a working unsubscribe link. Every send checks the user flag and permanent normalized address opt-out, returning 409 recipient_unsubscribed or 503 email_preferences_unavailable without sending when applicable. Maximum JSON body is 1 MiB. Waits for binding acceptance and returns a message ID, which does not confirm inbox delivery. No automatic retries.",
    middleware: [async (c, next) => {
      if (!c.req.header("origin")) return c.json({ error: "origin_required" }, 403);
      await requireAdmin(c.req.raw, c.env);
      await next();
    }, limitBody(1024 * 1024)],
    request: {
      headers: z.object({ origin: z.string().url().describe("Trusted browser origin, such as https://yapern.com.") }),
      body: { required: true, content: jsonContent(marketingEmailSchema.openapi("MarketingEmailRequest")) },
    },
    responses: {
      202: jsonResult(z.object({ ok: z.literal(true), messageId: z.string() }), "Email accepted by Cloudflare Email Sending."),
      ...preferenceErrors, 401: errorResult("Invalid or expired admin bearer session."),
      409: errorResult("The recipient has unsubscribed (recipient_unsubscribed)."),
      429: errorResult("Email rate or daily limit exceeded."), 502: errorResult("Email sending failed; the request was not accepted."),
    },
  }, async c => {
    const input = marketingEmailSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    if (!c.env.MARKETING_EMAIL) return c.json({ error: "email_sending_unavailable" }, 503);
    try {
      const result = await sendMarketingEmail(c.env, input.data);
      if (!result?.messageId) throw new Error("missing_message_id");
      return c.json({ ok: true, messageId: result.messageId }, 202);
    } catch (error) {
      if (error instanceof MarketingEmailPreferenceError) {
        return c.json({ error: error.message }, error.message === "recipient_unsubscribed" ? 409 : 503);
      }
      const code = error instanceof Error && "code" in error ? error.code : undefined;
      console.error("marketing_email_send_failed", code);
      const limited = code === "E_RATE_LIMIT_EXCEEDED" || code === "E_DAILY_LIMIT_EXCEEDED";
      return c.json({ error: limited ? "email_rate_limited" : "email_send_failed" }, limited ? 429 : 502);
    }
  });
  registerRoute(app, {
    method: "post", path: "/api/unsubscribe", operationId: "unsubscribeMarketingEmail", tags: ["Marketing"],
    summary: "Permanently unsubscribe an email address from marketing emails", security: [],
    description: "Public endpoint; no session is required. Trims and lowercases the supplied address, records a permanent address opt-out and updates all matching users atomically. Current sessions do not select the recipient. Repeated requests are idempotent; registered and unregistered addresses receive the same response. Maximum JSON body size is 4 KiB. A supplied Origin must be trusted.",
    middleware: limitBody(4096),
    request: { body: { required: true, content: jsonContent(marketingUnsubscribeSchema.openapi("MarketingUnsubscribeRequest")) } },
    responses: { 200: jsonResult(OkSchema, "The address is unsubscribed."), ...preferenceErrors },
  }, async c => {
    const input = marketingUnsubscribeSchema.safeParse(await c.req.json().catch(() => null));
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    try {
      await unsubscribeEmail(c.env, input.data.email);
      return c.json({ ok: true });
    } catch (error) {
      console.error("marketing_email_unsubscribe_failed", error);
      return c.json({ error: "email_preferences_unavailable" }, 503);
    }
  });
  registerRoute(app, {
    method: "get", path: "/unsubscribe", operationId: "getMarketingUnsubscribePage", tags: ["Marketing"],
    summary: "Show the marketing unsubscribe form", security: [],
    description: "Public HTML form linked from emails. Reading this page does not change preferences, so link previews and email scanners cannot unsubscribe recipients.",
    request: { query: z.object({ email: z.string().max(254).optional() }).strict() },
    responses: { 200: htmlResponse("An accessible unsubscribe form; no JavaScript required."), 400: errorResult("Invalid email query."), 403: errorResult("Origin not allowed.") },
  }, c => c.html(renderUnsubscribePage(c.req.query("email") ?? ""), 200, pageHeaders));
  registerRoute(app, {
    method: "post", path: "/unsubscribe", operationId: "submitMarketingUnsubscribePage", tags: ["Marketing"],
    summary: "Submit the public marketing unsubscribe form", security: [],
    middleware: [limitBody(4096), async (c, next) => {
      const form = await c.req.parseBody();
      if (!marketingUnsubscribeSchema.safeParse(form).success) {
        const email = typeof form.email === "string" ? form.email : "";
        return c.html(renderUnsubscribePage(email, "invalid"), 400, pageHeaders);
      }
      await next();
    }],
    request: { body: { required: true, content: { "application/x-www-form-urlencoded": { schema: marketingUnsubscribeSchema } } } },
    responses: {
      200: htmlResponse("The address is unsubscribed."), 400: htmlResponse("Invalid email; the form retains the address for correction."),
      403: errorResult("Origin not allowed."), 413: errorResult("Form exceeds 4 KiB."), 503: htmlResponse("Could not save; the form retains the email for retry."),
    },
  }, async c => {
    const input = marketingUnsubscribeSchema.safeParse(await c.req.parseBody());
    if (!input.success) return c.json({ error: "invalid_request" }, 400);
    try {
      await unsubscribeEmail(c.env, input.data.email);
      return c.html(renderUnsubscribePage(input.data.email, "success"), 200, pageHeaders);
    } catch (error) {
      console.error("marketing_email_unsubscribe_failed", error);
      return c.html(renderUnsubscribePage(input.data.email, "error"), 503, pageHeaders);
    }
  });
  for (const path of ["/api/send-marketing-email", "/api/unsubscribe"]) {
    app.all(path, c => c.json({ error: "method_not_allowed" }, 405, { allow: "POST, OPTIONS" }));
  }
  app.all("/unsubscribe", c => c.json({ error: "method_not_allowed" }, 405, { allow: "GET, POST, OPTIONS" }));
}
