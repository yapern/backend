import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { handleRequest } from "./router";
import { consumeCrawls, latestCrawl, recoverCrawls, startCrawl } from "./crawl-jobs";
import { CrawlFailure, discoverArticles, type Article } from "./crawl-discovery";
import { createTestDatabase } from "../testing/database";
import { ApiError } from "./contracts";

const articles: Article[] = [
  { url: "https://publisher.com/newest", title: "Newest article", summary: "Short summary.", publishedAt: "2024-02-02T00:00:00.000Z" },
  { url: "https://publisher.com/older", title: "Older article", summary: "Older summary.", publishedAt: "2024-02-01T00:00:00.000Z" },
];

async function fixture(t: TestContext) {
  const store = createTestDatabase();
  t.after(() => store.close());
  const queued: unknown[] = [];
  let failDispatch = false;
  const env = { DB: store.db, PREVIEW_QUEUE: { async send(body: unknown) { queued.push(body); if (failDispatch) throw new Error("acknowledgement lost"); } } } as unknown as Env;
  const request = (path: string, init: RequestInit = {}) => handleRequest(new Request(`https://api.yapern.com${path}`, init), env);
  const signIn = async (email: string) => {
    const response = await request("/auth/email", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ email, password: "correct horse battery" }) });
    assert.equal(response.status, 201);
    return response.json() as Promise<{ token: string; user: { id: string } }>;
  };
  const owner = await signIn("crawl-owner@example.com");
  store.sqlite.prepare("INSERT INTO boards(id,slug,name,user_id) VALUES('crawl-board','crawl-board','Crawl Board',?)").run(owner.user.id);
  for (const id of ["site-one", "site-two"]) store.sqlite.prepare("INSERT INTO board_crawler_urls(id,board_id,url) VALUES(?,'crawl-board',?)").run(id, `https://publisher.com/${id}`);
  const headers = { authorization: `Bearer ${owner.token}`, origin: "https://yapern.com" };
  const path = "/boards/crawl-board/crawler-urls/site-one/crawl";
  const post = () => request(path, { method: "POST", headers });
  const start = (sourceId = "site-one") => startCrawl(env, "crawl-board", sourceId, owner.user.id);
  const messages = () => store.sqlite.prepare("SELECT id,board_id,user_id,title,body,created_at FROM messages WHERE board_id='crawl-board' ORDER BY created_at DESC").all();
  const deliver = async (body = queued.at(-1), discover: typeof discoverArticles = async () => ({ articles, skipped: 0 })) => {
    const actions = { ack: 0, retry: 0 };
    const batch = { messages: [{ body, ack() { actions.ack++; }, retry() { actions.retry++; } }] } as unknown as MessageBatch<unknown>;
    await consumeCrawls(batch, env, discover);
    return actions;
  };
  return { store, env, queued, request, signIn, owner, headers, path, post, start, messages, deliver, failDispatch(value: boolean) { failDispatch = value; } };
}

test("crawl endpoint queues one active job, enforces ownership, supports polling and resumes status on the saved site", async t => {
  const f = await fixture(t);
  assert.deepEqual(await (await f.request(f.path, { headers: f.headers })).json(), { data: null });
  const response = await f.post();
  assert.equal(response.status, 202);
  assert.equal(response.headers.get("access-control-allow-origin"), "https://yapern.com");
  const job = (await response.json() as { data: { id: string; state: string } }).data;
  assert.equal(job.state, "queued");
  assert.deepEqual(f.queued, [{ kind: "crawl", id: job.id }]);
  assert.equal((await (await f.post()).json() as any).data.id, job.id);
  assert.equal(f.queued.length, 1);
  const list = await f.request("/boards/crawl-board/crawler-urls", { headers: f.headers });
  assert.equal((await list.json() as any).data[0].crawl.id, job.id);
  const other = await f.signIn("other-crawl-owner@example.com");
  for (const method of ["GET", "POST"]) {
    assert.equal((await f.request(f.path, { method })).status, 401);
    assert.equal((await f.request(f.path, { method, headers: { authorization: `Bearer ${other.token}` } })).status, 403);
    assert.equal((await f.request(f.path.replace("site-one", "missing"), { method, headers: f.headers })).status, 404);
    assert.equal((await f.request(f.path.replace("crawl-board", "general"), { method, headers: f.headers })).status, 403);
  }
});

