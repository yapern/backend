import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
  BROWSER_PUBLIC_PATTERN, PREVIEW_LIMITS, cleanupPreviews, consumePreviews, previewImage,
  previewStatus, renderScreenshot, requestPreview, usablePreview,
} from "./preview-jobs";
import { PREVIEW_USER_AGENT, type DnsResolver } from "./preview-metadata";
import { PreviewFailure } from "./preview-diagnostics";
import { ApiError } from "./contracts";
import { createTestDatabase } from "../testing/database";

const origin = "https://api.yapern.test";
const jpeg = Uint8Array.from([0xff, 0xd8, ...new Array(1000).fill(0x31), 0xff, 0xd9]);
const publicDns: DnsResolver = { resolve4: async () => ["1.1.1.1"], resolve6: async () => ["2606:4700::1111"] };
type PreviewRequest = Awaited<ReturnType<typeof requestPreview>>;
function previewId(result: PreviewRequest): string {
  if (!("previewId" in result.data)) throw new Error("expected an enqueued preview");
  return result.data.previewId;
}

type StoredObject = { key: string; body: Uint8Array; httpEtag: string; size: number; httpMetadata?: Record<string, unknown> };
function memoryBucket(pageSize = 100) {
  const objects = new Map<string, StoredObject>();
  const deleted: string[][] = [];
  const listings = new Map<string, string[]>();
  let listingId = 0;
  const bucket = {
    objects, deleted,
    async put(key: string, body: ArrayBuffer | ArrayBufferView | ReadableStream | string, options?: Record<string, unknown>) {
      const bytes = typeof body === "string" ? new TextEncoder().encode(body)
        : body instanceof ArrayBuffer ? new Uint8Array(body)
          : ArrayBuffer.isView(body) ? new Uint8Array(body.buffer, body.byteOffset, body.byteLength).slice()
            : new Uint8Array();
      objects.set(key, { key, body: bytes, httpEtag: `"${key}"`, size: bytes.length,
        httpMetadata: options?.httpMetadata as Record<string, unknown> | undefined });
      return objects.get(key)!;
    },
    async get(key: string) {
      const object = objects.get(key);
      return object && { ...object, body: new ReadableStream({ start(controller) { controller.enqueue(object.body); controller.close(); } }) };
    },
    async head(key: string) {
      const object = objects.get(key);
      if (!object) return null;
      const { body: _body, ...head } = object;
      return head;
    },
    async delete(keys: string | string[]) {
      const list = Array.isArray(keys) ? keys : [keys]; deleted.push(list);
      for (const key of list) objects.delete(key);
    },
    async list(options: { prefix?: string; cursor?: string } = {}) {
      let id: string, offset: number;
      if (options.cursor) [id, offset] = options.cursor.split(":") as [string, number];
      else {
        id = String(++listingId); offset = 0;
        listings.set(id, [...objects.keys()].filter(key => key.startsWith(options.prefix ?? "")).sort());
      }
      const matching = listings.get(id!) ?? [];
      const page = matching.slice(Number(offset), Number(offset) + pageSize);
      const truncated = Number(offset) + page.length < matching.length;
      return { objects: page.map(key => objects.get(key)).filter((object): object is StoredObject => Boolean(object)), truncated,
        ...(truncated ? { cursor: `${id}:${Number(offset) + page.length}` } : {}) };
    },
  };
  return bucket as unknown as R2Bucket & typeof bucket;
}

function queue() {
  const sent: Array<{ id: string }> = [];
  let failNext = false;
  return {
    sent,
    failOnce() { failNext = true; },
    async send(body: { id: string }) { if (failNext) { failNext = false; sent.push(body); throw new Error("ack lost"); } sent.push(body); },
  };
}

