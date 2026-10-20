import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./contracts";
import { checkPublicDns, defaultResolver, lookupPreview, safePublicUrl, type DnsResolver } from "./preview-metadata";

export const PREVIEW_LIMITS = {
  cacheMs: 14 * 86_400_000, failureMs: 6 * 3_600_000, leaseMs: 120_000,
  timeoutMs: 25_000, imageBytes: 5 * 1024 * 1024, jobsPerDay: 100, userJobs: 1000,
} as const;

type PreviewRow = {
  id: string; user_id: string; url_hash: string; url: string; favicon: string | null;
  state: "pending" | "processing" | "ready" | "failed"; object_key: string | null;
  error: string | null; lease: string | null; lease_until: number; expires_at: number; created_at: number;
};

const objectPrefix = (id: string) => `previews/${id}/`;

function result(row: PreviewRow, origin: string) {
  const ready = row.state === "ready";
  return {
    data: {
      image: ready ? `${origin}/preview-images/${row.id}.jpg` : row.favicon,
      source: ready ? "screenshot" as const : row.favicon ? "favicon" as const : "placeholder" as const,
      status: ready ? "ready" as const : row.state === "failed" ? "failed" as const : "pending" as const,
      previewId: row.id, statusUrl: `${origin}/previews/${row.id}`,
    },
    status: row.state === "ready" || row.state === "failed" ? 200 as const : 202 as const,
  };
}

async function dispatch(env: Env, id: string): Promise<void> {
  try {
    await env.PREVIEW_QUEUE.send({ id });
  } catch {
    // A send can succeed even when its acknowledgement is lost. Consumer leases
    // make a later redelivery safe.
    await env.DB.prepare("UPDATE link_previews SET lease_until=0 WHERE id=? AND state='pending'").bind(id).run();
    throw new ApiError(503, "preview_queue_unavailable");
  }
}

async function recoverDispatch(env: Env, row: PreviewRow): Promise<void> {
  if (!["pending", "processing"].includes(row.state) || row.lease_until > Date.now()) return;
  if (!env.PREVIEW_QUEUE) throw new ApiError(503, "preview_queue_unavailable");
  const claimed = await env.DB.prepare(`UPDATE link_previews SET state='pending',lease=NULL,lease_until=?
    WHERE id=? AND lease_until<=? AND state IN ('pending','processing') RETURNING id`)
    .bind(Date.now() + PREVIEW_LIMITS.leaseMs, row.id, Date.now()).first();
  if (claimed) await dispatch(env, row.id);
}

