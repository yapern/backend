import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { unstable_startWorker } from "wrangler";

test("crawler discovers and fetches articles using default fetch in the real Worker runtime", { timeout: 60_000 }, async t => {
  const directory = await mkdtemp(join(tmpdir(), "yapern-crawl-runtime-"));
  const seen: string[] = [];
  const api = createServer((request, response) => {
    assert.equal(request.headers["user-agent"], "yapern.com crawler v1.0.0");
    seen.push(request.url!);
    const documents: Record<string, string> = {
      "/robots.txt": "User-agent: *\nAllow: /",
      "/": '<html><head><link rel="alternate" type="application/rss+xml" href="/feed.xml"></head></html>',
      "/feed.xml": '<rss><channel><item><title>Runtime article</title><link>https://publisher.com/newest</link><description>Runtime summary.</description></item></channel></rss>',
      "/newest": '<html><head><meta property="og:title" content="Runtime article"></head></html>',
    };
    response.writeHead(documents[request.url!] === undefined ? 404 : 200);
    response.end(documents[request.url!] ?? "missing");
  });
  let worker: Awaited<ReturnType<typeof unstable_startWorker>> | undefined;
  t.after(async () => {
    await worker?.dispose();
    if (api.listening) await new Promise<void>(resolve => api.close(() => resolve()));
    await rm(directory, { recursive: true, force: true });
  });
  await new Promise<void>(resolve => api.listen(0, "127.0.0.1", resolve));
  const address = api.address();
  assert.ok(address && typeof address === "object");
  const fixtureOrigin = `http://127.0.0.1:${address.port}`;
  const modulePath = fileURLToPath(new URL("./crawl-discovery.ts", import.meta.url));
  await writeFile(join(directory, "worker.ts"), `
    import { discoverArticles } from ${JSON.stringify(modulePath)};
    export default { async fetch() {
      const nativeFetch = globalThis.fetch;
      globalThis.fetch = function(input, init) {
        if (this !== globalThis) throw new TypeError('Illegal invocation: incorrect fetch receiver');
        return nativeFetch.call(globalThis, ${JSON.stringify(fixtureOrigin)} + new URL(input).pathname, init);
      };
      try {
        const result = await discoverArticles('https://publisher.com/', {
          resolver: { resolve4: async () => ['1.1.1.1'], resolve6: async () => [] },
          pause: async () => {},
        });
        return Response.json(result);
      } catch (error) { return Response.json({ error: error.message, stack: error.stack }, { status: 500 }); }
      finally { globalThis.fetch = nativeFetch; }
    } };
  `);
  const config = join(directory, "wrangler.jsonc");
  await writeFile(config, JSON.stringify({ name: "yapern-crawl-runtime-test", main: "worker.ts", compatibility_date: "2026-09-18", compatibility_flags: ["nodejs_compat"] }));
  worker = await unstable_startWorker({ config,
    dev: { watch: false, persist: false, remote: false, server: { hostname: "127.0.0.1", port: 0 } },
  });
  await worker.ready;
  const response = await worker.fetch("https://test.local/");
  assert.equal(response.status, 200, await response.clone().text());
  const payload = await response.json() as { articles: { url: string; title: string }[]; skipped: number };
  assert.equal(payload.articles[0].url, "https://publisher.com/newest");
  assert.equal(payload.articles[0].title, "Runtime article");
  assert.deepEqual(seen, ["/robots.txt", "/", "/feed.xml", "/newest"]);
});