async function fixture(t: TestContext, options: { pageSize?: number; browser?: unknown; bucket?: boolean; queue?: boolean } = {}) {
  const store = createTestDatabase();
  t.after(() => store.close());
  const bucket = memoryBucket(options.pageSize);
  const q = queue();
  // D1 batches are atomic; serialize the in-memory helper's async transaction wrappers too.
  let batchTail = Promise.resolve();
  const db = {
    prepare: (sql: string) => store.db.prepare(sql),
    async batch(statements: D1PreparedStatement[]) {
      let release!: () => void;
      const next = new Promise<void>(resolve => { release = resolve; });
      const previous = batchTail;
      batchTail = next;
      await previous;
      try { return await store.db.batch(statements); }
      finally { release(); }
    },
  } as unknown as D1Database;
  const env = {
    DB: db, BUCKET: options.bucket === false ? undefined : bucket,
    PREVIEW_QUEUE: options.queue === false ? undefined : q,
    BROWSER: options.browser ?? { async quickAction() { return new Response("unused"); } },
  } as unknown as Env;
  const user = (id = "user-1") => store.sqlite.prepare("INSERT OR IGNORE INTO users(id,email) VALUES (?,?)").run(id, `${id}@example.com`);
  user();
  return { store, env, bucket, queue: q, user };
}

function delivery(id: string | unknown, actions: { ack?: number; retry?: Array<{ delaySeconds?: number }> } = {}) {
  const message = { body: typeof id === "string" ? { id } : id, ack() { actions.ack = (actions.ack ?? 0) + 1; },
    retry(options?: { delaySeconds?: number }) { actions.retry ??= []; actions.retry.push(options ?? {}); } };
  return { message, actions, batch: { messages: [message] } as unknown as MessageBatch<unknown> };
}

async function pending(t: TestContext, url = "https://example.com/article", userId = "user-1") {
  const f = await fixture(t);
  const requested = await requestPreview(f.env, userId, url, origin, async () => ({ image: "https://example.com/icon.png", source: "favicon", status: "failed",
    diagnostics: { metadata: { code: "preview_metadata_missing" as const, message: "Untrusted input is replaced from the reason code.", httpStatus: 200, contentType: "text/html" } } }));
  assert.ok("previewId" in requested.data);
  return { ...f, requested };
}

async function rejectsApi(promise: Promise<unknown>, status: number, code: string) {
  await assert.rejects(promise, error => error instanceof ApiError && error.status === status && error.code === code);
}

test("metadata hits return immediately without queue, browser, or daily usage", async t => {
  const f = await fixture(t, { bucket: false, queue: false });
  const metadata = { image: "https://cdn.example.com/card.png", source: "og" as const, status: "ready" as const };
  assert.deepEqual(await requestPreview(f.env, "user-1", "https://example.com", origin, async () => metadata), { data: metadata, status: 200 });
  assert.equal(f.queue.sent.length, 0);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS n FROM link_previews").get()?.n, 0);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS n FROM preview_daily_usage").get()?.n, 0);
  const unavailable = await fixture(t, { bucket: false });
  await rejectsApi(requestPreview(unavailable.env, "user-1", "https://example.com/new", origin,
    async () => ({ image: null, source: "placeholder", status: "failed" })), 503, "preview_unavailable");
});

test("concurrent identical misses create and dispatch one job; ownership is enforced for status", async t => {
  const f = await fixture(t); f.user("other");
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let lookups = 0;
  const lookup = async () => { lookups++; await gate; return { image: "https://example.com/icon.png", source: "favicon" as const, status: "failed" as const }; };
  const first = requestPreview(f.env, "user-1", "https://example.com/a", origin, lookup);
  const second = requestPreview(f.env, "user-1", "https://example.com/a", origin, lookup);
  await new Promise(resolve => setTimeout(resolve, 0)); release();
  const [a, b] = await Promise.all([first, second]);
  assert.equal(previewId(a), previewId(b));
  assert.equal(lookups, 2);
  assert.equal(f.queue.sent.length, 1);
  assert.equal(f.store.sqlite.prepare("SELECT jobs FROM preview_daily_usage WHERE user_id='user-1'").get()?.jobs, 1);
  await rejectsApi(previewStatus(f.env, "other", previewId(a), origin), 404, "not_found");
  assert.equal((await previewStatus(f.env, "user-1", previewId(a), origin)).data.status, "pending");
});

