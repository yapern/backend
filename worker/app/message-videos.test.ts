import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleRequest } from "./router";
import { maintainVideos, VIDEO_LIMITS } from "./message-videos";
import { createTestDatabase } from "../testing/database";

const apiOrigin = "https://api.yapern.com";
const streamOrigin = "https://customer-testing.cloudflarestream.com";
async function fixture(t: TestContext, native = false) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = { DB: database.db, STREAM_ACCOUNT_ID: "a".repeat(32), STREAM_API_TOKEN: "private-token", STREAM_WEBHOOK_SECRET: "webhook-secret" } as unknown as Env;
  const assets = new Map<string, Record<string, unknown>>();
  const provider = { failed: false, deleteFailed: false, calls: 0, creates: 0, gets: 0, location: "" };
  const binding = { failed: false, deleteFailed: false, createCalls: 0, detailsCalls: 0, deleteCalls: 0,
    uploadUrl: "", invalidId: false, assets: new Map<string, StreamVideo>() };
  if (native) {
    env.STREAM = {
      async createDirectUpload(options: StreamDirectUploadCreateParams) {
        binding.createCalls++;
        assert.equal(options.maxDurationSeconds, 120);
        assert.ok(Date.parse(options.expiry!) > Date.now());
        assert.ok(options.creator);
        assert.ok(options.meta?.name);
        if (binding.failed) throw new Error("provider credentials leaked");
        const id = binding.invalidId ? "unsafe-id" : (binding.createCalls + 100).toString(16).padStart(32, "0");
        const uploadURL = binding.uploadUrl || `https://upload.cloudflarestream.com/${id}`;
        binding.assets.set(id, { id, creator: options.creator!, thumbnail: "", thumbnailTimestampPct: 0, readyToStream: false,
          readyToStreamAt: null, status: { state: "pendingupload", errorReasonCode: "", errorReasonText: "" }, meta: options.meta!,
          created: new Date().toISOString(), modified: new Date().toISOString(), scheduledDeletion: null, size: 0, allowedOrigins: [],
          requireSignedURLs: false, uploaded: null, uploadExpiry: options.expiry!, maxSizeBytes: null,
          maxDurationSeconds: options.maxDurationSeconds, duration: -1, input: { width: 0, height: 0 },
          hlsPlaybackUrl: `https://customer-testing.cloudflarestream.com/${id}/manifest/video.m3u8`,
          dashPlaybackUrl: "", watermark: null, liveInputId: null, clippedFromId: null, publicDetails: null });
        return { id, uploadURL };
      },
      video(id: string) {
        return {
          async details() {
            binding.detailsCalls++;
            if (binding.failed) throw new Error("provider details failed");
            const asset = binding.assets.get(id);
            if (!asset) throw Object.assign(new Error("not found"), { statusCode: 404 });
            return asset;
          },
          async delete() {
            binding.deleteCalls++;
            if (binding.deleteFailed) throw new Error("provider delete failed");
            if (!binding.assets.delete(id)) throw Object.assign(new Error("not found"), { statusCode: 404 });
          },
        };
      },
    } as unknown as StreamBinding;
  }
  t.mock.method(globalThis, "fetch", async (value: string, options: RequestInit) => {
    provider.calls++;
    assert.equal(options.redirect, "error");
    assert.equal((options.headers as Record<string, string>).authorization, "Bearer private-token");
    assert.ok(value.startsWith(`https://api.cloudflare.com/client/v4/accounts/${"a".repeat(32)}/stream`));
    if (provider.failed) return Response.json({ success: false }, { status: 503 });
    if (options.method === "POST") {
      const headers = options.headers as Record<string, string>;
      assert.equal(headers["tus-resumable"], "1.0.0");
      assert.equal(headers["upload-length"], "1024");
      assert.equal(options.body, undefined);
      const metadata = Object.fromEntries(headers["upload-metadata"].split(",").map(field => {
        const [key, value] = field.split(" "); return [key, Buffer.from(value, "base64").toString()];
      }));
      assert.equal(metadata.maxDurationSeconds, "120");
      assert.ok(Date.parse(metadata.expiry) > Date.now());
      const uid = (++provider.creates).toString(16).padStart(32, "0");
      assets.set(uid, { uid, status: { state: "pendingupload" }, readyToStream: false });
      return new Response(null, { status: 201, headers: {
        "stream-media-id": uid, location: provider.location || `https://upload.videodelivery.net/tus/${uid}`,
      } });
    }
    const uid = value.split("/").at(-1)!;
    if (options.method === "DELETE") {
      if (provider.deleteFailed) return new Response(null, { status: 503 });
      const existed = assets.delete(uid);
      return new Response(null, { status: existed ? 200 : 404 });
    }
    provider.gets++;
    return assets.has(uid) ? Response.json({ success: true, result: assets.get(uid) }) : Response.json({ success: false }, { status: 404 });
  });
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`${apiOrigin}${path}`, init), env);
  async function signIn(email: string) {
    return (await (await request("/auth/email", { method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct horse battery" }) })).json()) as { token: string; user: { id: string } };
  }
  const owner = await signIn("video-author@example.com");
  const headers = { authorization: `Bearer ${owner.token}`, "content-type": "application/json", origin: "https://yapern.com" };
  const reserve = (input = { board_id: "general", size_bytes: 1024 }) => request("/videos", { method: "POST", headers, body: JSON.stringify(input) });
  async function upload() {
    const response = await reserve();
    assert.equal(response.status, 201, await response.clone().text());
    const { data } = await response.json() as { data: { id: string; upload_url: string; upload_protocol: "multipart" | "tus" } };
    const row = database.sqlite.prepare("SELECT * FROM message_videos WHERE id=?").get(data.id)!;
    return { ...data, uid: String(row.stream_uid) };
  }
  function source(uid: string, status = "ready", overrides: Record<string, unknown> = {}) {
    const asset = { uid, status: { state: status }, readyToStream: status === "ready", duration: 30, size: 1024,
      input: { width: 1080, height: 1920 }, playback: { hls: `${streamOrigin}/${uid}/manifest/video.m3u8` }, ...overrides };
    assets.set(uid, asset);
    return asset;
  }
  const complete = (id: string) => request(`/videos/${id}/complete`, { method: "POST", headers });
  const post = (id: string, extra: Record<string, unknown> = {}) => request("/tables/messages", { method: "POST", headers,
    body: JSON.stringify({ board_id: "general", title: "A video", attachment_id: id, ...extra }) });
  const webhook = (payload: unknown, time = String(Math.floor(Date.now() / 1000)), suffix = "") => {
    const body = JSON.stringify(payload, null, 2) + suffix;
    const sig = createHmac("sha256", env.STREAM_WEBHOOK_SECRET!).update(`${time}.${body}`).digest("hex");
    return request("/stream/webhook", { method: "POST", headers: { "content-type": "application/json", "webhook-signature": `time=${time},sig1=${sig}` }, body });
  };
  return { database, env, assets, provider, binding, request, headers, owner, signIn, reserve, upload, source, complete, post, webhook };
}

test("reserves constrained TUS uploads without exposing credentials and enforces auth, CORS and quotas", async t => {
  const api = await fixture(t);
  assert.equal((await api.request("/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board_id: "general", size_bytes: 1024 }) })).status, 401);
  assert.equal((await api.request("/videos", { method: "POST", headers: { ...api.headers, origin: "https://evil.example" }, body: JSON.stringify({ board_id: "general", size_bytes: 1024 }) })).status, 403);
  assert.equal((await api.reserve({ board_id: "missing", size_bytes: 1024 })).status, 404);
  assert.equal((await api.reserve({ board_id: "general", size_bytes: VIDEO_LIMITS.bytes + 1 })).status, 400);
  for (let i = 0; i < VIDEO_LIMITS.pendingPerUser; i++) {
    const upload = await api.upload();
    assert.equal(upload.upload_protocol, "tus");
    assert.ok(upload.upload_url.startsWith("https://upload.videodelivery.net/"));
    assert.ok(!JSON.stringify(upload).includes("private-token"));
  }
  assert.equal((await api.reserve()).status, 429);
  assert.equal(api.provider.creates, 3);
  api.database.sqlite.exec("UPDATE message_videos SET state='deleting'; UPDATE video_daily_usage SET uploads=20");
  assert.equal((await api.reserve()).status, 429);
  assert.equal(api.provider.creates, 3);
});

test("native Stream binding creates multipart uploads and normalizes pending and ready metadata", async t => {
  const api = await fixture(t, true);
  api.env.STREAM_ACCOUNT_ID = undefined;
  api.env.STREAM_API_TOKEN = undefined;
  const upload = await api.upload();
  assert.equal(upload.upload_protocol, "multipart");
  assert.ok(upload.upload_url.startsWith("https://upload.cloudflarestream.com/"));
  assert.equal(api.provider.calls, 0);
  assert.equal(api.binding.createCalls, 1);
  assert.equal(api.database.sqlite.prepare("SELECT stream_uid FROM message_videos WHERE id=?").get(upload.id)!.stream_uid, upload.uid);

  assert.equal((await api.complete(upload.id)).status, 200);
  let status = (await (await api.request(`/videos/${upload.id}`, { headers: api.headers })).json() as {
    data: { status: string; duration: number | null; width: number | null } }).data;
  assert.equal(status.status, "uploading");
  assert.equal(status.duration, null);
  assert.equal(status.width, null);
  const asset = api.binding.assets.get(upload.uid)!;
  Object.assign(asset, { readyToStream: true, status: { state: "ready", errorReasonCode: "", errorReasonText: "" },
    size: 2048, duration: 31, input: { width: 1920, height: 1080 } });
  api.database.sqlite.prepare("UPDATE message_videos SET checked_at=0 WHERE id=?").run(upload.id);
  const ready = await api.complete(upload.id);
  assert.equal(ready.status, 200);
  status = (await ready.json() as { data: typeof status }).data;
  assert.equal(status.status, "ready");
  assert.equal(status.duration, 31);
  assert.equal(status.width, 1920);
  assert.equal((await api.post(upload.id)).status, 201);
  assert.equal(api.provider.calls, 0);
  assert.equal(api.binding.detailsCalls, 2);
});

test("native Stream errors are sanitized and cleanup retries handle failure and missing assets", async t => {
  t.mock.method(console, "warn", () => {});
  const api = await fixture(t, true);
  api.binding.failed = true;
  const failedCreate = await api.reserve();
  assert.equal(failedCreate.status, 502);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos").get()!.n, 0);
  api.binding.failed = false;

  api.binding.uploadUrl = "https://evil.example/upload";
  assert.equal((await api.reserve()).status, 502);
  assert.equal(api.binding.assets.size, 0);
  api.binding.uploadUrl = "";

  const upload = await api.upload();
  api.binding.failed = true;
  assert.equal((await api.complete(upload.id)).status, 502);
  api.binding.failed = false;

  api.binding.deleteFailed = true;
  assert.equal((await api.request(`/videos/${upload.id}`, { method: "DELETE", headers: api.headers })).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT state FROM message_videos WHERE id=?").get(upload.id)!.state, "deleting");
  api.binding.deleteFailed = false;
  await maintainVideos(api.env);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos").get()!.n, 0);

  const missing = await api.upload();
  api.binding.assets.delete(missing.uid);
  assert.equal((await api.request(`/videos/${missing.id}`, { method: "DELETE", headers: api.headers })).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos WHERE id=?").get(missing.id)!.n, 0);
});

test("native uploads enforce reservation quotas and reject oversized processed videos", async t => {
  const api = await fixture(t, true);
  assert.equal((await api.reserve({ board_id: "general", size_bytes: VIDEO_LIMITS.bytes + 1 })).status, 400);
  const uploads = [];
  for (let i = 0; i < VIDEO_LIMITS.pendingPerUser; i++) uploads.push(await api.upload());
  assert.equal((await api.reserve()).status, 429);
  assert.equal(api.binding.createCalls, VIDEO_LIMITS.pendingPerUser);

  const asset = api.binding.assets.get(uploads[0].uid)!;
  Object.assign(asset, { readyToStream: true, status: { state: "ready", errorReasonCode: "", errorReasonText: "" },
    size: VIDEO_LIMITS.bytes + 1, duration: 30, input: { width: 640, height: 480 } });
  api.database.sqlite.prepare("UPDATE message_videos SET checked_at=0 WHERE id=?").run(uploads[0].id);
  assert.equal((await api.complete(uploads[0].id)).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT state,error FROM message_videos WHERE id=?").get(uploads[0].id)!.error,
    "video_limit_exceeded");
  await maintainVideos(api.env);
  assert.equal(api.binding.assets.has(uploads[0].uid), false);
});

test("native Stream rejects malformed asset IDs and cleans up assets after unsafe upload URLs", async t => {
  const api = await fixture(t, true);
  api.binding.invalidId = true;
  assert.equal((await api.reserve()).status, 502);
  assert.equal(api.database.sqlite.prepare("SELECT stream_uid FROM message_videos").get(), undefined);
  api.binding.assets.clear();
  api.binding.invalidId = false;
  for (const uploadUrl of [
    "https://upload.cloudflarestream.com.evil.example/upload",
    "https://user@upload.cloudflarestream.com/upload",
    "http://upload.cloudflarestream.com/upload",
  ]) {
    api.binding.uploadUrl = uploadUrl;
    assert.equal((await api.reserve()).status, 502, uploadUrl);
    assert.equal(api.binding.assets.size, 0, uploadUrl);
  }
});

test("only trusted processing state can be attached; message retries, projections and public playback work", async t => {
  const api = await fixture(t), upload = await api.upload();
  assert.equal((await api.request(`/videos/${upload.id}`)).status, 401);
  assert.equal((await api.post(upload.id)).status, 409);
  const other = await api.signIn("another-video-user@example.com");
  assert.equal((await api.request(`/videos/${upload.id}/complete`, { method: "POST", headers: { authorization: `Bearer ${other.token}` } })).status, 404);
  assert.equal((await api.complete(upload.id)).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT state FROM message_videos WHERE id=?").get(upload.id)!.state, "uploading");
  api.source(upload.uid, "queued");
  api.database.sqlite.exec("UPDATE message_videos SET checked_at=0");
  await api.complete(upload.id);
  assert.equal((await api.post(upload.id, { board_id: "missing" })).status, 409);
  const response = await api.post(upload.id, { body: "Hello" });
  assert.equal(response.status, 201, await response.clone().text());
  const message = (await response.json() as { data: { id: string; body: string; video: { status: string } }[] }).data[0];
  assert.equal(message.body, `${streamOrigin}/${upload.uid}/watch\nHello`);
  assert.equal(message.video.status, "processing");
  const retry = await api.post(upload.id, { body: "Hello" });
  assert.equal(retry.status, 201);
  assert.equal((await retry.json() as { data: { id: string }[] }).data[0].id, message.id);
  assert.equal((await api.post(upload.id, { body: "Changed" })).status, 409);
  assert.equal((await api.request(`/videos/${upload.id}`, { headers: { origin: "https://yapern.com" } })).status, 200);
  assert.equal((await api.request(`/videos/${upload.id}`, { headers: { origin: "https://evil.example" } })).status, 403);
  assert.equal((await api.webhook(api.source(upload.uid))).status, 200);
  const status = await (await api.request(`/videos/${upload.id}`)).json() as { data: { player_url: string; playback_url: string; width: number } };
  assert.equal(status.data.player_url, `${streamOrigin}/${upload.uid}/iframe`);
  assert.equal(status.data.playback_url, `${streamOrigin}/${upload.uid}/manifest/video.m3u8`);
  assert.equal(status.data.width, 1080);
  const projection = await (await api.request(`/tables/messages?id=eq.${message.id}&select=video`)).json() as { data: Record<string, unknown>[] };
  assert.deepEqual(Object.keys(projection.data[0]), ["video"]);
  assert.deepEqual(projection.data[0].video, status.data);
  assert.equal((await api.request("/tables/messages?order=video.asc")).status, 400);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM messages").get()!.n, 1);
});

test("webhook signatures cover exact bytes, expire, and cannot downgrade terminal or deleted videos", async t => {
  const api = await fixture(t), upload = await api.upload();
  const ready = api.source(upload.uid);
  assert.equal((await api.webhook(ready, undefined, "\n")).status, 200);
  assert.equal((await api.webhook(ready, "1")).status, 401);
  assert.equal((await api.request("/stream/webhook", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(ready) })).status, 401);
  assert.equal((await api.webhook(api.source(upload.uid, "queued"))).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT state FROM message_videos WHERE id=?").get(upload.id)!.state, "ready");
  assert.equal((await api.request(`/videos/${upload.id}`, { method: "DELETE", headers: api.headers })).status, 200);
  assert.equal((await api.webhook(ready)).status, 200);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos").get()!.n, 0);
  assert.equal((await api.request(`/videos/${upload.id}`)).status, 404);
});

test("message deletion durably queues Stream cleanup, including retries and missing upstream assets", async t => {
  t.mock.method(console, "warn", () => {});
  const api = await fixture(t), upload = await api.upload();
  await api.webhook(api.source(upload.uid));
  const message = (await (await api.post(upload.id)).json() as { data: { id: string }[] }).data[0];
  assert.equal((await api.request(`/videos/${upload.id}`, { method: "DELETE", headers: api.headers })).status, 409);
  api.provider.deleteFailed = true;
  assert.equal((await api.request(`/tables/messages?id=eq.${message.id}`, { method: "DELETE", headers: api.headers })).status, 200);
  const pending = api.database.sqlite.prepare("SELECT state,message_id FROM message_videos WHERE id=?").get(upload.id)!;
  assert.equal(pending.state, "deleting"); assert.equal(pending.message_id, null);
  assert.equal((await api.request(`/videos/${upload.id}`)).status, 404);
  await api.webhook(api.source(upload.uid));
  assert.equal(api.database.sqlite.prepare("SELECT state FROM message_videos WHERE id=?").get(upload.id)!.state, "deleting");
  api.provider.deleteFailed = false;
  api.assets.delete(upload.uid);
  await maintainVideos(api.env);
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos").get()!.n, 0);
});

test("reconciliation recovers missed webhooks, rejects oversized video and removes abandoned uploads", async t => {
  const api = await fixture(t), upload = await api.upload();
  api.source(upload.uid);
  await maintainVideos(api.env);
  assert.equal(api.database.sqlite.prepare("SELECT state FROM message_videos WHERE id=?").get(upload.id)!.state, "ready");
  const oversized = await api.upload();
  assert.equal((await api.webhook(api.source(oversized.uid, "ready", { duration: 121 }))).status, 200);
  assert.equal((await api.post(oversized.id)).status, 409);
  await maintainVideos(api.env);
  assert.ok(!api.assets.has(oversized.uid));
  api.database.sqlite.prepare("UPDATE message_videos SET created_at=? WHERE id=?").run(Date.now() - VIDEO_LIMITS.abandonedMs - 1, upload.id);
  await maintainVideos(api.env);
  assert.ok(!api.assets.has(upload.uid));
  assert.equal(api.database.sqlite.prepare("SELECT count(*) AS n FROM message_videos WHERE id=?").get(upload.id)!.n, 0);
});

test("provider/configuration failures stay safe, and unsafe upload and playback URLs are rejected", async t => {
  t.mock.method(console, "warn", () => {});
  const api = await fixture(t);
  api.env.STREAM_API_TOKEN = undefined;
  assert.equal((await api.reserve()).status, 503);
  api.env.STREAM_API_TOKEN = "private-token";
  api.provider.failed = true;
  assert.equal((await api.reserve()).status, 502);
  api.provider.failed = false;
  api.provider.location = "https://evil.example/upload";
  assert.equal((await api.reserve()).status, 502);
  assert.equal(api.assets.size, 0);
  api.provider.location = "";
  const upload = await api.upload();
  await api.webhook(api.source(upload.uid, "ready", { playback: { hls: `https://evil.example/${upload.uid}/manifest/video.m3u8` } }));
  assert.equal((await api.post(upload.id)).status, 409);
  const before = api.provider.gets;
  await api.complete(upload.id); await api.complete(upload.id);
  assert.equal(api.provider.gets, before + 1);
});
