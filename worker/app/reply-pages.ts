import { z } from "@hono/zod-openapi";
import { errorResult, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { ApiError } from "./contracts";
import { Reply } from "./data";

const identifier = z.string().min(1).max(512).refine(value => value.trim() === value);
const pageLimit = z.string().regex(/^(?:[1-9]|[1-9][0-9]|100)$/);
const messageParams = z.object({ messageId: identifier });
const contextParams = messageParams.extend({ replyId: identifier });
const pageQuery = z.object({
  parent_reply_id: identifier.optional(),
  cursor: z.string().min(1).max(8192).regex(/^[A-Za-z0-9_-]+$/).optional(),
  limit: pageLimit.default("20"),
  sort: z.enum(["new", "old", "top"]).default("new"),
}).strict();
const contextQuery = z.object({ limit: pageLimit.default("6") }).strict();
const cursorSchema = z.tuple([
  z.literal(2), identifier, identifier.nullable(), z.enum(["new", "old", "top"]),
  z.union([z.string().min(1).max(128), z.number().int()]), identifier,
]);
type Cursor = z.infer<typeof cursorSchema>;
type Sort = z.infer<typeof pageQuery>["sort"];
const PublicReply = Reply.extend({ author_name: z.string().nullable() }).openapi("ReplyWithAuthor");
type ReplyRow = z.infer<typeof PublicReply> & { vote_score: number };
const replyFields = "id,message_id,parent_reply_id,user_id,body,created_at,direct_reply_count";
const prefixed = (alias: string) => replyFields.split(",").map(field => `${alias}.${field}`).join(",");

function queryValues(url: string): Record<string, string> {
  const values: Record<string, string> = Object.create(null);
  for (const [key, value] of new URL(url).searchParams) {
    if (Object.hasOwn(values, key)) throw new ApiError(400, "invalid_request");
    values[key] = value;
  }
  return values;
}

function encodeCursor(messageId: string, parentId: string | null, sort: Sort, last: ReplyRow): string {
  const bytes = new TextEncoder().encode(JSON.stringify([
    2, messageId, parentId, sort, sort === "top" ? last.vote_score : last.created_at, last.id,
  ]));
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function decodeCursor(value: string, messageId: string, parentId: string | null, sort: Sort): Cursor {
  try {
    const bytes = Uint8Array.from(atob(value.replace(/-/g, "+").replace(/_/g, "/")), character => character.charCodeAt(0));
    const cursor = cursorSchema.parse(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
    if (cursor[1] !== messageId || cursor[2] !== parentId || cursor[3] !== sort
      || (sort === "top" ? typeof cursor[4] !== "number" : typeof cursor[4] !== "string")) {
      throw new Error("cursor_scope_mismatch");
    }
    return cursor;
  } catch {
    throw new ApiError(400, "invalid_request");
  }
}

export function registerReplyPageRoutes(app: Api): void {
  const errors = {
    400: errorResult("Invalid query, duplicate parameter, or cursor for a different message/parent (invalid_request)."),
    403: errorResult("The browser origin is not allowed (origin_not_allowed)."),
    404: errorResult("The message or requested reply does not exist in this thread (not_found)."),
  };
  registerRoute(app, {
    method: "get", path: "/messages/{messageId}/replies", operationId: "listReplyChildren",
    tags: ["Replies"], summary: "Read one page of immediate reply children", security: [],
    description: "Omit parent_reply_id for direct replies to the message; provide a reply ID for immediate children. Descendants are never included automatically. Each branch/sort has its own opaque keyset cursor. New (default) orders created_at/id descending, old ascending, top uses an indexed cached vote score/id descending. Cursors survive deletion of the last item. Top reflects live scores; refresh a branch to reflect ranking changes and deduplicate IDs when appending pages. Maximum page size 100, default 20. Author names are joined once per page.",
    request: { params: messageParams, query: pageQuery },
    responses: { ...errors, 200: jsonResult(z.object({
      data: z.array(PublicReply), meta: z.object({ next_cursor: z.string().nullable() }),
    }).openapi("ReplyChildrenPage"), "Immediate children with an opaque cursor, or null when the branch is exhausted.") },
  }, async c => {
    const { messageId } = messageParams.parse(c.req.param());
    const query = pageQuery.parse(queryValues(c.req.url));
    const parentId = query.parent_reply_id ?? null;
    const cursor = query.cursor ? decodeCursor(query.cursor, messageId, parentId, query.sort) : null;
    const target = await c.env.DB.prepare(`SELECT id FROM messages WHERE id=? AND (? IS NULL OR EXISTS (
      SELECT 1 FROM replies WHERE id=? AND message_id=messages.id
    ))`).bind(messageId, parentId, parentId).first();
    if (!target) throw new ApiError(404, "not_found");
    const limit = Number(query.limit);
    const parameters: (string | number | null)[] = [messageId, parentId];
    if (cursor) parameters.push(cursor[4], cursor[5]);
    parameters.push(limit + 1);
    const ranking = query.sort === "top" ? "vote_score" : "created_at";
    const comparison = query.sort === "old" ? ">" : "<";
    const direction = query.sort === "old" ? "ASC" : "DESC";
    const result = await c.env.DB.prepare(`SELECT ${prefixed("r")},r.vote_score,u.name AS author_name FROM replies r
      LEFT JOIN users u ON u.id=r.user_id
      WHERE r.message_id=? AND r.parent_reply_id IS ?${cursor ? ` AND (r.${ranking},r.id)${comparison}(?,?)` : ""}
      ORDER BY r.${ranking} ${direction},r.id ${direction} LIMIT ?`).bind(...parameters).all<ReplyRow>();
    const page = result.results.slice(0, limit);
    const data = page.map(({ vote_score: _score, ...reply }) => reply);
    return c.json({ data, meta: {
      next_cursor: result.results.length > limit ? encodeCursor(messageId, parentId, query.sort, page.at(-1)!) : null,
    } });
  });

  registerRoute(app, {
    method: "get", path: "/messages/{messageId}/replies/{replyId}/context", operationId: "readReplyContext",
    tags: ["Replies"], summary: "Read bounded ancestry for a reply deep link", security: [],
    description: "Returns only the nearest ancestor chain, including the target reply, ordered oldest ancestor first and target last. Default 6 rows, maximum 100. has_more indicates older ancestors omitted; the first returned row's parent_reply_id identifies the next earlier ancestor. Siblings and descendants are never fetched.",
    request: { params: contextParams, query: contextQuery },
    responses: { ...errors, 200: jsonResult(z.object({
      data: z.array(PublicReply), meta: z.object({ has_more: z.boolean() }),
    }).openapi("ReplyContext"), "Bounded nearest ancestry including the target reply.") },
  }, async c => {
    const { messageId, replyId } = contextParams.parse(c.req.param());
    const { limit: value } = contextQuery.parse(queryValues(c.req.url));
    const limit = Number(value);
    const result = await c.env.DB.prepare(`WITH RECURSIVE ancestry AS (
      SELECT ${prefixed("r")},0 AS distance FROM replies r WHERE r.id=? AND r.message_id=?
      UNION ALL
      SELECT ${prefixed("r")},a.distance+1
        FROM replies r JOIN ancestry a ON r.id=a.parent_reply_id WHERE a.distance<?
    ) SELECT ${prefixed("a")},u.name AS author_name FROM ancestry a
      LEFT JOIN users u ON u.id=a.user_id ORDER BY a.distance DESC`)
      .bind(replyId, messageId, limit).all<ReplyRow>();
    if (!result.results.length) throw new ApiError(404, "not_found");
    return c.json({ data: result.results.slice(-limit), meta: { has_more: result.results.length > limit } });
  });
}