test("daily and per-user job limits reject additional preview work", async t => {
  const f = await fixture(t);
  const day = new Date().toISOString().slice(0, 10);
  f.store.sqlite.prepare("INSERT INTO preview_daily_usage(user_id,day,jobs) VALUES (?,?,?)").run("user-1", day, PREVIEW_LIMITS.jobsPerDay);
  await rejectsApi(requestPreview(f.env, "user-1", "https://example.com/a", origin, async () => ({ image: null, source: "placeholder", status: "failed" })), 429, "preview_limit");
  f.store.sqlite.prepare("UPDATE preview_daily_usage SET jobs=0").run();
  for (let i = 0; i < PREVIEW_LIMITS.userJobs; i++) f.store.sqlite.prepare(`INSERT INTO link_previews(id,user_id,url_hash,url,state,lease_until,expires_at,created_at)
    VALUES (?,?,?,?,'failed',0,?,?)`).run(`job-${i}`, "user-1", `hash-${i}`, `https://example.com/${i}`, Date.now() + 1_000_000, Date.now());
  await rejectsApi(requestPreview(f.env, "user-1", "https://example.com/over-limit", origin, async () => ({ image: null, source: "placeholder", status: "failed" })), 429, "preview_limit");
});

test("cached screenshot bypasses metadata lookup and image GET/HEAD serve the R2 object", async t => {
  const f = await pending(t);
  const work = delivery(previewId(f.requested));
  await consumePreviews(work.batch, f.env, async () => jpeg);
  const id = previewId(f.requested);
  const row = f.store.sqlite.prepare("SELECT * FROM link_previews WHERE id=?").get(id) as { object_key: string; expires_at: number };
  const cached = await requestPreview(f.env, "user-1", "https://example.com/article", origin, async () => { throw Error("must not look up"); });
  assert.equal(cached.data.status, "ready");
  assert.equal(cached.data.source, "screenshot");
  assert.equal(cached.data.image, `${origin}/preview-images/${id}.jpg`);
  assert.equal(f.bucket.objects.get(row.object_key)?.httpMetadata?.contentType, "image/jpeg");
  const get = await previewImage(new Request(`${origin}/preview-images/${id}.jpg`), f.env, id);
  assert.equal(get.status, 200);
  assert.equal(get.headers.get("content-type"), "image/jpeg");
  assert.equal(get.headers.get("content-length"), String(jpeg.length));
  assert.equal(get.headers.get("x-content-type-options"), "nosniff");
  assert.equal(get.headers.get("access-control-allow-origin"), "*");
  assert.match(get.headers.get("cache-control") ?? "", /^public, max-age=\d+$/);
  assert.deepEqual(new Uint8Array(await get.arrayBuffer()), jpeg);
  const head = await previewImage(new Request(`${origin}/preview-images/${id}.jpg`, { method: "HEAD" }), f.env, id);
  assert.equal(head.status, 200);
  assert.equal(head.headers.get("content-length"), String(jpeg.length));
  assert.equal(await head.text(), "");
});

test("cached preview and status reads log state, diagnostics, error, and expiry", async t => {
  const events: unknown[][] = [];
  t.mock.method(console, "info", (...args: unknown[]) => { events.push(args); });
  const f = await pending(t);
  const id = previewId(f.requested);
  await requestPreview(f.env, "user-1", "https://example.com/article", origin, async () => { throw Error("must stay cached"); });
  await previewStatus(f.env, "user-1", id, origin);
  const hits = events.filter(args => args[1] === "cache hit").map(args => args[2] as Record<string, unknown>);
  assert.equal(hits.length, 2);
  for (const hit of hits) {
    assert.equal(hit.previewId, id);
    assert.equal(hit.state, "pending");
    assert.deepEqual(hit.diagnostics, f.requested.data.diagnostics);
    assert.equal(hit.error, undefined);
    assert.equal(typeof hit.expiresAt, "number");
    assert.ok(Number(hit.remainingTtlMs) > 0);
  }
});

