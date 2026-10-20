import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { extractMetadata, isPublicAddress, lookupPreview, safePublicUrl, type DnsResolver } from "./preview-metadata";
import { handleRequest } from "./router";
import { createTestDatabase } from "../testing/database";

const publicDns: DnsResolver = {
  resolve4: async () => ["93.184.215.14"],
  resolve6: async () => ["2606:4700::6810:85e5"],
};

function htmlResponse(html: string, status = 200, headers: HeadersInit = {}): Response {
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8", ...headers } });
}

test("public URL validation rejects local, credentialed, and alternate IP spellings", () => {
  for (const value of [
    "http://localhost", "https://printer.local/", "http://127.0.0.1/", "http://2130706433/",
    "http://0177.0.0.1/", "http://0x7f000001/", "http://[::1]/", "http://[::ffff:127.0.0.1]/",
    "http://169.254.169.254/", "https://example.com:8080/", "https://user:pass@example.com/",
    "https://example.com.evil.local/", "ftp://example.com/", "https://intranet/",
  ]) assert.equal(safePublicUrl(value), null, value);
  assert.equal(safePublicUrl("https://example.com/path#part")?.toString(), "https://example.com/path");
});

test("metadata prefers Open Graph, resolves entities and relative URLs, and ignores scripts", () => {
  const page = new URL("https://example.com/articles/post");
  const metadata = extractMetadata(`
    <head>
      <script>const example = '<meta property="og:image" content="https://evil.com/no.png">';</script>
      <!-- <meta property="og:image" content="https://evil.com/comment.png"> -->
      <base href="https://cdn.example.com/articles/">
      <base href="https://evil.com/ignored/">
      <meta name="twitter:image" content="/twitter.png">
      <meta property="og:image" content="photo.jpg?one=1&amp;two=2">
      <link rel="shortcut icon" href="/icon.png">
    </head>`, page);
  assert.equal(metadata.og?.toString(), "https://cdn.example.com/articles/photo.jpg?one=1&two=2");
  assert.equal(metadata.twitter?.toString(), "https://cdn.example.com/twitter.png");
  assert.equal(metadata.favicon?.toString(), "https://cdn.example.com/icon.png");
  assert.equal(extractMetadata('<body><meta property="og:image" content="https://evil.com/body.png">', page).og, null);
});

test("DNS address checks reject private and reserved A and AAAA records", () => {
  for (const address of ["127.0.0.1", "10.2.3.4", "172.17.1.1", "192.168.1.1", "169.254.169.254",
    "100.64.0.1", "192.0.2.1", "198.18.0.1", "198.51.100.1", "203.0.113.1",
    "::1", "fc00::1", "fe80::1", "::ffff:127.0.0.1", "2001:db8::1", "2001:0db8::1", "2002:c0a8:0101::1"]) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress("1.1.1.1"), true);
  assert.equal(isPublicAddress("2606:4700::1111"), true);
});

test("lookup returns Open Graph metadata from the final safe redirect target", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
    requested.push(String(input));
    assert.equal(init?.redirect, "manual");
    assert.equal(init?.headers && new Headers(init.headers).get("authorization"), null);
    if (requested.length === 1) return new Response(null, { status: 302, headers: { location: "/new" } });
    return htmlResponse('<meta property="og:image" content="/cover.jpg">');
  }) as typeof fetch;
  assert.deepEqual(await lookupPreview("https://example.com/old", fetcher, publicDns), {
    image: "https://example.com/cover.jpg", source: "og", status: "ready",
  });
  assert.deepEqual(requested, ["https://example.com/old", "https://example.com/new"]);
});

test("lookup refuses a redirect to a private address", async () => {
  let calls = 0;
  const fetcher = (async () => {
    calls++;
    return new Response(null, { status: 302, headers: { location: "http://127.0.0.1/admin" } });
  }) as typeof fetch;
  assert.deepEqual(await lookupPreview("https://example.com", fetcher, publicDns), {
    image: null, source: "placeholder", status: "failed",
  });
  assert.equal(calls, 1);
});