test("crawl jobs create normal board messages, retain article references, seed votes and avoid duplicates across deliveries, runs and sources", async t => {
  const f = await fixture(t);
  const job = await f.start();
  const body = f.queued[0];
  assert.deepEqual(await f.deliver(body), { ack: 1, retry: 0 });
  const messages = f.messages();
  assert.deepEqual(messages.map(row => row.title), ["Newest article", "Older article"]);
  assert.ok(messages.every(row => row.board_id === "crawl-board" && row.user_id === f.owner.user.id));
  assert.equal(messages[0].body, "https://publisher.com/newest\n\nShort summary.");
  assert.equal(f.store.sqlite.prepare("SELECT value FROM message_votes WHERE message_id=? AND user_id=?").get(messages[0].id!, f.owner.user.id)?.value, 1);
  assert.deepEqual((await latestCrawl(f.env, "crawl-board", "site-one"))?.added_count, 2);
  await f.deliver(body);
  assert.equal(f.messages().length, 2, "redelivery of a completed job is a no-op");
  await f.start();
  await f.deliver();
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.added_count, 0);
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.skipped_count, 2);
  await f.start("site-two");
  await f.deliver();
  assert.equal(f.messages().length, 2, "overlapping sources share board-wide deduplication");
  f.store.sqlite.prepare("DELETE FROM messages WHERE id=?").run(messages[0].id!);
  await f.start();
  await f.deliver();
  assert.equal(f.messages().length, 1, "a deleted message is not recreated");
  assert.equal(f.store.sqlite.prepare("SELECT published_at FROM board_crawled_articles WHERE board_id='crawl-board' AND url=?").get(articles[0].url)?.published_at, articles[0].publishedAt);
  assert.equal(f.store.sqlite.prepare("SELECT state FROM board_crawl_jobs WHERE id=?").get(job.id)?.state, "succeeded");
});

test("queued crawl follows robots and a discovered RSS feed through to messages in the referenced sub-yap", async t => {
  const f = await fixture(t);
  await f.start();
  const requested: string[] = [];
  const documents: Record<string, string> = {
    "/robots.txt": "User-agent: *\nAllow: /",
    "/site-one": '<link rel="alternate" type="application/rss+xml" href="/feed.xml">',
    "/feed.xml": '<rss><channel><item><title>A recent article</title><link>https://publisher.com/newest</link><description>Feed summary.</description></item></channel></rss>',
    "/newest": '<html><head><meta property="og:title" content="A recent article"></head><body><h1>A recent article</h1></body></html>',
  };
  const fetcher: typeof fetch = async (input, options) => {
    assert.equal(new Headers(options?.headers).get("user-agent"), "yapern.com crawler v1.0.0");
    const url = new URL(String(input));
    requested.push(url.pathname);
    assert.equal(url.protocol, "https:");
    return new Response(documents[url.pathname] ?? "missing", { status: documents[url.pathname] === undefined ? 404 : 200 });
  };
  await f.deliver(undefined, (value, options) => discoverArticles(value, { ...options, fetcher,
    resolver: { resolve4: async () => ["1.1.1.1"], resolve6: async () => [] }, pause: async () => {} }));
  assert.deepEqual(requested, ["/robots.txt", "/site-one", "/feed.xml", "/newest"]);
  assert.equal(f.messages()[0].body, "https://publisher.com/newest\n\nFeed summary.");
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.state, "succeeded");
});

