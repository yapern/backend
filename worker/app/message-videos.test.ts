import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { handleRequest } from "./router";
import { maintainVideos, VIDEO_LIMITS } from "./message-videos";
import { createTestDatabase } from "../testing/database";

const apiOrigin = "https://api.yapern.com";
const streamOrigin = "https://customer-testing.cloudflarestream.com";
async function fixture(t: TestContext) {
  const database = createTestDatabase();
  t.after(() => database.close());
  const env = { DB: database.db, STREAM_ACCOUNT_ID: "a".repeat(32), STREAM_API_TOKEN: "private-token", STREAM_WEBHOOK_SECRET: "webhook-secret" } as Env;
  const assets = new Map<string, Record<string, unknown>>();
  const provider = { failed: false, deleteFailed: false, calls: 0, creates: 0, gets: 0, location: "" };
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
    const { data } = await response.json() as { data: { id: string; upload_url: string } };
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
  return { database, env, assets, provider, request, headers, owner, signIn, reserve, upload, source, complete, post, webhook };
}

test("reserves constrained TUS uploads without exposing credentials and enforces auth, CORS and quotas", async t => {
  const api = await fixture(t);
  assert.equal((await api.request("/videos", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ board_id: "general", size_bytes: 1024 }) })).status, 401);
  assert.equal((await api.request("/videos", { method: "POST", headers: { ...api.headers, origin: "https://evil.example" }, body: JSON.stringify({ board_id: "general", size_bytes: 1024 }) })).status, 403);
  assert.equal((await api.reserve({ board_id: "missing", size_bytes: 1024 })).status, 404);
  assert.equal((await api.reserve({ board_id: "general", size_bytes: VIDEO_LIMITS.bytes + 1 })).status, 400);
  for (let i = 0; i < VIDEO_LIMITS.pendingPerUser; i++) {
    const upload = await api.upload();
    assert.ok(upload.upload_url.startsWith("https://upload.videodelivery.net/"));
    assert.ok(!JSON.stringify(upload).includes("private-token"));
  }
  assert.equal((await api.reserve()).status, 429);
  assert.equal(api.provider.creates, 3);
  api.database.sqlite.exec("UPDATE message_videos SET state='deleting'; UPDATE video_daily_usage SET uploads=20");
  assert.equal((await api.reserve()).status, 429);
  assert.equal(api.provider.creates, 3);
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