test("worker failure is cached and falls back to metadata; queue loss is recoverable by redelivery or polling", async t => {
  const f = await pending(t);
  const id = previewId(f.requested);
  const failedDelivery = delivery(id);
  await consumePreviews(failedDelivery.batch, f.env, async () => { throw new Error("browser offline"); });
  assert.equal(failedDelivery.actions.ack, 1);
  const failed = await previewStatus(f.env, "user-1", id, origin);
  assert.equal(failed.data.status, "failed");
  assert.equal(failed.data.image, "https://example.com/icon.png");
  assert.equal(failed.data.source, "favicon");
  assert.equal(failed.data.error, "preview_failed");
  assert.deepEqual(failed.data.diagnostics, {
    metadata: { code: "preview_metadata_missing", message: "No usable Open Graph or Twitter image was found in the first 256 KiB of page HTML.", httpStatus: 200, contentType: "text/html" },
    screenshot: { code: "preview_failed", message: "The screenshot job failed; no more specific reason was recorded." },
  });
  const cachedFailed = await requestPreview(f.env, "user-1", "https://example.com/article", origin, async () => { throw Error("must not look up"); });
  assert.deepEqual(cachedFailed.data, failed.data, "cached request retains both diagnostic stages");
  assert.equal(f.queue.sent.length, 1);
  await consumePreviews(delivery(id).batch, f.env, async () => jpeg);
  assert.equal((await previewStatus(f.env, "user-1", id, origin)).data.status, "failed");

  f.store.sqlite.prepare("UPDATE link_previews SET state='pending',lease_until=0 WHERE id=?").run(id);
  f.queue.failOnce();
  await rejectsApi(requestPreview(f.env, "user-1", "https://example.com/article", origin, async () => { throw Error("cached"); }), 503, "preview_queue_unavailable");
  assert.equal(f.queue.sent.length, 2); // broker accepted it, acknowledgement was lost
  const redelivery = delivery(id);
  await consumePreviews(redelivery.batch, f.env, async () => jpeg);
  assert.equal(redelivery.actions.ack, 1);
  assert.equal((await previewStatus(f.env, "user-1", id, origin)).data.status, "ready");
});

test("legacy failed rows reconstruct a curated screenshot diagnostic from the old error field", async t => {
  const f = await fixture(t);
  const id = "legacy-preview";
  f.store.sqlite.prepare(`INSERT INTO link_previews(id,user_id,url_hash,url,state,error,lease_until,expires_at,created_at)
    VALUES(?,?,?,?,'failed','preview_unusable',0,?,?)`).run(id, "user-1", "legacy-hash", "https://example.com/legacy", Date.now() + 1_000_000, Date.now());
  const result = await previewStatus(f.env, "user-1", id, origin);
  assert.equal(result.data.error, "preview_unusable");
  assert.deepEqual(result.data.diagnostics?.screenshot, {
    code: "preview_unusable", message: "The cached screenshot was rejected as blank, blocked, or an error page; no more specific reason was recorded.",
  });
});

test("polling recovers an expired pending lease and duplicate deliveries do not rerender a ready preview", async t => {
  const f = await pending(t);
  const id = previewId(f.requested);
  f.store.sqlite.prepare("UPDATE link_previews SET lease_until=0 WHERE id=?").run(id);
  await previewStatus(f.env, "user-1", id, origin);
  assert.equal(f.queue.sent.length, 2);
  let renders = 0; let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const renderer = async () => { renders++; if (renders === 1) await gate; return jpeg; };
  const first = delivery(id), second = delivery(id);
  const firstWork = consumePreviews(first.batch, f.env, renderer);
  await new Promise(resolve => setTimeout(resolve, 0));
  const secondWork = consumePreviews(second.batch, f.env, renderer);
  await secondWork;
  release(); await firstWork;
  assert.equal(renders, 1);
  assert.equal(second.actions.ack, 1);
  const duplicate = delivery(id);
  await consumePreviews(duplicate.batch, f.env, async () => { renders++; return jpeg; });
  assert.equal(renders, 1);
  assert.equal(duplicate.actions.ack, 1);
});

test("a superseded lease cannot publish or delete a newer renderer object", async t => {
  const f = await pending(t); const id = previewId(f.requested);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const oldDelivery = delivery(id);
  const oldWork = consumePreviews(oldDelivery.batch, f.env, async () => { await gate; return jpeg; });
  await new Promise(resolve => setTimeout(resolve, 0));
  const oldLease = (f.store.sqlite.prepare("SELECT lease FROM link_previews WHERE id=?").get(id) as { lease: string }).lease;
  const newerLease = "newer-render-lease";
  f.store.sqlite.prepare("UPDATE link_previews SET lease=?,lease_until=? WHERE id=?").run(newerLease, Date.now() + PREVIEW_LIMITS.leaseMs, id);
  const newerKey = `previews/${id}/${newerLease}.jpg`;
  await f.bucket.put(newerKey, jpeg);
  release(); await oldWork;
  assert.equal(f.store.sqlite.prepare("SELECT object_key FROM link_previews WHERE id=?").get(id)?.object_key, null);
  assert.ok(f.bucket.objects.has(newerKey));
  assert.ok(![...f.bucket.objects.keys()].some(key => key.includes(oldLease)));
});

