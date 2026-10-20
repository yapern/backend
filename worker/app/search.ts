import { z } from "@hono/zod-openapi";
import { errorResult, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { ApiError } from "./contracts";

const SearchQuery = z.object({
  q: z.string().trim().min(1).max(200),
  type: z.enum(["messages", "boards"]).default("messages"),
  board: z.string().min(1).max(80).regex(/^[a-z0-9]+(?:[a-z0-9-]*[a-z0-9])?$/).optional(),
  sort: z.enum(["relevance", "newest"]).default("relevance"),
  limit: z.string().regex(/^(?:[1-9]|[1-4][0-9]|50)$/).default("20"),
  offset: z.string().regex(/^(?:0|[1-9][0-9]{0,2}|1000)$/).default("0"),
}).strict();

const common = { id: z.string(), snippet: z.string(), created_at: z.string() };
const MessageResult = z.object({
  ...common, type: z.literal("message"), title: z.string(),
  board_id: z.string(), board_slug: z.string(), board_name: z.string(),
  author_id: z.string(), author_name: z.string(),
});
const BoardResult = z.object({
  ...common, type: z.literal("board"), slug: z.string(), name: z.string(),
});
const SearchResponse = z.object({
  data: z.array(z.discriminatedUnion("type", [MessageResult, BoardResult])),
  meta: z.object({ has_more: z.boolean(), limit: z.number().int(), offset: z.number().int() }),
}).openapi("SearchResults");

// Treat user input as literal words, never as FTS operators or column names.
// Only the final word is a prefix, so "sqlite ind" finds "SQLite indexes".
function matchQuery(input: string): string | null {
  const words = input.match(/[\p{L}\p{N}][\p{L}\p{N}\p{M}]*/gu) ?? [];
  if (words.length > 20) throw new ApiError(400, "invalid_request");
  return words.length ? words.map((word, index) => `"${word}"${index === words.length - 1 ? "*" : ""}`).join(" AND ") : null;
}

export function registerSearchRoutes(app: Api): void {
  registerRoute(app, {
    method: "get", path: "/search", operationId: "searchContent", tags: ["Search"],
    summary: "Search public messages or sub-yaps", security: [],
    description: "Full-text search over message titles/bodies or board slugs/names/descriptions. All words must match; the final word supports prefix matching. Input is literal text (at most 200 characters and 20 words). Relevance weights titles and names above body text. Optional board slug filtering, newest sorting, and bounded pagination (limit 1–50, offset 0–1000). Snippets are plain text. Replies are not searched.",
    request: { query: SearchQuery },
    responses: {
      200: jsonResult(SearchResponse, "Ranked results with current board and author information; has_more indicates another permitted page."),
      400: errorResult("Invalid search text, filter, sort, pagination, or duplicate parameter (invalid_request)."),
      403: errorResult("The browser origin is not allowed (origin_not_allowed)."),
    },
  }, async c => {
    const values: Record<string, string> = {};
    for (const [key, value] of new URL(c.req.url).searchParams) {
      if (Object.hasOwn(values, key)) throw new ApiError(400, "invalid_request");
      values[key] = value;
    }
    const query = SearchQuery.parse(values);
    const match = matchQuery(query.q);
    const limit = Number(query.limit);
    const offset = Number(query.offset);
    if (!match) return c.json({ data: [], meta: { has_more: false, limit, offset } });

    const parameters: (string | number)[] = [match];
    if (query.board) parameters.push(query.board);
    parameters.push(limit + 1, offset);
    const relevance = query.sort === "relevance";
    // Every SQL identifier/order expression is fixed here, not supplied by the client.
    const sql = query.type === "messages"
      ? `SELECT 'message' AS type, m.id, m.title, m.created_at,
          snippet(messages_fts, 1, '', '', '…', 32) AS snippet,
          b.id AS board_id, b.slug AS board_slug, b.name AS board_name,
          u.id AS author_id, u.name AS author_name
        FROM messages_fts JOIN messages m ON m.rowid=messages_fts.rowid
        JOIN boards b ON b.id=m.board_id JOIN users u ON u.id=m.user_id
        WHERE messages_fts MATCH ?${query.board ? " AND b.slug=?" : ""}
        ORDER BY ${relevance ? "bm25(messages_fts, 5.0, 1.0), " : ""}m.created_at DESC, m.id ASC LIMIT ? OFFSET ?`
      : `SELECT 'board' AS type, b.id, b.slug, b.name, b.created_at,
          snippet(boards_fts, 2, '', '', '…', 32) AS snippet
        FROM boards_fts JOIN boards b ON b.rowid=boards_fts.rowid
        WHERE boards_fts MATCH ?${query.board ? " AND b.slug=?" : ""}
        ORDER BY ${relevance ? "bm25(boards_fts, 6.0, 5.0, 1.0), " : ""}b.created_at DESC, b.id ASC LIMIT ? OFFSET ?`;
    const result = await c.env.DB.prepare(sql).bind(...parameters).all();
    return c.json({
      data: result.results.slice(0, limit),
      meta: { has_more: result.results.length > limit && offset + limit <= 1000, limit, offset },
    });
  });
}
