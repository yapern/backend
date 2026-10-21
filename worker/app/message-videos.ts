import { Buffer } from "node:buffer";
import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "@hono/zod-openapi";
import { errorResult, jsonContent, jsonResult, registerRoute, type Api } from "../shared/openapi";
import { requireSession } from "./auth";
import { ApiError, protectedSecurity } from "./contracts";

export const VIDEO_LIMITS = {
  bytes: 100 * 1024 * 1024, seconds: 120, uploadsPerDay: 20, pendingPerUser: 3,
  uploadMs: 30 * 60_000, abandonedMs: 24 * 3_600_000, processingMs: 3_600_000,
  refreshMs: 15_000, requestMs: 8_000,
} as const;
const uidPattern = /^[a-f0-9]{32}$/;
const params = z.object({ id: z.uuid() });
type VideoRow = {
  id: string; user_id: string; board_id: string; message_id: string | null; stream_uid: string | null;
  state: "uploading" | "processing" | "ready" | "failed" | "deleting";
  size_bytes: number; stream_origin: string | null; duration: number | null;
  width: number | null; height: number | null; error: string | null;
  upload_expires_at: number; created_at: number; checked_at: number;
};
export const MessageVideo = z.object({
  id: z.string(), status: z.enum(["uploading", "processing", "ready", "failed"]),
  duration: z.number().nullable(), width: z.number().nullable(), height: z.number().nullable(),
  watch_url: z.string().nullable(), playback_url: z.string().nullable(), player_url: z.string().nullable(), thumbnail_url: z.string().nullable(),
  error: z.string().nullable(),
}).openapi("MessageVideo");

const providerVideo = z.object({
  uid: z.string().regex(uidPattern), readyToStream: z.boolean().optional(),
  status: z.object({ state: z.string(), errorReasonCode: z.string().optional(), errReasonCode: z.string().optional() }),
  size: z.number().nonnegative().optional(), duration: z.number().nonnegative().optional(),
  input: z.object({ width: z.number().positive(), height: z.number().positive() }).optional(),
  playback: z.object({ hls: z.string().optional() }).optional(),
});

function hasRestConfig(env: Env) {
  return !!env.STREAM_ACCOUNT_ID && /^[a-f0-9]{32}$/.test(env.STREAM_ACCOUNT_ID) && !!env.STREAM_API_TOKEN;
}

function config(env: Env) {
  if (!hasRestConfig(env)) {
    throw new ApiError(503, "video_uploads_unavailable");
  }
  return { url: `https://api.cloudflare.com/client/v4/accounts/${env.STREAM_ACCOUNT_ID}/stream`, token: env.STREAM_API_TOKEN };
}

function assertConfigured(env: Env) {
  if (!env.STREAM && !hasRestConfig(env)) throw new ApiError(503, "video_uploads_unavailable");
}

async function streamRequest(env: Env, path: string, init: RequestInit = {}) {
  const { url, token } = config(env);
  try {
    return await fetch(`${url}${path}`, {
      ...init, headers: { ...init.headers, authorization: `Bearer ${token}` },
      redirect: "error", signal: AbortSignal.timeout(VIDEO_LIMITS.requestMs),
    });
  } catch { throw new ApiError(502, "video_service_unavailable"); }
}

function isStreamNotFound(error: unknown): boolean {
  return !!error && typeof error === "object" && "statusCode" in error && error.statusCode === 404;
}

function normalizeBoundVideo(video: StreamVideo) {
  return {
    uid: video.id,
    status: { state: video.status.state, errorReasonCode: video.status.errorReasonCode || undefined },
    readyToStream: video.readyToStream,
    ...(video.size > 0 ? { size: video.size } : {}),
    ...(video.duration >= 0 ? { duration: video.duration } : {}),
    ...(video.input.width > 0 && video.input.height > 0 ? { input: video.input } : {}),
    ...(video.hlsPlaybackUrl ? { playback: { hls: video.hlsPlaybackUrl } } : {}),
  };
}

