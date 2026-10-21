import { z } from "@hono/zod-openapi";
import type { Handler } from "hono";
import { errorResult, jsonResult, registerRoute, type Api, type ApiEnv } from "../shared/openapi";
import { jsonResponse } from "../shared/http";
import { requireAdmin } from "./admin-auth";
import { ApiError, protectedSecurity } from "./contracts";

const PAGE_SIZE = 25;
const userColumns = "id, email, name, dob, created_at, marketing_email_unsubscribed";
const User = z.object({
  id: z.string(), email: z.string().nullable(), name: z.string(), dob: z.string().nullable(),
  created_at: z.string(), marketing_email_unsubscribed: z.number().int().min(0).max(1),
}).openapi("AdminUser");
const MarketingUser = User.omit({ dob: true, marketing_email_unsubscribed: true }).openapi("MarketingUser");
const offsetSchema = z.coerce.number().int().min(0).max(1_000_000).default(0);
const limitSchema = z.coerce.number().int().min(1).max(100).default(PAGE_SIZE);
const page = { total: z.number().int().nonnegative(), offset: z.number().int().nonnegative(), limit: z.number().int().positive() };
const errors = {
  400: errorResult("Invalid query parameters."), 401: errorResult("Invalid or expired bearer session."),
  403: errorResult("Only oneone@gmail.com may use this endpoint; supplied origins must be trusted."),
  405: errorResult("Only GET is supported."), 503: errorResult("Admin data or authentication is unavailable."),
};

type TableDefinition = { id: string; label: string; group: string; table: string; columns: string[]; search: string[]; order: string };
// Only these tables and columns may enter an admin query. Credentials, sessions,
// provider identifiers and infrastructure tables are deliberately omitted.
const TABLES: TableDefinition[] = [
  { id: "users", label: "Users", group: "Accounts", table: "users", columns: userColumns.split(", "), search: ["id", "email", "name"], order: "created_at DESC, id DESC" },
  { id: "boards", label: "Boards", group: "Discussion", table: "boards", columns: ["id", "slug", "name", "description", "user_id", "logo_url", "created_at"], search: ["id", "slug", "name", "description", "user_id"], order: "created_at DESC, id DESC" },
  { id: "messages", label: "Messages", group: "Discussion", table: "messages", columns: ["id", "board_id", "user_id", "title", "body", "image_url", "reply_count", "created_at"], search: ["id", "board_id", "user_id", "title", "body"], order: "created_at DESC, id DESC" },
  { id: "replies", label: "Replies", group: "Discussion", table: "replies", columns: ["id", "message_id", "parent_reply_id", "user_id", "body", "direct_reply_count", "created_at"], search: ["id", "message_id", "parent_reply_id", "user_id", "body"], order: "created_at DESC, id DESC" },
];

function queryNumber(params: URLSearchParams, name: string, fallback: number, min: number, max: number): number {
  const text = params.get(name) ?? String(fallback);
  const value = Number(text);
  if (params.getAll(name).length > 1 || !/^\d+$/.test(text) || !Number.isSafeInteger(value) || value < min || value > max) {
    throw new ApiError(400, name === "offset" ? "invalid_offset" : "invalid_limit");
  }
  return value;
}

