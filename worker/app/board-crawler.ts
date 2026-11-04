import { z } from "@hono/zod-openapi";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";
import { CrawlJob, latestBoardCrawls, latestCrawl, startCrawl } from "./crawl-jobs";

const identifier = z.string().trim().min(1).max(512);
const boardParams = z.object({ boardId: identifier });
const urlParams = boardParams.extend({ urlId: identifier });
const CrawlerUrl = z.object({
  id: z.string(), board_id: z.string(), url: z.string(), created_at: z.string(), crawl: CrawlJob.optional(),
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

async function requireOwner(request: Request, env: Env, boardId: string): Promise<string> {
  const session = await requireSession(request, env);
  const board = await env.DB.prepare("SELECT user_id FROM boards WHERE id=?")
    .bind(boardId).first<{ user_id: string | null }>();
  if (!board) throw new ApiError(404, "not_found");
  if (board.user_id !== session.user_id) throw new ApiError(403, "permission_denied");
  return session.user_id;
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
    const jobs = await latestBoardCrawls(c.env, boardId);
    return c.json({ data: result.results.map(row => ({ ...row, ...(jobs.has(String(row.id)) ? { crawl: jobs.get(String(row.id)) } : {}) })) });
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
    method: "post", path: `${path}/{urlId}/crawl`, operationId: "crawlBoardSite", tags: ["Boards"],
    summary: "Queue a robots-aware HTTPS crawl and post up to 20 recent article references to your board", security: protectedSecurity,
    description: "Uses User-Agent: yapern.com crawler v1.0.0. Checks robots.txt, then RSS/Atom/JSON feeds, sitemaps, and first-page article links. Imports titles, source URLs and short summaries as messages by the board owner. Previously imported URLs are skipped across sources and repeated jobs. Repeated requests while a job is active return that same job. Poll GET on this path for progress.",
    request: { params: urlParams },
    responses: { ...errors, 202: jsonResult(z.object({ data: CrawlJob }), "Queued or already active crawl job."),
      429: errorResult("The daily limit of 100 crawl jobs was reached (crawl_limit)."),
      503: errorResult("The background queue is unavailable (crawl_queue_unavailable).") },
  }, async c => {
    const { boardId, urlId } = urlParams.parse(c.req.param());
    const userId = await requireOwner(c.req.raw, c.env, boardId);
    return c.json({ data: await startCrawl(c.env, boardId, urlId, userId) }, 202);
  });

  registerRoute(app, {
    method: "get", path: `${path}/{urlId}/crawl`, operationId: "getBoardSiteCrawl", tags: ["Boards"],
    summary: "Read the latest crawl job for a site on your board", security: protectedSecurity,
    request: { params: urlParams },
    responses: { ...errors, 200: jsonResult(z.object({ data: CrawlJob.nullable() }), "Latest job, or null before the first crawl."),
      503: errorResult("The background queue is unavailable (crawl_queue_unavailable).") },
  }, async c => {
    const { boardId, urlId } = urlParams.parse(c.req.param());
    await requireOwner(c.req.raw, c.env, boardId);
    if (!await c.env.DB.prepare("SELECT id FROM board_crawler_urls WHERE id=? AND board_id=?").bind(urlId, boardId).first()) throw new ApiError(404, "not_found");
    return c.json({ data: await latestCrawl(c.env, boardId, urlId) });
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
