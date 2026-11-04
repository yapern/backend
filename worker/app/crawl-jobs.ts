import { randomUUID } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { ApiError } from "./contracts";
import { CrawlFailure, crawlUrl, discoverArticles, type Article } from "./crawl-discovery";

export const CrawlJob = z.object({
  id: z.string(), source_id: z.string(), board_id: z.string(),
  state: z.enum(["queued", "running", "succeeded", "blocked", "failed"]),
  added_count: z.number().int().nonnegative(), skipped_count: z.number().int().nonnegative(),
  error: z.string().nullable(), created_at: z.string(), finished_at: z.string().nullable(),
}).openapi("BoardCrawlJob");
export type Job = z.infer<typeof CrawlJob>;
type StoredJob = Job & { user_id: string; lease: string | null; lease_until: number; attempts: number };
const LEASE_MS = 180_000;
const DISPATCH_MS = 30_000;
const publicJob = (row: StoredJob): Job => CrawlJob.parse(row);

async function dispatch(env: Env, id: string): Promise<void> {
  if (!env.PREVIEW_QUEUE) throw new ApiError(503, "crawl_queue_unavailable");
  try { await env.PREVIEW_QUEUE.send({ kind: "crawl", id }); }
  catch {
    await env.DB.prepare("UPDATE board_crawl_jobs SET lease_until=0 WHERE id=? AND state='queued'").bind(id).run();
    throw new ApiError(503, "crawl_queue_unavailable");
  }
}

async function recover(env: Env, row: StoredJob): Promise<void> {
  if (!["queued", "running"].includes(row.state) || row.lease_until > Date.now()) return;
  if (row.attempts >= 3) {
    await env.DB.prepare("UPDATE board_crawl_jobs SET state='failed',error='crawl_failed',finished_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease_until<=?")
      .bind(new Date().toISOString(), row.id, Date.now()).run();
    return;
  }
  const claimed = await env.DB.prepare("UPDATE board_crawl_jobs SET state='queued',lease=NULL,lease_until=? WHERE id=? AND state IN ('queued','running') AND lease_until<=? RETURNING id")
    .bind(Date.now() + DISPATCH_MS, row.id, Date.now()).first();
  if (claimed) await dispatch(env, row.id);
}

export async function latestCrawl(env: Env, boardId: string, sourceId: string): Promise<Job | null> {
  const row = await env.DB.prepare("SELECT * FROM board_crawl_jobs WHERE board_id=? AND source_id=? ORDER BY created_at DESC,rowid DESC LIMIT 1")
    .bind(boardId, sourceId).first<StoredJob>();
  if (!row) return null;
  await recover(env, row);
  const current = await env.DB.prepare("SELECT * FROM board_crawl_jobs WHERE id=?").bind(row.id).first<StoredJob>();
  return current ? publicJob(current) : null;
}

export async function latestBoardCrawls(env: Env, boardId: string): Promise<Map<string, Job>> {
  const rows = await env.DB.prepare(`SELECT j.* FROM board_crawl_jobs j WHERE j.board_id=? AND j.id=(
    SELECT id FROM board_crawl_jobs WHERE source_id=j.source_id ORDER BY created_at DESC,rowid DESC LIMIT 1)`)
    .bind(boardId).all<StoredJob>();
  return new Map(rows.results.map(row => [row.source_id, publicJob(row)]));
}

export async function startCrawl(env: Env, boardId: string, sourceId: string, userId: string): Promise<Job> {
  const source = await env.DB.prepare("SELECT url FROM board_crawler_urls WHERE id=? AND board_id=?")
    .bind(sourceId, boardId).first<{ url: string }>();
  if (!source) throw new ApiError(404, "not_found");
  if (!crawlUrl(source.url)) throw new ApiError(400, "invalid_crawl_url");
  if (!env.PREVIEW_QUEUE) throw new ApiError(503, "crawl_queue_unavailable");
  const active = await env.DB.prepare("SELECT * FROM board_crawl_jobs WHERE source_id=? AND state IN ('queued','running')")
    .bind(sourceId).first<StoredJob>();
  if (active) {
    await recover(env, active);
    return (await latestCrawl(env, boardId, sourceId))!;
  }
  const id = randomUUID();
  const row = await env.DB.prepare(`INSERT INTO board_crawl_jobs(id,source_id,board_id,user_id,lease_until)
    SELECT ?,s.id,s.board_id,?,? FROM board_crawler_urls s JOIN boards b ON b.id=s.board_id
    WHERE s.id=? AND s.board_id=? AND b.user_id=? AND
      (SELECT COUNT(*) FROM board_crawl_jobs WHERE user_id=? AND created_at>=?)<100
    ON CONFLICT DO NOTHING RETURNING *`)
    .bind(id, userId, Date.now() + DISPATCH_MS, sourceId, boardId, userId, userId, new Date().toISOString().slice(0, 10)).first<StoredJob>();
  if (!row) {
    const concurrent = await env.DB.prepare("SELECT * FROM board_crawl_jobs WHERE source_id=? AND state IN ('queued','running')")
      .bind(sourceId).first<StoredJob>();
    if (concurrent) return publicJob(concurrent);
    throw new ApiError(429, "crawl_limit");
  }
  await dispatch(env, id);
  return publicJob(row);
}