async function directUpload(env: Env, options: StreamDirectUploadCreateParams, sizeBytes: number) {
  if (env.STREAM) {
    try { return { ...await env.STREAM.createDirectUpload(options), upload_protocol: "multipart" as const }; }
    catch { throw new ApiError(502, "video_service_unavailable"); }
  }
  const metadata = {
    maxDurationSeconds: String(options.maxDurationSeconds),
    expiry: options.expiry!,
    name: options.meta!.name,
  };
  const response = await streamRequest(env, "?direct_user=true", { method: "POST", headers: {
    "tus-resumable": "1.0.0", "upload-length": String(sizeBytes),
    "upload-creator": options.creator!,
    "upload-metadata": Object.entries(metadata).map(([key, value]) => `${key} ${Buffer.from(value).toString("base64")}`).join(","),
  } });
  const uid = response.headers.get("stream-media-id"), location = response.headers.get("location");
  if (!response.ok || !uid || !uidPattern.test(uid) || !location) throw new ApiError(502, "video_service_unavailable");
  return { id: uid, uploadURL: location, upload_protocol: "tus" as const };
}

function videoResult(row: VideoRow): z.infer<typeof MessageVideo> {
  const base = row.stream_uid && row.stream_origin ? `${row.stream_origin}/${row.stream_uid}` : null;
  const ready = row.state === "ready" && base;
  return {
    id: row.id, status: row.state === "deleting" ? "failed" : row.state,
    duration: row.duration, width: row.width, height: row.height,
    watch_url: base ? `${base}/watch` : null,
    playback_url: ready ? `${base}/manifest/video.m3u8` : null,
    player_url: ready ? `${base}/iframe` : null,
    thumbnail_url: ready ? `${base}/thumbnails/thumbnail.jpg` : null,
    error: row.error,
  };
}

export async function messageVideos(env: Env, messageIds: string[]) {
  if (!messageIds.length) return new Map<string, z.infer<typeof MessageVideo>>();
  const rows = await env.DB.prepare(`SELECT * FROM message_videos WHERE message_id IN (${messageIds.map(() => "?").join(",")}) AND state<>'deleting'`)
    .bind(...messageIds).all<VideoRow>();
  return new Map(rows.results.map(row => [row.message_id!, videoResult(row)]));
}

async function findVideo(env: Env, id: string) {
  return env.DB.prepare("SELECT * FROM message_videos WHERE id=?").bind(id).first<VideoRow>();
}

function playbackOrigin(hls: string | undefined, uid: string): string | null {
  if (!hls) return null;
  try {
    const url = new URL(hls);
    if (url.protocol === "https:" && !url.username && !url.password && !url.port &&
      /^(?:customer-[a-z0-9-]+\.cloudflarestream\.com|videodelivery\.net)$/.test(url.hostname) &&
      url.pathname === `/${uid}/manifest/video.m3u8` && !url.search && !url.hash) return url.origin;
  } catch {}
  return null;
}

async function applyProviderVideo(env: Env, row: VideoRow, value: unknown) {
  const parsed = providerVideo.safeParse(value);
  if (!parsed.success || parsed.data.uid !== row.stream_uid) throw new ApiError(502, "invalid_video_response");
  const video = parsed.data;
  let state: VideoRow["state"] = ["pendingupload", "downloading"].includes(video.status.state) ? "uploading" : "processing";
  let error: string | null = null;
  const origin = playbackOrigin(video.playback?.hls, video.uid);
  if (video.status.state === "error") { state = "failed"; error = "video_processing_failed"; }
  if ((video.duration ?? 0) > VIDEO_LIMITS.seconds || (video.size ?? 0) > VIDEO_LIMITS.bytes) {
    state = "failed"; error = "video_limit_exceeded";
  }
  if (state !== "failed" && video.readyToStream && origin && video.input && video.duration && video.duration > 0) state = "ready";
  // Terminal states cannot be revived by late/repeated webhooks or an in-flight poll.
  await env.DB.prepare(`UPDATE message_videos SET state=CASE WHEN state='processing' AND ?='uploading' THEN state ELSE ? END,
    stream_origin=COALESCE(?,stream_origin),duration=COALESCE(?,duration),width=COALESCE(?,width),height=COALESCE(?,height),error=?
    WHERE id=? AND stream_uid=? AND state IN ('uploading','processing')`)
    .bind(state, state, origin, video.duration ?? null, video.input?.width ?? null, video.input?.height ?? null,
      error, row.id, row.stream_uid).run();
}

