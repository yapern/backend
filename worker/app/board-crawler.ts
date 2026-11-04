import { z } from "@hono/zod-openapi";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";

const identifier = z.string().trim().min(1).max(512);
const boardParams = z.object({ boardId: identifier });
const urlParams = boardParams.extend({ urlId: identifier });
const CrawlerUrl = z.object({
  id: z.string(), board_id: z.string(), url: z.string(), created_at: z.string(),
}).openapi("BoardCrawlerUrl");
const urlInput = z.object({
  url: z.string().trim().min(1).max(2048).refine(value => {
    try {
      const url = new URL(value);
      return /^https?:\/\//i.test(value) && !/[\s\u0000-\u001f\u007f]/.test(value) && ["http:", "https:"].includes(url.protocol) &&
        !url.username && !url.password && url.href.length <= 2048;
    } catch { return false; }
  }),
}).strict().openapi("AddBoardCrawlerUrl");
const results = z.object({ data: z.array(CrawlerUrl) });
const errors = {
  400: errorResult("Invalid URL or request (invalid_request). Use an HTTP or HTTPS URL without credentials, at most 2048 characters."),
  401: errorResult("A valid bearer session is required (unauthorized)."),
  403: errorResult("Only the board's owner can manage crawler URLs (permission_denied)."),
  404: errorResult("The board or URL does not exist (not_found)."),
};

async function requireOwner(request: Request, env: Env, boardId: string): Promise<void> {
  const session = await requireSession(request, env);
  const board = await env.DB.prepare("SELECT user_id FROM boards WHERE id=?")
    .bind(boardId).first<{ user_id: string | null }>();
  if (!board) throw new ApiError(404, "not_found");
  if (board.user_id !== session.user_id) throw new ApiError(403, "permission_denied");
}

export function registerBoardCrawlerRoutes(app: Api): void {
  const path = "/boards/{boardId}/crawler-urls";
  registerRoute(app, {
    method: "get", path, operationId: "listBoardCrawlerUrls", tags: ["Boards"],
    summary: "List your board's crawler URLs in the order they were added", security: protectedSecurity,
    request: { params: boardParams },
    responses: { ...errors, 200: jsonResult(results, "Saved crawler URLs.") },
  }, async c => {
    const { boardId } = boardParams.parse(c.req.param());
    await requireOwner(c.req.raw, c.env, boardId);
    const result = await c.env.DB.prepare("SELECT id,board_id,url,created_at FROM board_crawler_urls WHERE board_id=? ORDER BY created_at ASC, rowid ASC")
      .bind(boardId).all();
    return c.json({ data: result.results });
  });

  registerRoute(app, {
    method: "post", path, operationId: "addBoardCrawlerUrl", tags: ["Boards"],
    summary: "Add one crawler URL to a board you own", security: protectedSecurity,
    request: { params: boardParams, body: { required: true, content: jsonContent(urlInput) } },
    responses: { ...errors, 201: jsonResult(results, "Saved crawler URL."),
      409: errorResult("This URL is already saved on this board (crawler_url_exists).") },
  }, async c => {
    const { boardId } = boardParams.parse(c.req.param());
    await requireOwner(c.req.raw, c.env, boardId);
    const input = urlInput.parse(await c.req.json());
    const url = new URL(input.url).href;
    const row = await c.env.DB.prepare("INSERT INTO board_crawler_urls(board_id,url) VALUES(?,?) ON CONFLICT(board_id,url) DO NOTHING RETURNING *")
      .bind(boardId, url).first();
    if (!row) throw new ApiError(409, "crawler_url_exists");
    return c.json({ data: [row] }, 201);
  });

  registerRoute(app, {
    method: "delete", path: `${path}/{urlId}`, operationId: "deleteBoardCrawlerUrl", tags: ["Boards"],
    summary: "Remove a crawler URL from a board you own", security: protectedSecurity,
    request: { params: urlParams },
    responses: { ...errors, 200: jsonResult(results, "The removed crawler URL.") },
  }, async c => {
    const { boardId, urlId } = urlParams.parse(c.req.param());
    await requireOwner(c.req.raw, c.env, boardId);
    const row = await c.env.DB.prepare("DELETE FROM board_crawler_urls WHERE id=? AND board_id=? RETURNING *")
      .bind(urlId, boardId).first();
    if (!row) throw new ApiError(404, "not_found");
    return c.json({ data: [row] });
  });
}
