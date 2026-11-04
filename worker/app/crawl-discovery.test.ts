import test from "node:test";
import assert from "node:assert/strict";
import { CrawlAccess, CrawlFailure, CRAWLER_USER_AGENT, discoverArticles, parseFeed } from "./crawl-discovery";
import type { DnsResolver } from "./preview-metadata";

const origin = "https://publisher.com";
const publicDns: DnsResolver = { resolve4: async () => ["1.1.1.1"], resolve6: async () => [] };
const page = (title: string, extra = "") => `<html><head><meta property="og:type" content="article"><meta property="og:title" content="${title}"><meta name="description" content="A short &amp; useful summary.">${extra}</head><body><h1>${title}</h1></body></html>`;

function site(documents: Record<string, string | (() => Response)>) {
  const requests: string[] = [];
  const pauses: number[] = [];
  const fetcher: typeof fetch = async (input, options) => {
    const url = new URL(String(input));
    assert.equal(url.protocol, "https:");
    assert.equal(options?.redirect, "manual");
    assert.equal(new Headers(options?.headers).get("user-agent"), CRAWLER_USER_AGENT);
    assert.equal(new Headers(options?.headers).has("authorization"), false);
    requests.push(url.href);
    const response = documents[url.href] ?? documents[url.pathname];
    return typeof response === "function" ? response() : response !== undefined
      ? new Response(response, { headers: { "content-type": url.pathname === "/robots.txt" ? "text/plain" : "text/html" } })
      : new Response("missing", { status: 404 });
  };
  const options = { fetcher, resolver: publicDns, pause: async (ms: number) => { pauses.push(ms); } };
  return { requests, pauses, options };
}

test("RSS discovery imports only the newest first page, respects article rules, and skips already-seen URLs before fetching", async () => {
  const items = Array.from({ length: 24 }, (_, index) => `<item><title>Feed ${index}</title><link>${origin}/posts/${index}?utm_source=rss</link><pubDate>2024-10-${String(index + 1).padStart(2, "0")}T00:00:00Z</pubDate></item>`).join("");
  const f = site({
    "/robots.txt": "User-agent: *\nDisallow: /posts/22\nCrawl-delay: 1\n",
    "/": '<html><head><link rel="alternate" type="application/rss+xml" href="/news.xml"></head></html>',
    "/news.xml": `<rss version="2.0"><channel>${items}</channel></rss>`,
    ...Object.fromEntries(Array.from({ length: 24 }, (_, index) => [`/posts/${index}`, page(`Page ${index}`)])),
  });
  const result = await discoverArticles("http://publisher.com/", { ...f.options, seen: async url => url.endsWith("/23") });
  assert.equal(f.requests[0], `${origin}/robots.txt`);
  assert.equal(result.articles.length, 18);
  assert.equal(result.skipped, 2);
  assert.equal(result.articles[0].url, `${origin}/posts/21`);
  assert.equal(result.articles[0].title, "Page 21");
  assert.equal(result.articles[0].summary, "A short & useful summary.");
  assert.ok(!f.requests.some(url => /\/posts\/(?:23|22|0|1|2|3)$/.test(url)));
  assert.ok(f.pauses.some(ms => ms > 500));
});

test("robots rules choose the specific agent, merge its groups, and honor Allow, wildcards, query strings, and encoded paths", async () => {
  const f = site({ "/robots.txt": `User-agent: *\nAllow: /\n\nUser-agent: yapern\nDisallow: /private\nAllow: /private/public\nDisallow: /*?secret=*$\n\nUser-agent: Yapern\nDisallow: /caf%C3%A9\n` });
  const access = new CrawlAccess(f.options);
  assert.equal(await access.allowed(new URL(`${origin}/private/hidden`)), false);
  assert.equal(await access.allowed(new URL(`${origin}/private/public/article`)), true);
  assert.equal(await access.allowed(new URL(`${origin}/read?secret=yes`)), false);
  assert.equal(await access.allowed(new URL(`${origin}/caf%C3%A9`)), false);
  assert.equal(await access.allowed(new URL(`${origin}/read`)), true);
  assert.equal(f.requests.length, 1);
});

test("robots deny, unavailable robots, and private DNS stop crawling before the source page", async () => {
  for (const robots of ["User-agent: yapern.com\nDisallow: /", () => new Response("error", { status: 503 }), () => new Response("busy", { status: 429 }), "<html><title>Verify you are human</title></html>"]) {
    const f = site({ "/robots.txt": robots });
    await assert.rejects(discoverArticles(origin, f.options), error => error instanceof CrawlFailure && /robots_/.test(error.message));
    assert.deepEqual(f.requests, [`${origin}/robots.txt`]);
  }
  const f = site({});
  await assert.rejects(discoverArticles(origin, { ...f.options, resolver: { resolve4: async () => ["127.0.0.1"], resolve6: async () => [] } }));
  assert.deepEqual(f.requests, []);
  await assert.rejects(discoverArticles("https://127.0.0.1/", f.options), /unsafe_url/);
});