test("account deletion during rendering prevents publication and removes the upload", async t => {
  const f = await pending(t); const id = previewId(f.requested);
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const work = consumePreviews(delivery(id).batch, f.env, async () => { await gate; return jpeg; });
  await new Promise(resolve => setTimeout(resolve, 0));
  f.store.sqlite.prepare("DELETE FROM users WHERE id='user-1'").run();
  release(); await work;
  assert.equal(f.store.sqlite.prepare("SELECT state FROM link_previews WHERE id=?").get(id)?.state, "failed");
  assert.equal(f.bucket.objects.size, 0, JSON.stringify({ keys: [...f.bucket.objects.keys()], deleted: f.bucket.deleted }));
});

test("cleanup removes expired and orphaned previews, including unacknowledged uploads across R2 pages", async t => {
  const f = await fixture(t, { pageSize: 1 });
  const insert = (id: string, userId: string, expires: number) => f.store.sqlite.prepare(`INSERT INTO link_previews
    (id,user_id,url_hash,url,state,lease_until,expires_at,created_at) VALUES (?,?,?,?,'ready',0,?,?)`)
    .run(id, userId, `hash-${id}`, `https://example.com/${id}`, expires, Date.now());
  insert("expired", "user-1", Date.now() - 1);
  insert("orphan", "deleted-user", Date.now() + 1_000_000);
  await f.bucket.put("previews/expired/a.jpg", jpeg);
  await f.bucket.put("previews/expired/b.jpg", jpeg);
  await f.bucket.put("previews/orphan/unacked.jpg", jpeg);
  await cleanupPreviews(f.env);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS n FROM link_previews").get()?.n, 0);
  assert.equal(f.bucket.objects.size, 0, JSON.stringify({ keys: [...f.bucket.objects.keys()], deleted: f.bucket.deleted }));
  assert.ok(f.bucket.deleted.flat().includes("previews/orphan/unacked.jpg"));
});

test("invalid queue messages and obsolete deliveries are acknowledged", async t => {
  const f = await fixture(t);
  const malformed = delivery({ nope: true });
  await consumePreviews(malformed.batch, f.env);
  assert.equal(malformed.actions.ack, 1);
  const transient = delivery("missing-row");
  await consumePreviews(transient.batch, f.env);
  assert.equal(transient.actions.ack, 1); // a valid but obsolete delivery is harmless
  assert.equal(transient.actions.retry, undefined);
});

function snapshotResponse(options: { status?: number; title?: string; content?: string; screenshot?: string; finalUrl?: string; redirects?: Array<{ url: string }> } = {}) {
  return new Response(JSON.stringify({ success: true, result: {
    content: options.content ?? `<html><body>${"visible page content ".repeat(5)}</body></html>`,
    screenshot: options.screenshot ?? Buffer.from(jpeg).toString("base64"),
  }, meta: { status: options.status ?? 200, title: options.title ?? "Example article", ...(options.finalUrl ? { finalUrl: options.finalUrl } : {}), ...(options.redirects ? { redirectChain: options.redirects } : {}) } }), { headers: { "content-type": "application/json" } });
}

test("browser renderer receives bounded snapshot settings and validates public DNS", async () => {
  let called = 0; let action = ""; let opts: Record<string, unknown> = {};
  const env = { BROWSER: { async quickAction(name: string, options: Record<string, unknown>) { called++; action = name; opts = options; return snapshotResponse(); } } } as unknown as Env;
  assert.deepEqual([...await renderScreenshot(env, "https://example.com/path", publicDns)], [...jpeg]);
  assert.equal(called, 1); assert.equal(action, "snapshot");
  assert.equal(opts.url, "https://example.com/path");
  assert.deepEqual(opts.formats, ["content", "screenshot"]);
  assert.equal(opts.userAgent, PREVIEW_USER_AGENT);
  assert.deepEqual(opts.viewport, { width: 1200, height: 630 });
  assert.deepEqual(opts.screenshotOptions, { type: "jpeg", quality: 80, fullPage: false });
  assert.deepEqual(opts.rejectResourceTypes, ["media", "websocket"]);
  assert.deepEqual(opts.allowRequestPattern, [BROWSER_PUBLIC_PATTERN]);
});