async function deleteImages(env: Env, id: string): Promise<void> {
  // Include uploads whose acknowledgement was lost before the ready state saved.
  let cursor: string | undefined;
  do {
    const page = await env.BUCKET.list({ prefix: objectPrefix(id), cursor });
    if (page.objects.length) await env.BUCKET.delete(page.objects.map(object => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export async function requestPreview(
  env: Env, userId: string, value: string, origin: string, lookup = lookupPreview,
) {
  const url = safePublicUrl(value);
  if (!url) throw new ApiError(400, "invalid_request");
  const hash = createHash("sha256").update(url.href).digest("hex"), now = Date.now();
  let row = await env.DB.prepare("SELECT * FROM link_previews WHERE user_id=? AND url_hash=?")
    .bind(userId, hash).first<PreviewRow>();
  if (row && row.expires_at <= now && row.lease_until <= now) {
    await deleteImages(env, row.id);
    await env.DB.prepare("DELETE FROM link_previews WHERE id=? AND expires_at<=? AND lease_until<=?")
      .bind(row.id, now, now).run();
    row = null;
  }
  if (row) {
    await recoverDispatch(env, row);
    return result(row, origin);
  }
  const metadata = await lookup(url.href);
  if (metadata.status === "ready") return { data: metadata, status: 200 as const };
  if (!env.BROWSER || !env.PREVIEW_QUEUE || !env.BUCKET) throw new ApiError(503, "preview_unavailable");
  const id = randomUUID(), day = new Date(now).toISOString().slice(0, 10);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO link_previews(id,user_id,url_hash,url,favicon,state,lease_until,expires_at,created_at)
      SELECT ?,?,?,?,?,'pending',?,?,? WHERE
        COALESCE((SELECT jobs FROM preview_daily_usage WHERE user_id=? AND day=?),0)<?
        AND (SELECT COUNT(*) FROM link_previews WHERE user_id=?)<?
      ON CONFLICT(user_id,url_hash) DO NOTHING`)
      .bind(id, userId, hash, url.href, metadata.image, now + PREVIEW_LIMITS.leaseMs, now + PREVIEW_LIMITS.cacheMs, now,
        userId, day, PREVIEW_LIMITS.jobsPerDay, userId, PREVIEW_LIMITS.userJobs),
    env.DB.prepare(`INSERT INTO preview_daily_usage(user_id,day,jobs)
      SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM link_previews WHERE id=?)
      ON CONFLICT(user_id,day) DO UPDATE SET jobs=jobs+1`).bind(userId, day, id),
  ]);
  row = await env.DB.prepare("SELECT * FROM link_previews WHERE user_id=? AND url_hash=?")
    .bind(userId, hash).first<PreviewRow>();
  if (!row) throw new ApiError(429, "preview_limit");
  if (inserted.meta.changes) await dispatch(env, row.id);
  else await recoverDispatch(env, row);
  return result(row, origin);
}

export async function previewStatus(env: Env, userId: string, id: string, origin: string) {
  const row = await env.DB.prepare("SELECT * FROM link_previews WHERE id=? AND user_id=? AND expires_at>?")
    .bind(id, userId, Date.now()).first<PreviewRow>();
  if (!row) throw new ApiError(404, "not_found");
  await recoverDispatch(env, row);
  return result(row, origin);
}

export async function previewImage(request: Request, env: Env, id: string): Promise<Response> {
  const row = await env.DB.prepare(`SELECT v.* FROM link_previews v JOIN users u ON u.id=v.user_id
    WHERE v.id=? AND v.state='ready' AND v.expires_at>?`).bind(id, Date.now()).first<PreviewRow>();
  if (!row?.object_key || !env.BUCKET) throw new ApiError(404, "not_found");
  const object = request.method === "HEAD" ? await env.BUCKET.head(row.object_key) : await env.BUCKET.get(row.object_key);
  if (!object) throw new ApiError(404, "not_found");
  return new Response(request.method === "HEAD" ? null : (object as R2ObjectBody).body, { headers: {
    "content-type": "image/jpeg", "content-length": String(object.size), etag: object.httpEtag,
    "cache-control": `public, max-age=${Math.max(0, Math.min(3600, Math.floor((row.expires_at - Date.now()) / 1000)))}`,
    "x-content-type-options": "nosniff", "access-control-allow-origin": "*",
  } });
}

// The browser applies this filter to redirects and subresources as well. Only
// public DNS names are allowed: no IP literals, credentials, or custom ports.
export const BROWSER_PUBLIC_PATTERN = "^https?://(?!(?:[^/]+\\.)?(?:localhost|local|internal|lan|home|corp|onion|invalid|arpa|test|example)(?:[/:]|$))(?:[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?\\.)+[a-zA-Z][a-zA-Z0-9-]*(?:/|$)";

export function usablePreview(content: string, meta: { status: number; title: string }): boolean {
  if (meta.status < 200 || meta.status >= 300) return false;
  if (/just a moment|checking your browser|verify (?:you are|you're) human|access denied|captcha|page not found|^\s*(?:error|404|403|log[ -]?in|sign[ -]?in)\b/i.test(meta.title)) return false;
  if (/(?:id|class)\s*=\s*["'][^"']*(?:cf-chl-|g-recaptcha|h-captcha|onetrust-banner-sdk|CybotCookiebotDialog|cookie-consent-banner)/i.test(content)) return false;
  const body = content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const visible = (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return visible.length >= 40 || /<(?:img|svg|canvas)\b/i.test(body);
}

async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new Error("preview_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function readSnapshot(response: Response, signal: AbortSignal): Promise<BrowserRunSnapshotSuccessResponse> {
  if (!response.body) throw new Error("preview_browser_failed");
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) throw new Error("preview_response_too_large");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8")) as BrowserRunSnapshotSuccessResponse;
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function renderScreenshot(env: Env, value: string, resolver: DnsResolver = defaultResolver): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(PREVIEW_LIMITS.timeoutMs);
  const publicTarget = async (value: string): Promise<void> => {
    const target = safePublicUrl(value);
    if (!target || !new RegExp(BROWSER_PUBLIC_PATTERN).test(target.href)) throw new Error("preview_url_not_allowed");
    await checkPublicDns(target.hostname, resolver, signal);
  };
  await publicTarget(value);
  const pending = env.BROWSER.quickAction("snapshot", {
    url: value, formats: ["content", "screenshot"], viewport: { width: 1200, height: 630 },
    screenshotOptions: { type: "jpeg", quality: 80, fullPage: false },
    gotoOptions: { timeout: 10_000, waitUntil: "networkidle2" }, actionTimeout: 10_000, waitForTimeout: 1000,
    allowRequestPattern: [BROWSER_PUBLIC_PATTERN], rejectResourceTypes: ["media", "websocket"], cacheTTL: 0,
  }).then(response => {
    if (signal.aborted) void response.body?.cancel().catch(() => {});
    return response;
  });
  const response = await withAbort(pending, signal);
  if (!response.ok) {
    void response.body?.cancel().catch(() => {});
    throw new Error("preview_browser_failed");
  }
  const snapshot = await readSnapshot(response, signal);
  if (!snapshot?.success || typeof snapshot.result?.content !== "string" || typeof snapshot.result.screenshot !== "string"
    || !snapshot.meta || typeof snapshot.meta.status !== "number" || typeof snapshot.meta.title !== "string"
    || !usablePreview(snapshot.result.content, snapshot.meta)) throw new Error("preview_unusable");
  if (snapshot.meta.finalUrl) await publicTarget(snapshot.meta.finalUrl);
  for (const hop of snapshot.meta.redirectChain ?? []) await publicTarget(hop.url);
  const bytes = Buffer.from(snapshot.result.screenshot, "base64");
  if (bytes.length < 1000 || bytes.length > PREVIEW_LIMITS.imageBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new Error("preview_invalid_image");
  return bytes;
}

export async function consumePreviews(batch: MessageBatch<unknown>, env: Env, render = renderScreenshot): Promise<void> {
  for (const message of batch.messages) {
    const payload = message.body;
    const id = payload && typeof payload === "object" && "id" in payload ? payload.id : null;
    if (typeof id !== "string") { message.ack(); continue; }
    const lease = randomUUID(), now = Date.now();
    try {
      const row = await env.DB.prepare(`UPDATE link_previews SET state='processing',lease=?,lease_until=?
        WHERE id=? AND expires_at>? AND (state='pending' OR (state='processing' AND lease_until<=?)) RETURNING *`)
        .bind(lease, now + PREVIEW_LIMITS.leaseMs, id, now, now).first<PreviewRow>();
      if (!row) { message.ack(); continue; }
      const key = `${objectPrefix(id)}${lease}.jpg`;
      try {
        const assertWritable = async () => {
          const active = await env.DB.prepare(`SELECT v.id FROM link_previews v JOIN users u ON u.id=v.user_id
            WHERE v.id=? AND v.lease=? AND v.state='processing' AND v.lease_until>? AND v.expires_at>?`)
            .bind(id, lease, Date.now(), Date.now()).first();
          if (!active) throw new Error("preview_lease_lost");
        };
        await assertWritable();
        const bytes = await render(env, row.url);
        await assertWritable();
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        const saved = await env.DB.prepare(`UPDATE link_previews SET state='ready',object_key=?,expires_at=?,lease=NULL,lease_until=0
          WHERE id=? AND lease=? AND lease_until>? AND EXISTS(SELECT 1 FROM users WHERE id=link_previews.user_id)`)
          .bind(key, Date.now() + PREVIEW_LIMITS.cacheMs, id, lease, Date.now()).run();
        if (!saved.meta.changes) await env.BUCKET.delete(key);
        message.ack();
      } catch (error) {
        const code = error instanceof Error && /^preview_[a-z_]+$/.test(error.message) ? error.message : "preview_failed";
        const saved = await env.DB.prepare(`UPDATE link_previews SET state='failed',error=?,expires_at=?,lease=NULL,lease_until=0
          WHERE id=? AND lease=?`).bind(code, Date.now() + PREVIEW_LIMITS.failureMs, id, lease).run();
        if (saved.meta.changes) await env.BUCKET.delete(key);
        message.ack();
      }
    } catch { message.retry({ delaySeconds: Math.ceil(PREVIEW_LIMITS.leaseMs / 1000) }); }
  }
}

export async function cleanupPreviews(env: Env): Promise<void> {
  if (!env.BUCKET) return;
  const rows = await env.DB.prepare(`SELECT v.* FROM link_previews v LEFT JOIN users u ON u.id=v.user_id
    WHERE (v.expires_at<=? OR u.id IS NULL) AND v.lease_until<=? LIMIT 50`)
    .bind(Date.now(), Date.now()).all<PreviewRow>();
  for (const row of rows.results) {
    await deleteImages(env, row.id);
    await env.DB.prepare("DELETE FROM link_previews WHERE id=? AND lease_until<=?").bind(row.id, Date.now()).run();
  }
  await env.DB.prepare("DELETE FROM preview_daily_usage WHERE day<?").bind(new Date().toISOString().slice(0, 10)).run();
}