async function refreshVideo(env: Env, row: VideoRow, force = false) {
  if (!row.stream_uid || !["uploading", "processing"].includes(row.state)) return;
  const claim = await env.DB.prepare(`UPDATE message_videos SET checked_at=? WHERE id=? AND checked_at<=?
    AND state IN ('uploading','processing') RETURNING id`)
    .bind(Date.now(), row.id, Date.now() - (force ? 0 : VIDEO_LIMITS.refreshMs)).first();
  if (!claim) return;
  if (env.STREAM) {
    let video: StreamVideo;
    try { video = await env.STREAM.video(row.stream_uid).details(); }
    catch (error) {
      if (isStreamNotFound(error)) {
        await env.DB.prepare("UPDATE message_videos SET state='failed',error='video_unavailable',stream_uid=NULL WHERE id=? AND state IN ('uploading','processing')")
          .bind(row.id).run();
        return;
      }
      throw new ApiError(502, "video_service_unavailable");
    }
    await applyProviderVideo(env, row, normalizeBoundVideo(video));
    return;
  }
  const response = await streamRequest(env, `/${row.stream_uid}`);
  if (response.status === 404) {
    await env.DB.prepare("UPDATE message_videos SET state='failed',error='video_unavailable',stream_uid=NULL WHERE id=? AND state IN ('uploading','processing')")
      .bind(row.id).run();
    return;
  }
  if (!response.ok) throw new ApiError(502, "video_service_unavailable");
  const payload = await response.json() as { success?: boolean; result?: unknown };
  if (!payload.success) throw new ApiError(502, "invalid_video_response");
  await applyProviderVideo(env, row, payload.result);
}

export async function deleteVideoAsset(env: Env, id: string): Promise<void> {
  const row = await findVideo(env, id);
  if (!row || !["deleting", "failed"].includes(row.state)) return;
  try {
    if (row.stream_uid) {
      if (env.STREAM) {
        try { await env.STREAM.video(row.stream_uid).delete(); }
        catch (error) { if (!isStreamNotFound(error)) throw error; }
      } else {
        const response = await streamRequest(env, `/${row.stream_uid}`, { method: "DELETE" });
        if (!response.ok && response.status !== 404) throw new ApiError(502, "video_service_unavailable");
      }
    }
    if (row.state === "deleting") await env.DB.prepare("DELETE FROM message_videos WHERE id=? AND state='deleting'").bind(id).run();
    else await env.DB.prepare("UPDATE message_videos SET stream_uid=NULL WHERE id=? AND state='failed'").bind(id).run();
  } catch {
    // Keep the durable row for scheduled retries after an already-committed deletion.
    console.warn("video_cleanup_pending", { id });
  }
}

