import { Buffer } from "node:buffer";
import { createHash, randomUUID } from "node:crypto";
import { ApiError } from "./contracts";
import { checkPublicDns, defaultResolver, lookupPreview, PREVIEW_USER_AGENT, safePublicUrl, type DnsResolver } from "./preview-metadata";
import { failureDiagnostic, PreviewFailure, readPreviewDiagnostics, type PreviewDiagnostic } from "./preview-diagnostics";

export const PREVIEW_LIMITS = {
  cacheMs: 14 * 86_400_000, failureMs: 6 * 3_600_000, leaseMs: 120_000,
  timeoutMs: 25_000, imageBytes: 5 * 1024 * 1024, jobsPerDay: 100, userJobs: 1000,
} as const;

type PreviewRow = {
  id: string; user_id: string; url_hash: string; url: string; favicon: string | null;
  state: "pending" | "processing" | "ready" | "failed"; object_key: string | null;
  error: string | null; diagnostics: string | null; lease: string | null; lease_until: number; expires_at: number; created_at: number;
};

const objectPrefix = (id: string) => `previews/${id}/`;

function result(row: PreviewRow, origin: string) {
  const ready = row.state === "ready";
  const diagnostics = readPreviewDiagnostics(row.diagnostics);
  if (ready) delete diagnostics.screenshot;
  if (row.state === "failed" && !diagnostics.screenshot) {
    diagnostics.screenshot = failureDiagnostic(new Error(row.error ?? "preview_failed"), "preview_failed");
  }
  return {
    data: {
      image: ready ? `${origin}/preview-images/${row.id}.jpg` : row.favicon,
      source: ready ? "screenshot" as const : row.favicon ? "favicon" as const : "placeholder" as const,
      status: ready ? "ready" as const : row.state === "failed" ? "failed" as const : "pending" as const,
      previewId: row.id, statusUrl: `${origin}/previews/${row.id}`,
      ...(Object.keys(diagnostics).length ? { diagnostics } : {}),
      ...(row.state === "failed" ? { error: diagnostics.screenshot!.code } : {}),
    },
    status: row.state === "ready" || row.state === "failed" ? 200 as const : 202 as const,
  };
}

function logCacheHit(row: PreviewRow): void {
  const cached = result(row, "").data;
  console.info("[link-preview]", "cache hit", {
    previewId: row.id, state: row.state, diagnostics: cached.diagnostics, error: cached.error,
    expiresAt: row.expires_at, remainingTtlMs: Math.max(0, row.expires_at - Date.now()),
  });
}