async function saveArticle(env: Env, row: StoredJob, lease: string, article: Article, createdAt: string): Promise<void> {
  const id = randomUUID();
  const body = `${article.url}${article.summary ? `\n\n${article.summary.slice(0, Math.max(0, 1998 - article.url.length))}` : ""}`.trim();
  if (body.length > 2000) return;
  // The message, deduplication record and count commit together. A queue retry,
  // another source, or a simultaneous click cannot create a duplicate post.
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages(id,board_id,user_id,title,body,created_at)
      SELECT ?,j.board_id,j.user_id,?,?,? FROM board_crawl_jobs j
      JOIN board_crawler_urls s ON s.id=j.source_id JOIN boards b ON b.id=j.board_id
      WHERE j.id=? AND j.lease=? AND j.state='running' AND j.lease_until>? AND b.user_id=j.user_id
        AND NOT EXISTS(SELECT 1 FROM board_crawled_articles WHERE board_id=j.board_id AND url=?)`)
      .bind(id, article.title.slice(0, 200), body, createdAt, row.id, lease, Date.now(), article.url),
    env.DB.prepare(`INSERT INTO board_crawled_articles(board_id,url,source_id,message_id,published_at)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM messages WHERE id=?) ON CONFLICT DO NOTHING`)
      .bind(row.board_id, article.url, row.source_id, id, article.publishedAt, id),
    env.DB.prepare(`UPDATE board_crawl_jobs SET
      added_count=added_count+CASE WHEN EXISTS(SELECT 1 FROM board_crawled_articles WHERE message_id=?) THEN 1 ELSE 0 END,
      skipped_count=skipped_count+CASE WHEN EXISTS(SELECT 1 FROM board_crawled_articles WHERE message_id=?) THEN 0 ELSE 1 END
      WHERE id=? AND lease=?`).bind(id, id, row.id, lease),
  ]);
}

export async function consumeCrawls(batch: MessageBatch<unknown>, env: Env, discover = discoverArticles): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body as { kind?: unknown; id?: unknown } | null;
    if (payload?.kind !== "crawl" || typeof payload.id !== "string") { message.ack(); continue; }
    const lease = randomUUID();
    try {
      const row = await env.DB.prepare(`UPDATE board_crawl_jobs SET state='running',lease=?,lease_until=?,attempts=attempts+1
        WHERE id=? AND attempts<3 AND (state='queued' OR (state='running' AND lease_until<=?)) RETURNING *`)
        .bind(lease, Date.now() + LEASE_MS, payload.id, Date.now()).first<StoredJob>();
      if (!row) { message.ack(); continue; }
      const source = await env.DB.prepare("SELECT s.url FROM board_crawler_urls s JOIN boards b ON b.id=s.board_id WHERE s.id=? AND s.board_id=? AND b.user_id=?")
        .bind(row.source_id, row.board_id, row.user_id).first<{ url: string }>();
      if (!source) { message.ack(); continue; }
      try {
        const result = await discover(source.url, {
          seen: async url => Boolean(await env.DB.prepare("SELECT url FROM board_crawled_articles WHERE board_id=? AND url=?").bind(row.board_id, url).first()),
        });
        const articles = result.articles.slice().reverse();
        const now = Date.now();
        for (let index = 0; index < articles.length; index++) {
          await saveArticle(env, row, lease, articles[index], new Date(now - articles.length + index).toISOString());
        }
        await env.DB.prepare("UPDATE board_crawl_jobs SET state='succeeded',skipped_count=skipped_count+?,error=NULL,finished_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?")
          .bind(result.skipped, new Date().toISOString(), row.id, lease).run();
      } catch (error) {
        const code = error instanceof CrawlFailure ? error.message : error instanceof Error && /abort|timeout/i.test(error.name) ? "crawl_timeout" : "crawl_failed";
        console.warn("[crawler] job failed", { jobId: row.id, code });
        await env.DB.prepare("UPDATE board_crawl_jobs SET state=?,error=?,finished_at=?,lease=NULL,lease_until=0 WHERE id=? AND lease=?")
          .bind(code === "robots_blocked" ? "blocked" : "failed", code, new Date().toISOString(), row.id, lease).run();
      }
      message.ack();
    } catch (error) {
      console.error("[crawler] delivery will retry", { jobId: payload.id, error });
      message.retry({ delaySeconds: Math.ceil(LEASE_MS / 1000) });
    }
  }
}

export async function recoverCrawls(env: Env): Promise<void> {
  const rows = await env.DB.prepare("SELECT * FROM board_crawl_jobs WHERE state IN ('queued','running') AND lease_until<=? LIMIT 10")
    .bind(Date.now()).all<StoredJob>();
  for (const row of rows.results) {
    try { await recover(env, row); }
    catch (error) { console.warn("[crawler] recovery failed", { jobId: row.id, error }); }
  }
}