test("DNS check blocks a public-looking hostname that resolves to a private address", async () => {
  let calls = 0;
  const fetcher = (async () => { calls++; return htmlResponse("<head></head>"); }) as typeof fetch;
  const privateDns: DnsResolver = {
    resolve4: async () => ["127.0.0.1"],
    resolve6: async () => [],
  };
  assert.deepEqual(await lookupPreview("https://public-looking.example.com", fetcher, privateDns), {
    image: null, source: "placeholder", status: "failed",
  });
  assert.equal(calls, 0);
});

test("DNS check validates each redirect destination before fetching", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return new Response(null, { status: 302, headers: { location: "https://private.example.com/" } });
  }) as typeof fetch;
  const redirectDns: DnsResolver = {
    resolve4: async (host) => [host === "private.example.com" ? "10.0.0.1" : "1.1.1.1"],
    resolve6: async () => [],
  };
  assert.deepEqual(await lookupPreview("https://example.com", fetcher, redirectDns), {
    image: null, source: "placeholder", status: "failed",
  });
  assert.deepEqual(requested, ["https://example.com/"]);
});

test("Twitter image follows invalid Open Graph URL and favicon is probed only as fallback", async () => {
  const requested: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    requested.push(String(input));
    return htmlResponse('<meta property="og:image" content="http://localhost/private"><meta name="twitter:image" content="/tweet.png">');
  }) as typeof fetch;
  assert.deepEqual(await lookupPreview("https://example.com", fetcher, publicDns), {
    image: "https://example.com/tweet.png", source: "twitter", status: "ready",
  });
  assert.deepEqual(requested, ["https://example.com/"]);
});

test("favicon fallback requires an image content type", async () => {
  const calls: string[] = [];
  const fetcher = (async (input: RequestInfo | URL) => {
    calls.push(String(input));
    if (calls.length === 1) return htmlResponse('<link rel="icon" href="/site.ico">');
    if (calls.length === 2) return new Response("icon", { headers: { "content-type": "image/x-icon" } });
    throw new Error("unexpected fetch");
  }) as typeof fetch;
  assert.deepEqual(await lookupPreview("https://example.com/article", fetcher, publicDns), {
    image: "https://example.com/site.ico", source: "favicon", status: "failed",
  });
  assert.deepEqual(calls, ["https://example.com/article", "https://example.com/site.ico"]);
});

test("non-HTML responses and metadata beyond the byte limit return a placeholder", async () => {
  const fetcher = (async (input: RequestInfo | URL) => {
    if (String(input).endsWith("favicon.ico")) return new Response("missing", { status: 404 });
    return htmlResponse(`${" ".repeat(260 * 1024)}<meta property="og:image" content="https://cdn.example/too-late.png">`);
  }) as typeof fetch;
  assert.deepEqual(await lookupPreview("https://example.com", fetcher, publicDns), {
    image: null, source: "placeholder", status: "failed",
  });
});

test("preview route requires a session and validates URL and request fields before lookup", async t => {
  const store = createTestDatabase();
  t.after(() => store.close());
  const env = { DB: store.db } as Env;
  const token = `bff_us_${"a".repeat(64)}`;
  store.sqlite.prepare("INSERT INTO users(id,email) VALUES (?,?)").run("preview-user", "person@example.com");
  store.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
    .run(createHash("sha256").update(token).digest("hex"), "preview-user", "2099-01-01T00:00:00.000Z");
  const request = (body: unknown, authenticated: boolean) => handleRequest(new Request("https://api.yapern.com/og-image", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(authenticated ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  }), env);
  const valid = { url: "https://example.com" };
  const unauthorized = await request(valid, false);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: "invalid_session" });
  for (const body of [
    { ...valid, url: "http://127.0.0.1/admin" },
    { ...valid, extra: true },
    { ...valid, projectId: "legacy-project" },
  ]) {
    const response = await request(body, true);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "invalid_request" });
  }
});