export async function createVideoMessage(env: Env, userId: string, input: { attachment_id: string; board_id: string; title: string; body: string }) {
  const row = await findVideo(env, input.attachment_id);
  if (!row || row.user_id !== userId || row.board_id !== input.board_id || !row.stream_uid || !row.stream_origin ||
    !["processing", "ready"].includes(row.state)) throw new ApiError(409, "video_not_ready");
  // Preserve the existing body-link contract for older clients and video-only posts.
  const body = `${row.stream_origin}/${row.stream_uid}/watch${input.body ? `\n${input.body}` : ""}`;
  if (body.length > 2000) throw new ApiError(400, "invalid_request");
  if (row.message_id) {
    const existing = await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(row.message_id).first();
    if (existing?.title !== input.title || existing?.body !== body) throw new ApiError(409, "video_already_attached");
    return { ...existing, video: videoResult(row) };
  }
  const messageId = randomUUID();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO messages(id,board_id,user_id,title,body)
      SELECT ?,?,?,?,? WHERE EXISTS(SELECT 1 FROM message_videos WHERE id=? AND user_id=? AND board_id=?
        AND message_id IS NULL AND state IN ('processing','ready') AND created_at>?)`)
      .bind(messageId, input.board_id, userId, input.title, body, row.id, userId, input.board_id, Date.now() - VIDEO_LIMITS.abandonedMs),
    env.DB.prepare(`UPDATE message_videos SET message_id=? WHERE id=? AND message_id IS NULL
      AND EXISTS(SELECT 1 FROM messages WHERE id=?)`).bind(messageId, row.id, messageId),
  ]);
  const current = await findVideo(env, row.id);
  const message = current?.message_id ? await env.DB.prepare("SELECT * FROM messages WHERE id=?").bind(current.message_id).first() : null;
  if (!message || message.title !== input.title || message.body !== body) throw new ApiError(409, "video_not_ready");
  return { ...message, video: videoResult(current!) };
}

export async function maintainVideos(env: Env): Promise<void> {
  if (!env.STREAM && !hasRestConfig(env)) return;
  const now = Date.now();
  await env.DB.prepare(`UPDATE message_videos SET state='deleting' WHERE message_id IS NULL AND created_at<?`)
    .bind(now - VIDEO_LIMITS.abandonedMs).run();
  await env.DB.prepare(`UPDATE message_videos SET state='failed',error='video_processing_timed_out'
    WHERE state IN ('uploading','processing') AND created_at<? AND message_id IS NOT NULL`)
    .bind(now - VIDEO_LIMITS.processingMs).run();
  const jobs = await env.DB.prepare(`SELECT * FROM message_videos
    WHERE state IN ('uploading','processing','deleting') OR (state='failed' AND stream_uid IS NOT NULL)
    ORDER BY checked_at,id LIMIT 10`).all<VideoRow>();
  for (const row of jobs.results) {
    try {
      await env.DB.prepare("UPDATE message_videos SET checked_at=? WHERE id=?").bind(now, row.id).run();
      if (["deleting", "failed"].includes(row.state)) await deleteVideoAsset(env, row.id);
      else await refreshVideo(env, row, true);
    } catch { console.warn("video_reconciliation_pending", { id: row.id }); }
  }
  await env.DB.prepare("DELETE FROM video_daily_usage WHERE day<?")
    .bind(new Date(now - 7 * 86_400_000).toISOString().slice(0, 10)).run();
}

export function registerVideoRoutes(app: Api): void {
  const errors = {
    400: errorResult("Invalid upload metadata (invalid_request)."), 401: errorResult("Sign in to manage an upload."),
    404: errorResult("The video or board is unavailable (not_found)."), 409: errorResult("The upload cannot be changed."),
    429: errorResult("The daily or pending upload limit has been reached (video_upload_limit)."),
    502: errorResult("Cloudflare Stream is unavailable (video_service_unavailable)."),
    503: errorResult("Stream is not configured (video_uploads_unavailable)."),
  };
  const uploadInput = z.object({
    board_id: z.string().min(1).max(512), size_bytes: z.number().int().min(1).max(VIDEO_LIMITS.bytes),
  }).strict().openapi("CreateVideoUpload");
  registerRoute(app, {
    method: "post", path: "/videos", operationId: "createVideoUpload", tags: ["Messages"],
    summary: "Reserve a direct video upload", security: protectedSecurity,
    description: "Returns a one-time direct upload URL and protocol. Upload bytes directly to Stream, then POST /videos/{id}/complete. Maximum 100 MiB, 120 seconds, 20 reservations per UTC day and 3 pending uploads per user. Videos in public messages are public. Never send the application bearer token to the upload URL.",
    request: { body: { required: true, content: jsonContent(uploadInput) } },
    responses: { ...errors, 201: jsonResult(z.object({ data: z.object({ id: z.string(), upload_url: z.string(), upload_protocol: z.enum(["multipart", "tus"]), expires_at: z.string(), max_duration_seconds: z.number() }) }), "Upload reserved.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const input = uploadInput.parse(await c.req.json());
    assertConfigured(c.env);
    if (!await c.env.DB.prepare("SELECT id FROM boards WHERE id=?").bind(input.board_id).first()) throw new ApiError(404, "not_found");
    const id = randomUUID(), now = Date.now(), expires = now + VIDEO_LIMITS.uploadMs, day = new Date(now).toISOString().slice(0, 10);
    const [insert] = await c.env.DB.batch([
      c.env.DB.prepare(`INSERT INTO message_videos(id,user_id,board_id,state,size_bytes,upload_expires_at,created_at)
        SELECT ?,?,?,'uploading',?,?,? WHERE
          COALESCE((SELECT uploads FROM video_daily_usage WHERE user_id=? AND day=?),0)<? AND
          (SELECT COUNT(*) FROM message_videos WHERE user_id=? AND state IN ('uploading','processing') AND message_id IS NULL AND upload_expires_at>?)<?`)
        .bind(id, session.user_id, input.board_id, input.size_bytes, expires, now,
          session.user_id, day, VIDEO_LIMITS.uploadsPerDay, session.user_id, now, VIDEO_LIMITS.pendingPerUser),
      c.env.DB.prepare(`INSERT INTO video_daily_usage(user_id,day,uploads) SELECT ?,?,1 WHERE EXISTS(SELECT 1 FROM message_videos WHERE id=?)
        ON CONFLICT(user_id,day) DO UPDATE SET uploads=uploads+1`).bind(session.user_id, day, id),
    ]);
    if (!insert.meta.changes) throw new ApiError(429, "video_upload_limit");
    try {
      const upload = await directUpload(c.env, {
        maxDurationSeconds: VIDEO_LIMITS.seconds, expiry: new Date(expires).toISOString(),
        creator: session.user_id, meta: { name: id },
      }, input.size_bytes);
      const uid = upload.id;
      if (!uid || !uidPattern.test(uid)) throw new ApiError(502, "video_service_unavailable");
      // Record the identity before parsing the location so invalid responses can still be cleaned up.
      await c.env.DB.prepare("UPDATE message_videos SET stream_uid=? WHERE id=?").bind(uid, id).run();
      const url = new URL(upload.uploadURL);
      if (url.protocol !== "https:" || !["upload.cloudflarestream.com", "upload.videodelivery.net"].includes(url.hostname) ||
        url.username || url.password || url.port || url.hash) {
        throw new ApiError(502, "invalid_video_response");
      }
      return c.json({ data: { id, upload_url: url.href, upload_protocol: upload.upload_protocol, expires_at: new Date(expires).toISOString(), max_duration_seconds: VIDEO_LIMITS.seconds } }, 201);
    } catch (error) {
      await c.env.DB.prepare("UPDATE message_videos SET state='deleting' WHERE id=?").bind(id).run();
      await deleteVideoAsset(c.env, id);
      throw error;
    }
  });

  for (const method of ["get", "post"] as const) {
    registerRoute(app, {
      method, path: `/videos/{id}${method === "post" ? "/complete" : ""}`,
      operationId: method === "post" ? "completeVideoUpload" : "getVideoUpload", tags: ["Messages"],
      summary: method === "post" ? "Confirm a video upload using Stream's processing status" : "Read video processing status",
      description: "Unattached uploads require their owner's session. Attached videos are public, like their messages. GET refreshes processing state at most once per 15 seconds. Client claims cannot mark a video ready.",
      security: method === "post" ? protectedSecurity : [], request: { params },
      responses: { ...errors, 200: jsonResult(z.object({ data: MessageVideo }), "Current processing status.") },
    }, async c => {
      const { id } = params.parse(c.req.param());
      let row = await findVideo(c.env, id);
      if (!row || row.state === "deleting") throw new ApiError(404, "not_found");
      if (method === "post" || !row.message_id) {
        const session = await requireSession(c.req.raw, c.env);
        if (session.user_id !== row.user_id) throw new ApiError(404, "not_found");
      }
      await refreshVideo(c.env, row);
      row = (await findVideo(c.env, id))!;
      return c.json({ data: videoResult(row) });
    });
  }

  registerRoute(app, {
    method: "delete", path: "/videos/{id}", operationId: "cancelVideoUpload", tags: ["Messages"],
    summary: "Cancel an unattached video upload", security: protectedSecurity, request: { params },
    responses: { ...errors, 200: jsonResult(z.object({ ok: z.literal(true) }), "Upload cancelled; storage deletion is retried in the background.") },
  }, async c => {
    const session = await requireSession(c.req.raw, c.env);
    const { id } = params.parse(c.req.param());
    const row = await findVideo(c.env, id);
    if (!row || row.user_id !== session.user_id) throw new ApiError(404, "not_found");
    const cancelled = await c.env.DB.prepare("UPDATE message_videos SET state='deleting' WHERE id=? AND message_id IS NULL RETURNING id").bind(id).first();
    if (!cancelled) throw new ApiError(409, "video_already_attached");
    await deleteVideoAsset(c.env, id);
    return c.json({ ok: true });
  });

  registerRoute(app, {
    method: "post", path: "/stream/webhook", operationId: "receiveStreamWebhook", tags: ["Messages"],
    summary: "Receive signed Cloudflare Stream processing notifications", security: [],
    description: "Authenticated by Webhook-Signature HMAC-SHA256 using the raw request body and a timestamp within five minutes. Duplicate, stale-state and unknown-asset notifications cannot revive deleted videos.",
    request: { body: { required: true, content: jsonContent(z.object({ uid: z.string() }).passthrough()) } },
    responses: { 200: jsonResult(z.object({ ok: z.literal(true) }), "Notification accepted."),
      401: errorResult("Invalid or expired webhook signature."), 503: errorResult("Webhook secret is not configured.") },
  }, async c => {
    if (!c.env.STREAM_WEBHOOK_SECRET) throw new ApiError(503, "video_webhook_unavailable");
    const body = await c.req.text(), signature = c.req.header("webhook-signature") ?? "";
    const fields = Object.fromEntries(signature.split(",").map(part => part.trim().split("=")));
    if (!/^\d+$/.test(fields.time ?? "") || !/^[a-f0-9]{64}$/.test(fields.sig1 ?? "") ||
      Math.abs(Date.now() / 1000 - Number(fields.time)) > 300) throw new ApiError(401, "invalid_webhook_signature");
    const expected = createHmac("sha256", c.env.STREAM_WEBHOOK_SECRET).update(`${fields.time}.${body}`).digest();
    if (!timingSafeEqual(expected, Buffer.from(fields.sig1, "hex"))) throw new ApiError(401, "invalid_webhook_signature");
    let payload: unknown;
    try { payload = JSON.parse(body); } catch { throw new ApiError(400, "invalid_request"); }
    const video = providerVideo.parse(payload);
    const row = await c.env.DB.prepare("SELECT * FROM message_videos WHERE stream_uid=?").bind(video.uid).first<VideoRow>();
    if (row) await applyProviderVideo(c.env, row, video);
    return c.json({ ok: true });
  });
}