test("a missing robots file allows crawling, while redirects check each new origin's robots before its document", async () => {
  const f = site({
    [`${origin}/robots.txt`]: () => new Response("missing", { status: 404 }),
    "/": () => new Response(null, { status: 301, headers: { location: "https://www.publisher.com/news" } }),
    "https://www.publisher.com/robots.txt": "User-agent: *\nDisallow: /news",
  });
  await assert.rejects(discoverArticles(origin, f.options), /robots_blocked/);
  assert.deepEqual(f.requests, [`${origin}/robots.txt`, `${origin}/`, "https://www.publisher.com/robots.txt"]);
  const unsafe = site({ "/robots.txt": "", "/": () => new Response(null, { status: 302, headers: { location: "http://publisher.com/insecure" } }) });
  await assert.rejects(discoverArticles(origin, unsafe.options), /unsafe_redirect/);
});

test("RSS CDATA, Atom alternate links, JSON Feed, relative links and dates produce article candidates", () => {
  const base = new URL(`${origin}/news/`);
  const rss = parseFeed('<rss><channel><item><title><![CDATA[News &amp; updates]]></title><link>/one?a=1&amp;b=2</link><description><![CDATA[<p>Short <b>summary</b></p>]]></description></item></channel></rss>', base)!;
  assert.equal(rss[0].title, "News & updates");
  assert.equal(rss[0].url, `${origin}/one?a=1&b=2`);
  assert.equal(rss[0].summary, "Short summary");
  const atom = parseFeed('<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>Atom news</title><link rel="self" href="/self"/><link rel="alternate" href="../two"/><published>2024-01-01T00:00:00Z</published></entry></feed>', base)!;
  assert.equal(atom[0].url, `${origin}/two`);
  assert.equal(atom[0].publishedAt, "2024-01-01T00:00:00.000Z");
  const json = parseFeed(JSON.stringify({ version: "https://jsonfeed.org/version/1.1", items: [{ url: "/three", title: "JSON news", content_html: "<p>JSON summary</p>" }] }), base)!;
  assert.equal(json[0].url, `${origin}/three`);
  assert.equal(json[0].summary, "JSON summary");
  assert.throws(() => parseFeed('<!DOCTYPE rss [<!ENTITY bad "expansion">]><rss><channel/></rss>', base), /invalid_feed/);
});

test("sitemap indexes discover recent articles and exclude non-article pages", async () => {
  const f = site({
    "/robots.txt": `User-agent: *\nSitemap: ${origin}/index.xml`,
    "/": "<html><main>No feed available</main></html>",
    "/index.xml": `<sitemapindex><sitemap><loc>${origin}/posts.xml</loc><lastmod>2024-01-01</lastmod></sitemap></sitemapindex>`,
    "/posts.xml": `<urlset><url><loc>${origin}/news/older</loc><lastmod>2024-01-01</lastmod></url><url><loc>${origin}/news/latest</loc><lastmod>2024-01-03</lastmod></url><url><loc>${origin}/about</loc><lastmod>2024-01-02</lastmod></url></urlset>`,
    "/news/older": page("Older news"), "/news/latest": page("Latest news"), "/about": "<html><title>About our company</title></html>",
  });
  const result = await discoverArticles(origin, f.options);
  assert.deepEqual(result.articles.map(article => article.title), ["Latest news", "Older news"]);
  assert.equal(result.skipped, 1);
  assert.ok(f.requests.includes(`${origin}/posts.xml`));
});

test("first-page fallback ignores navigation and scripts, requires article evidence, respects noindex, and normalizes canonical URLs", async () => {
  const f = site({
    "/robots.txt": "User-agent: *\nAllow: /",
    "/": `<main><article><a href="/story?utm_source=home">Read our story</a></article><article><a href="/private-story">Another article</a></article><article><a href="/products">Our popular products</a></article></main><script><a href="/fake">Fake article</a></script><nav><a href="/category/news">News category</a></nav>`,
    "/story": page("A real article", '<link rel="canonical" href="/canonical-story?utm_source=canonical#section">'),
    "/private-story": page("Private story", '<meta name="robots" content="noindex">'),
    "/products": "<html><title>Our products</title><h1>Products</h1></html>",
  });
  const result = await discoverArticles(origin, f.options);
  assert.equal(result.articles.length, 1);
  assert.equal(result.articles[0].url, `${origin}/canonical-story`);
  assert.equal(result.skipped, 2);
  assert.ok(!f.requests.some(url => /\/fake|\/category/.test(url)));
});

test("redirected articles cannot bypass robots and off-site feed entries are not imported", async () => {
  const f = site({
    "/robots.txt": "User-agent: *\nDisallow: /private",
    "/": `<rss><channel><item><link>${origin}/redirect</link></item><item><link>https://other.com/article</link></item></channel></rss>`,
    "/redirect": () => new Response(null, { status: 302, headers: { location: "/private/article" } }),
  });
  const result = await discoverArticles(origin, f.options);
  assert.deepEqual(result.articles, []);
  assert.equal(result.skipped, 1);
  assert.ok(!f.requests.some(url => url.includes("/private") || url.includes("other.com")));
});