test("blocked or failed crawls persist safe status and do not post messages", async t => {
  const f = await fixture(t);
  for (const [code, state] of [["robots_blocked", "blocked"], ["robots_unavailable", "failed"], ["no_articles", "failed"]]) {
    await f.start();
    await f.deliver(undefined, async () => { throw new CrawlFailure(code); });
    const job = await latestCrawl(f.env, "crawl-board", "site-one");
    assert.equal(job?.state, state);
    assert.equal(job?.error, code);
    assert.ok(job?.finished_at);
    assert.equal(f.messages().length, 0);
  }
});

test("expired leases and lost queue acknowledgements recover without duplicate posts; exhausted attempts become failed", async t => {
  const f = await fixture(t);
  f.failDispatch(true);
  await assert.rejects(f.start(), error => error instanceof ApiError && error.code === "crawl_queue_unavailable");
  f.failDispatch(false);
  await recoverCrawls(f.env);
  assert.equal(f.queued.length, 2);
  await f.deliver(f.queued[0]);
  await f.deliver(f.queued[1]);
  assert.equal(f.messages().length, 2);
  const job = await f.start();
  f.store.sqlite.prepare("UPDATE board_crawl_jobs SET state='running',lease='dead-worker',lease_until=0 WHERE id=?").run(job.id);
  await recoverCrawls(f.env);
  await f.deliver();
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.state, "succeeded");
  const exhausted = await f.start();
  f.store.sqlite.prepare("UPDATE board_crawl_jobs SET state='running',attempts=3,lease_until=0 WHERE id=?").run(exhausted.id);
  await recoverCrawls(f.env);
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.state, "failed");
});

test("removing a source while a crawl is running prevents late message writes", async t => {
  const f = await fixture(t);
  await f.start();
  await f.deliver(undefined, async () => {
    f.store.sqlite.prepare("DELETE FROM board_crawler_urls WHERE id='site-one'").run();
    return { articles, skipped: 0 };
  });
  assert.equal(f.messages().length, 0);
  assert.equal(f.store.sqlite.prepare("SELECT COUNT(*) AS count FROM board_crawl_jobs").get()?.count, 0);
});

test("unsafe URLs and a missing queue reject the job before any fetch or post", async t => {
  const f = await fixture(t);
  f.store.sqlite.prepare("UPDATE board_crawler_urls SET url='http://localhost:9000' WHERE id='site-one'").run();
  assert.equal((await f.post()).status, 400);
  f.store.sqlite.prepare("UPDATE board_crawler_urls SET url='https://publisher.com' WHERE id='site-one'").run();
  await assert.rejects(startCrawl({ DB: f.env.DB } as Env, "crawl-board", "site-one", f.owner.user.id), error => error instanceof ApiError && error.status === 503);
  assert.equal(f.queued.length, 0);
  assert.equal(f.messages().length, 0);
});

test("failed jobs log the source, stage, exception, stack and nested cause", async t => {
  const f = await fixture(t);
  const logs: Array<{ label: string; details: any }> = [];
  t.mock.method(console, "warn", (label: string, details: unknown) => logs.push({ label, details }));
  await f.start();
  await f.deliver(undefined, async () => { throw new TypeError("fetch failed", { cause: new Error("TLS certificate expired") }); });
  const failed = logs.find(log => log.label === "[crawler] job failed")!.details;
  assert.equal(failed.sourceUrl, "https://publisher.com/site-one");
  assert.equal(failed.stage, "discovery");
  assert.equal(failed.code, "crawl_tls_failed");
  assert.equal(failed.error.name, "TypeError");
  assert.equal(failed.error.message, "fetch failed");
  assert.match(failed.error.stack, /TypeError: fetch failed/);
  assert.equal(failed.error.cause.message, "TLS certificate expired");
  assert.equal((await latestCrawl(f.env, "crawl-board", "site-one"))?.error, "crawl_tls_failed");
});