async function dispatch(env: Env, id: string): Promise<void> {
  try {
    await env.PREVIEW_QUEUE.send({ id });
  } catch (error) {
    // A send can succeed even when its acknowledgement is lost. Consumer leases
    // make a later redelivery safe.
    await env.DB.prepare("UPDATE link_previews SET lease_until=0 WHERE id=? AND state='pending'").bind(id).run();
    console.warn("[link-preview]", "queue dispatch failed", { previewId: id, error });
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
    logCacheHit(row);
    return result(row, origin);
  }
  const metadata = await lookup(url.href);
  if (metadata.status === "ready") return { data: metadata, status: 200 as const };
  console.info("[link-preview]", "metadata fallback", { targetHost: url.hostname, diagnostics: metadata.diagnostics });
  if (!env.BROWSER || !env.PREVIEW_QUEUE || !env.BUCKET) throw new ApiError(503, "preview_unavailable");
  const id = randomUUID(), day = new Date(now).toISOString().slice(0, 10);
  const [inserted] = await env.DB.batch([
    env.DB.prepare(`INSERT INTO link_previews(id,user_id,url_hash,url,favicon,diagnostics,state,lease_until,expires_at,created_at)
      SELECT ?,?,?,?,?,?,'pending',?,?,? WHERE
        COALESCE((SELECT jobs FROM preview_daily_usage WHERE user_id=? AND day=?),0)<?
        AND (SELECT COUNT(*) FROM link_previews WHERE user_id=?)<?
      ON CONFLICT(user_id,url_hash) DO NOTHING`)
      .bind(id, userId, hash, url.href, metadata.image, JSON.stringify(metadata.diagnostics ?? {}),
        now + PREVIEW_LIMITS.leaseMs, now + PREVIEW_LIMITS.cacheMs, now,
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
  logCacheHit(row);
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

function unusableReason(content: string, meta: { status: number; title: string }): PreviewDiagnostic["code"] | null {
  if (meta.status < 200 || meta.status >= 300) return "preview_http_error";
  if (/just a moment|checking your browser|verify (?:you are|you're) human|captcha/i.test(meta.title)
    || /(?:id|class)\s*=\s*["'][^"']*(?:cf-chl-|g-recaptcha|h-captcha)/i.test(content)) return "preview_challenge";
  if (/access denied/i.test(meta.title)) return "preview_access_denied";
  if (/^\s*(?:log[ -]?in|sign[ -]?in)\b/i.test(meta.title)) return "preview_login_required";
  if (/page not found|^\s*(?:error|404|403)\b/i.test(meta.title)) return "preview_error_page";
  if (/(?:id|class)\s*=\s*["'][^"']*(?:onetrust-banner-sdk|CybotCookiebotDialog|cookie-consent-banner)/i.test(content)) return "preview_consent_overlay";
  const body = content.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, "").replace(/<!--[\s\S]*?-->/g, "");
  const visible = (/<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(body)?.[1] ?? body).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return visible.length >= 40 || /<(?:img|svg|canvas)\b/i.test(body) ? null : "preview_blank_page";
}

export function usablePreview(content: string, meta: { status: number; title: string }): boolean {
  return unusableReason(content, meta) === null;
}

async function withAbort<T>(pending: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort!: () => void;
  const aborted = new Promise<never>((_resolve, reject) => {
    abort = () => reject(new PreviewFailure("preview_timeout"));
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
  try { return await Promise.race([pending, aborted]); }
  finally { signal.removeEventListener("abort", abort); }
}

async function readSnapshot(response: Response, signal: AbortSignal): Promise<BrowserRunSnapshotSuccessResponse | BrowserRunErrorResponse | null> {
  const invalid = () => new PreviewFailure(response.ok ? "preview_invalid_snapshot" : "preview_browser_failed", { httpStatus: response.status });
  if (!response.body) throw invalid();
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await withAbort(reader.read(), signal);
      if (done) break;
      size += value.byteLength;
      if (size > 12 * 1024 * 1024) throw new PreviewFailure("preview_response_too_large", { httpStatus: response.status });
      chunks.push(value);
    }
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch { throw invalid(); }
  } catch (error) {
    if (error instanceof PreviewFailure) throw error;
    throw new PreviewFailure(failureDiagnostic(error, "preview_browser_failed", signal).code, { httpStatus: response.status });
  } finally {
    void reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export async function renderScreenshot(env: Env, value: string, resolver: DnsResolver = defaultResolver): Promise<Uint8Array> {
  const signal = AbortSignal.timeout(PREVIEW_LIMITS.timeoutMs);
  const publicTarget = async (value: string): Promise<void> => {
    const target = safePublicUrl(value);
    if (!target || !new RegExp(BROWSER_PUBLIC_PATTERN).test(target.href)) throw new PreviewFailure("preview_url_not_allowed");
    await checkPublicDns(target.hostname, resolver, signal);
  };
  try { await publicTarget(value); }
  catch (error) { throw new PreviewFailure(failureDiagnostic(error, "preview_dns_failed", signal).code); }
  let response: Response;
  try {
    const pending = env.BROWSER.quickAction("snapshot", {
      url: value, userAgent: PREVIEW_USER_AGENT, formats: ["content", "screenshot"], viewport: { width: 1200, height: 630 },
      screenshotOptions: { type: "jpeg", quality: 80, fullPage: false },
      gotoOptions: { timeout: 10_000, waitUntil: "networkidle2" }, actionTimeout: 10_000, waitForTimeout: 1000,
      allowRequestPattern: [BROWSER_PUBLIC_PATTERN], rejectResourceTypes: ["media", "websocket"], cacheTTL: 0,
    }).then(response => {
      if (signal.aborted) void response.body?.cancel().catch(() => {});
      return response;
    });
    response = await withAbort(pending, signal);
  }
  catch (error) {
    // Keep unexpected provider exceptions in Worker logs, not API responses.
    console.warn("[link-preview]", "browser exception", error);
    throw new PreviewFailure(failureDiagnostic(error, "preview_browser_failed", signal).code);
  }
  const snapshot = await readSnapshot(response, signal);
  if (!response.ok || snapshot?.success !== true) {
    const errors = snapshot && "errors" in snapshot && Array.isArray(snapshot.errors) ? snapshot.errors : [];
    const providerError = errors.find(error => error && typeof error.message === "string");
    console.warn("[link-preview]", "browser service failed", { httpStatus: response.status,
      errors: errors.slice(0, 3).map(error => ({ code: error?.code,
        message: typeof error?.message === "string" ? error.message.slice(0, 500) : undefined })) });
    const fallback = response.ok && snapshot?.success !== false ? "preview_invalid_snapshot" : "preview_browser_failed";
    const reason = failureDiagnostic(new Error(providerError?.message ?? ""), fallback).code;
    throw new PreviewFailure(reason, { httpStatus: response.status,
      ...(typeof providerError?.code === "number" ? { providerCode: providerError.code } : {}) });
  }
  if (typeof snapshot.result?.content !== "string" || typeof snapshot.result.screenshot !== "string"
    || !snapshot.meta || typeof snapshot.meta.status !== "number" || typeof snapshot.meta.title !== "string") {
    throw new PreviewFailure("preview_invalid_snapshot", { httpStatus: response.status });
  }
  const rejected = unusableReason(snapshot.result.content, snapshot.meta);
  if (rejected) throw new PreviewFailure(rejected, { httpStatus: snapshot.meta.status });
  if (snapshot.meta.finalUrl) await publicTarget(snapshot.meta.finalUrl);
  for (const hop of snapshot.meta.redirectChain ?? []) await publicTarget(hop.url);
  const bytes = Buffer.from(snapshot.result.screenshot, "base64");
  if (bytes.length < 1000 || bytes.length > PREVIEW_LIMITS.imageBytes || bytes[0] !== 0xff || bytes[1] !== 0xd8
    || bytes.at(-2) !== 0xff || bytes.at(-1) !== 0xd9) throw new PreviewFailure("preview_invalid_image");
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
      let failureStage: "render" | "storage" = "render";
      const startedAt = Date.now();
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
        failureStage = "storage";
        await env.BUCKET.put(key, bytes, { httpMetadata: { contentType: "image/jpeg" } });
        const diagnostics = readPreviewDiagnostics(row.diagnostics);
        delete diagnostics.screenshot;
        const saved = await env.DB.prepare(`UPDATE link_previews SET state='ready',object_key=?,error=NULL,diagnostics=?,expires_at=?,lease=NULL,lease_until=0
          WHERE id=? AND lease=? AND lease_until>? AND EXISTS(SELECT 1 FROM users WHERE id=link_previews.user_id)`)
          .bind(key, JSON.stringify(diagnostics), Date.now() + PREVIEW_LIMITS.cacheMs, id, lease, Date.now()).run();
        if (!saved.meta.changes) await env.BUCKET.delete(key);
        message.ack();
      } catch (error) {
        const diagnostic = failureDiagnostic(error, failureStage === "storage" ? "preview_storage_failed" : "preview_failed");
        const diagnostics = { ...readPreviewDiagnostics(row.diagnostics), screenshot: diagnostic };
        console.warn("[link-preview]", "screenshot failed", { previewId: id, targetHost: safePublicUrl(row.url)?.hostname,
          elapsedMs: Date.now() - startedAt, diagnostics, error });
        const saved = await env.DB.prepare(`UPDATE link_previews SET state='failed',error=?,diagnostics=?,expires_at=?,lease=NULL,lease_until=0
          WHERE id=? AND lease=?`).bind(diagnostic.code, JSON.stringify(diagnostics), Date.now() + PREVIEW_LIMITS.failureMs, id, lease).run();
        if (saved.meta.changes) await env.BUCKET.delete(key);
        message.ack();
      }
    } catch (error) {
      console.error("[link-preview]", "queue delivery will retry", { previewId: id, error });
      message.retry({ delaySeconds: Math.ceil(PREVIEW_LIMITS.leaseMs / 1000) });
    }
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