test("browser renderer accepts CNAME answers when public IP answers are present", async () => {
  const env = { BROWSER: { async quickAction() { return snapshotResponse(); } } } as unknown as Env;
  const cnameDns: DnsResolver = {
    resolve4: async () => ["a026d147d2544f20.vercel-dns-017.com.", "216.150.16.193"],
    resolve6: async () => ["a026d147d2544f20.vercel-dns-017.com."],
  };
  assert.deepEqual([...await renderScreenshot(env, "https://www.lobstack.ai/", cnameDns)], [...jpeg]);
});

test("browser renderer blocks private initial, final, and redirect destinations", async () => {
  let navigations = 0;
  const env = { BROWSER: { async quickAction() { navigations++; return snapshotResponse(); } } } as unknown as Env;
  const privateDns: DnsResolver = { resolve4: async () => ["10.0.0.1"], resolve6: async () => [] };
  await assert.rejects(renderScreenshot(env, "https://example.com/", privateDns), error => error instanceof PreviewFailure
    && error.diagnostic.code === "preview_dns_not_public");
  assert.equal(navigations, 0);
  for (const meta of [{ finalUrl: "https://private.example.com/" }, { redirects: [{ url: "https://private.example.com/" }] }]) {
    const dns: DnsResolver = { resolve4: async host => [host.startsWith("private.") ? "192.168.0.4" : "1.1.1.1"], resolve6: async () => [] };
    const responseEnv = { BROWSER: { async quickAction() { return snapshotResponse(meta); } } } as unknown as Env;
    await assert.rejects(renderScreenshot(responseEnv, "https://example.com/", dns), error => error instanceof PreviewFailure
      && error.diagnostic.code === "preview_dns_not_public");
  }
});

test("unusable browser pages, failed snapshots, and malformed or oversized JPEGs are rejected", async () => {
  assert.equal(usablePreview("<body>" + "x".repeat(50) + "</body>", { status: 500, title: "Good" }), false);
  assert.equal(usablePreview("<body>ok</body>", { status: 200, title: "Just a moment" }), false);
  assert.equal(usablePreview(`<body>${"x".repeat(100)}<div id="cf-chl-widget"></div></body>`, { status: 200, title: "Fine" }), false);
  assert.equal(usablePreview("<body><script>" + "x".repeat(100) + "</script></body>", { status: 200, title: "Fine" }), false);
  const blankEnv = { BROWSER: { async quickAction() { return snapshotResponse({ content: "<html><body>tiny</body></html>" }); } } } as unknown as Env;
  await assert.rejects(renderScreenshot(blankEnv, "https://example.com/", publicDns), error => error instanceof PreviewFailure
    && error.diagnostic.code === "preview_blank_page");
  const errorEnv = { BROWSER: { async quickAction() { return new Response("failed", { status: 502 }); } } } as unknown as Env;
  await assert.rejects(renderScreenshot(errorEnv, "https://example.com/", publicDns), /preview_browser_failed/);
  for (const screenshot of [Buffer.from("not jpeg").toString("base64"), Buffer.from([0xff, 0xd8, 0, 0xff, 0xd9]).toString("base64"), Buffer.alloc(PREVIEW_LIMITS.imageBytes + 1, 1).toString("base64")]) {
    const badImage = { BROWSER: { async quickAction() { return snapshotResponse({ screenshot }); } } } as unknown as Env;
    await assert.rejects(renderScreenshot(badImage, "https://example.com/", publicDns), /preview_invalid_image/);
  }
});

test("browser page rejections keep distinct curated reasons and website status", async () => {
  const cases = [
    { title: "Just a moment", content: "", code: "preview_challenge" },
    { title: "Access denied", content: "", code: "preview_access_denied" },
    { title: "Sign in", content: "", code: "preview_login_required" },
    { title: "Page not found", content: "", code: "preview_error_page" },
    { title: "Example", content: '<body><div class="onetrust-banner-sdk">consent</div></body>', code: "preview_consent_overlay" },
    { title: "Example", content: "tiny", code: "preview_blank_page" },
    { title: "Example", content: "Enough visible text ".repeat(5), status: 503, code: "preview_http_error" },
  ];
  for (const item of cases) {
    const env = { BROWSER: { async quickAction() { return snapshotResponse(item); } } } as unknown as Env;
    await assert.rejects(renderScreenshot(env, "https://example.com/", publicDns), error => error instanceof PreviewFailure
      && error.diagnostic.code === item.code
      && error.diagnostic.httpStatus === (item.status ?? 200), item.code);
  }
});