async function handleAdminRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== "GET") return jsonResponse({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" });
  await requireAdmin(request, env);
  const url = new URL(request.url);
  try {
    if (url.pathname === "/admin/users") {
      const rows = await env.DB.prepare(`SELECT ${userColumns} FROM users ORDER BY created_at DESC, id DESC`).all();
      return jsonResponse({ users: rows.results });
    }
    const userMatch = /^\/admin\/users\/([^/]+)$/.exec(url.pathname);
    if (userMatch) {
      let id: string;
      try { id = decodeURIComponent(userMatch[1]); }
      catch { throw new ApiError(400, "invalid_user_id"); }
      if (!id || id.length > 200) throw new ApiError(400, "invalid_user_id");
      const user = await env.DB.prepare(`SELECT ${userColumns} FROM users WHERE id = ?`).bind(id).first();
      if (!user) throw new ApiError(404, "not_found");
      return jsonResponse({ user });
    }
    if (url.pathname === "/api/get-marketing-users") {
      const offset = queryNumber(url.searchParams, "offset", 0, 0, 1_000_000);
      const limit = queryNumber(url.searchParams, "limit", PAGE_SIZE, 1, 100);
      const filter = `WHERE users.marketing_email_unsubscribed = 0
        AND NOT EXISTS (SELECT 1 FROM marketing_email_unsubscribes WHERE email = lower(trim(users.email)))
        AND NOT EXISTS (SELECT 1 FROM users AS unsubscribed
          WHERE lower(trim(unsubscribed.email)) = lower(trim(users.email)) AND unsubscribed.marketing_email_unsubscribed = 1)`;
      const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM users ${filter}`).first<{ total: number }>();
      const rows = await env.DB.prepare(`SELECT users.id, users.email, users.name, users.created_at FROM users ${filter}
        ORDER BY users.created_at DESC, users.id DESC LIMIT ? OFFSET ?`).bind(limit, offset).all();
      return jsonResponse({ users: rows.results, total: count?.total ?? 0, offset, limit });
    }
    if (url.pathname === "/admin/tables") {
      return jsonResponse({ tables: TABLES.map(({ id, label, group, columns }) => ({ id, label, group, columns })) });
    }
    const match = /^\/admin\/tables\/([a-z-]+)$/.exec(url.pathname);
    const definition = TABLES.find(item => item.id === match?.[1]);
    if (!definition) throw new ApiError(404, "not_found");
    const offset = queryNumber(url.searchParams, "offset", 0, 0, 1_000_000);
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length > 100 || url.searchParams.getAll("q").length > 1) throw new ApiError(400, "invalid_query");
    const filter = query ? ` WHERE (${definition.search.map(column => `${column} LIKE ? ESCAPE '\\'`).join(" OR ")})` : "";
    const term = `%${query.replace(/[\\%_]/g, "\\$&")}%`;
    const args = query ? definition.search.map(() => term) : [];
    const count = await env.DB.prepare(`SELECT COUNT(*) AS total FROM ${definition.table}${filter}`).bind(...args).first<{ total: number }>();
    const rows = await env.DB.prepare(`SELECT ${definition.columns.join(", ")} FROM ${definition.table}${filter}
      ORDER BY ${definition.order} LIMIT ? OFFSET ?`).bind(...args, PAGE_SIZE, offset).all();
    return jsonResponse({ items: rows.results, total: count?.total ?? 0, offset, limit: PAGE_SIZE });
  } catch (error) {
    if (error instanceof ApiError) throw error;
    console.error("admin_read_failed", error);
    throw new ApiError(503, "admin_unavailable");
  }
}

export function registerAdminRoutes(app: Api): void {
  const handler: Handler<ApiEnv> = c => handleAdminRequest(c.req.raw, c.env);
  registerRoute(app, {
    method: "get", path: "/admin/users", operationId: "listAdminUsers", tags: ["Admin"],
    summary: "List all Yapern users", security: protectedSecurity,
    description: "Requires the current bearer session of oneone@gmail.com. Returns safe profile fields ordered by created_at descending, then id descending. No credentials, session tokens or provider identifiers are returned.",
    responses: { 200: jsonResult(z.object({ users: z.array(User) }), "User profiles."), ...errors },
  }, handler);
  registerRoute(app, {
    method: "get", path: "/admin/users/{userId}", operationId: "getAdminUser", tags: ["Admin"],
    summary: "Read one Yapern user", security: protectedSecurity,
    request: { params: z.object({ userId: z.string().min(1).max(200) }) },
    responses: { 200: jsonResult(z.object({ user: User }), "User profile."), ...errors, 404: errorResult("User not found.") },
  }, handler);
  registerRoute(app, {
    method: "get", path: "/admin/tables", operationId: "listAdminTables", tags: ["Admin"],
    summary: "List the available admin tables and safe columns", security: protectedSecurity,
    responses: { 200: jsonResult(z.object({ tables: z.array(z.object({
      id: z.string(), label: z.string(), group: z.string(), columns: z.array(z.string()),
    })) }), "Allowlisted discussion and account tables."), ...errors },
  }, handler);
  registerRoute(app, {
    method: "get", path: "/admin/tables/{table}", operationId: "getAdminTable", tags: ["Admin"],
    summary: "Search and page through an admin table", security: protectedSecurity,
    description: "Requires oneone@gmail.com. Only users, boards, messages and replies are available. Literal substring search escapes SQL LIKE wildcards. Returns 25 rows per page, newest first with stable ID ties.",
    request: { params: z.object({ table: z.string() }), query: z.object({ offset: offsetSchema, q: z.string().trim().max(100).optional() }).strict() },
    responses: { 200: jsonResult(z.object({ items: z.array(z.record(z.string(), z.unknown())), ...page }), "Rows and filtered total."), ...errors, 404: errorResult("Table not available.") },
  }, handler);
  registerRoute(app, {
    method: "get", path: "/api/get-marketing-users", operationId: "getMarketingUsers", tags: ["Admin"],
    summary: "List users who have not unsubscribed from marketing emails", security: protectedSecurity,
    description: "Requires oneone@gmail.com. Excludes marketing_email_unsubscribed users and normalized addresses opted out directly or through another account. Includes users with null email, matching Mainbrella. Returns only id, email, name and created_at, newest first with stable ID ties. Total counts eligible users before pagination. Defaults to offset 0 and limit 25; maximum offset 1000000 and limit 100.",
    request: { query: z.object({ offset: offsetSchema, limit: limitSchema }).strict() },
    responses: { 200: jsonResult(z.object({ users: z.array(MarketingUser), ...page }), "Eligible profiles and filtered total."), ...errors },
  }, handler);
  for (const path of ["/admin/users", "/admin/users/:userId", "/admin/tables", "/admin/tables/:table", "/api/get-marketing-users"]) {
    app.all(path, c => c.json({ error: "method_not_allowed" }, 405, { allow: "GET, OPTIONS" }));
  }
}