test("preview routes poll privately, expose retry headers, and serve public R2 JPEGs", async t => {
  const store = createTestDatabase();
  t.after(() => store.close());
  const id = "861232f2-d908-438f-b3ba-f46f718254e8";
  const token = `bff_us_${"a".repeat(64)}`;
  const origin = "https://api.yapern.com";
  const authorization = `Bearer ${token}`;
  store.sqlite.prepare("INSERT INTO users(id,email) VALUES (?,?)").run("preview-user", "person@example.com");
  store.sqlite.prepare("INSERT INTO sessions(token_hash,user_id,expires_at) VALUES (?,?,?)")
    .run(createHash("sha256").update(token).digest("hex"), "preview-user", "2099-01-01T00:00:00.000Z");
  store.sqlite.prepare(`INSERT INTO link_previews(id,user_id,url_hash,url,state,lease_until,expires_at,created_at)
    VALUES(?,?,?,?,'pending',?,?,?)`).run(id, "preview-user", createHash("sha256").update("https://example.com/").digest("hex"),
      "https://example.com/", Date.now() + 120_000, Date.now() + 3600_000, Date.now());
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xd9]);
  let reads = 0;
  const env = { DB: store.db, BUCKET: {
    get: async () => { reads++; return { body: new Response(jpeg).body, size: jpeg.length, httpEtag: '"test"' }; },
    head: async () => ({ size: jpeg.length, httpEtag: '"test"' }),
  } } as unknown as Env;
  t.mock.method(globalThis, "fetch", () => assert.fail("Cached previews must not fetch metadata"));
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`${origin}${path}`, init), env);
  const preflight = await request(`/previews/${id}`, { method: "OPTIONS", headers: {
    origin: "https://yapern.com", "access-control-request-method": "GET",
    "access-control-request-headers": "authorization",
  } });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get("access-control-allow-origin"), "https://yapern.com");
  assert.equal((await request(`/previews/${id}`)).status, 401);
  assert.equal((await request(`/previews/${id}`, { headers: { authorization, origin: "https://evil.example" } })).status, 403);
  const pending = await request(`/previews/${id}`, { headers: { authorization, origin: "https://yapern.com" } });
  assert.equal(pending.status, 202);
  assert.equal(pending.headers.get("retry-after"), "3");
  assert.equal(pending.headers.get("access-control-expose-headers"), "Retry-After");
  assert.deepEqual(await pending.json(), { image: null, source: "placeholder", status: "pending", previewId: id,
    statusUrl: `${origin}/previews/${id}` });
  const otherId = "1fb3ca45-cc7f-438d-8d94-d8fd1c039222";
  assert.equal((await request(`/previews/${otherId}`, { headers: { authorization } })).status, 404);
  assert.equal((await request(`/preview-images/${id}.jpg`)).status, 404);
  store.sqlite.prepare("UPDATE link_previews SET state='ready',object_key='cached.jpg',lease_until=0 WHERE id=?").run(id);
  const cached = await request("/og-image", { method: "POST", headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify({ url: "https://example.com/#fragment" }) });
  assert.equal(cached.status, 200);
  const ready = await cached.json() as { image: string; source: string; status: string };
  assert.equal(ready.image, `${origin}/preview-images/${id}.jpg`);
  assert.equal(ready.source, "screenshot");
  assert.equal(ready.status, "ready");
  const image = await request(`/preview-images/${id}.jpg`, { headers: { origin: "https://other.example" } });
  assert.equal(image.status, 200);
  assert.equal(image.headers.get("content-type"), "image/jpeg");
  assert.equal(image.headers.get("content-length"), String(jpeg.length));
  assert.equal(image.headers.get("etag"), '"test"');
  assert.equal(image.headers.get("access-control-allow-origin"), "*");
  assert.match(image.headers.get("cache-control")!, /^public, max-age=/);
  assert.equal(image.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), jpeg);
  const head = await request(`/preview-images/${id}.jpg`, { method: "HEAD" });
  assert.equal(head.status, 200);
  assert.equal(await head.text(), "");
  assert.equal(reads, 1, "HEAD reads R2 metadata without fetching the body");
  store.sqlite.prepare("UPDATE link_previews SET expires_at=0 WHERE id=?").run(id);
  assert.equal((await request(`/preview-images/${id}.jpg`)).status, 404);
});