test("browser service diagnostics retain HTTP and provider codes without exposing provider messages", async () => {
  const rawMessage = "net::ERR_NAME_NOT_RESOLVED internal host detail";
  const env = { BROWSER: { async quickAction() { return new Response(JSON.stringify({ success: false,
    errors: [{ code: 1003, message: rawMessage }] }), { status: 502 }); } } } as unknown as Env;
  await assert.rejects(renderScreenshot(env, "https://example.com/", publicDns), error => {
    if (!(error instanceof PreviewFailure)) return false;
    const diagnostic = error.diagnostic;
    return diagnostic.code === "preview_dns_failed" && diagnostic.httpStatus === 502 && diagnostic.providerCode === 1003
      && !diagnostic.message.includes(rawMessage);
  });
});

test("invalid, incomplete, and non-success browser snapshots get distinct safe diagnostics", async () => {
  const cases = [
    { body: "not json", status: 200, code: "preview_invalid_snapshot" },
    { body: "not json", status: 502, code: "preview_browser_failed" },
    { body: "null", status: 200, code: "preview_invalid_snapshot" },
    { body: JSON.stringify({ success: true, result: {}, meta: {} }), status: 200, code: "preview_invalid_snapshot" },
  ];
  for (const item of cases) {
    const env = { BROWSER: { async quickAction() { return new Response(item.body, { status: item.status }); } } } as unknown as Env;
    await assert.rejects(renderScreenshot(env, "https://example.com/", publicDns), error => error instanceof PreviewFailure
      && error.diagnostic.code === item.code
      && error.diagnostic.httpStatus === item.status, item.body);
  }
});

test("storage write failures are saved separately from renderer failures", async t => {
  const f = await pending(t);
  f.bucket.put = async () => { throw new Error("private storage detail"); };
  const work = delivery(previewId(f.requested));
  await consumePreviews(work.batch, f.env, async () => jpeg);
  const failed = await previewStatus(f.env, "user-1", previewId(f.requested), origin);
  assert.equal(failed.data.error, "preview_storage_failed");
  assert.equal(failed.data.diagnostics?.screenshot?.code, "preview_storage_failed");
  assert.ok(!JSON.stringify(failed.data).includes("private storage detail"));
});

test("snapshot body limits and deadline abort both late browser responses and hanging body reads", async () => {
  const original = AbortSignal.timeout;
  const controller = new AbortController();
  AbortSignal.timeout = (() => controller.signal) as typeof AbortSignal.timeout;
  try {
    let resolveResponse!: (response: Response) => void;
    let lateCancelled = false;
    const lateEnv = { BROWSER: { quickAction() { return new Promise<Response>(resolve => { resolveResponse = resolve; }); } } } as unknown as Env;
    const late = renderScreenshot(lateEnv, "https://example.com/", publicDns);
    await new Promise(resolve => setTimeout(resolve, 0));
    controller.abort(new Error("deadline"));
    await assert.rejects(late);
    resolveResponse(new Response(new ReadableStream({ start() {}, cancel() { lateCancelled = true; } }), { status: 200 }));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(lateCancelled, true);

    const hangingController = new AbortController();
    AbortSignal.timeout = (() => hangingController.signal) as typeof AbortSignal.timeout;
    let bodyCancelled = false;
    const stream = new ReadableStream<Uint8Array>({ start() {}, cancel() { bodyCancelled = true; } });
    const hangingEnv = { BROWSER: { async quickAction() { return new Response(stream); } } } as unknown as Env;
    const hanging = renderScreenshot(hangingEnv, "https://example.com/", publicDns);
    await new Promise(resolve => setTimeout(resolve, 0));
    hangingController.abort(new Error("deadline"));
    await assert.rejects(hanging);
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.equal(bodyCancelled, true);
  } finally { AbortSignal.timeout = original; }
});

test("oversized snapshot JSON is rejected before it can be parsed", async () => {
  const huge = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(12 * 1024 * 1024 + 1)); controller.close(); } });
  const env = { BROWSER: { async quickAction() { return new Response(huge); } } } as unknown as Env;
  await assert.rejects(renderScreenshot(env, "https://example.com/", publicDns), /preview_response_too_large/);
});
