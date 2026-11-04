import { setTimeout as wait } from "node:timers/promises";
import robotsParser from "robots-parser";
import { XMLParser } from "fast-xml-parser";
import { convert } from "html-to-text";
import { checkPublicDns, defaultResolver, safePublicUrl, type DnsResolver } from "./preview-metadata";

export const CRAWLER_USER_AGENT = "yapern.com crawler v1.0.0";
export const CRAWL_PAGE_SIZE = 20;
const MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
const MAX_REQUESTS = 45;
export class CrawlFailure extends Error {}
export type Article = { url: string; title: string; summary: string; publishedAt: string | null };
type Candidate = Partial<Article> & { url: string; fromSitemap?: boolean };
type Document = { text: string; url: URL; headers: Headers };
type Options = { fetcher?: typeof fetch; resolver?: DnsResolver; signal?: AbortSignal; pause?: (ms: number, signal: AbortSignal) => Promise<void>; seen?: (url: string) => Promise<boolean> };

export function crawlUrl(value: string, base?: URL): URL | null {
  const url = safePublicUrl(value, base);
  if (!url) return null;
  url.protocol = "https:";
  return url;
}

function articleUrl(value: string, base: URL): URL | null {
  const url = crawlUrl(value, base);
  if (url) for (const key of [...url.searchParams.keys()]) {
    if (/^(?:utm_.+|fbclid|gclid)$/i.test(key)) url.searchParams.delete(key);
  }
  return url;
}

const plain = (value: unknown, limit = 700): string => convert(typeof value === "string" ? value : "", {
  wordwrap: false, selectors: [{ selector: "a", options: { ignoreHref: true } }, { selector: "img", format: "skip" }],
}).replace(/\s+/g, " ").trim().slice(0, limit);
const text = (value: any): string => typeof value === "string" ? value : typeof value?.["#text"] === "string" ? value["#text"] : "";
const array = <T>(value: T | T[] | undefined): T[] => value === undefined ? [] : Array.isArray(value) ? value : [value];
const date = (value: unknown): string | null => typeof value === "string" && Number.isFinite(Date.parse(value)) &&
  Date.parse(value) <= Date.now() + 86_400_000 ? new Date(value).toISOString() : null;
const newest = <T extends { publishedAt?: string | null }>(values: T[]): T[] => values.sort((a, b) =>
  (b.publishedAt ? Date.parse(b.publishedAt) : 0) - (a.publishedAt ? Date.parse(a.publishedAt) : 0));

// Map matching product tokens onto one parser group. robots-parser itself uses
// exact agent matching; REP selects and combines the most specific matches.
function robotsFor(origin: string, content: string) {
  const agent = /^\s*user-agent\s*:\s*([^#\r\n]*)/gim;
  const matches = [...content.matchAll(agent)].map(match => match[1].trim().toLowerCase())
    .filter(value => value !== "*" && value && CRAWLER_USER_AGENT.includes(value));
  const length = Math.max(0, ...matches.map(value => value.length));
  return robotsParser(`${origin}/robots.txt`, content.replace(agent, (line, value: string) =>
    value.trim().length === length && matches.includes(value.trim().toLowerCase()) ? "User-agent: yapern" : line));
}

export class CrawlAccess {
  private policies = new Map<string, Promise<ReturnType<typeof robotsFor>>>();
  private nextRequest = new Map<string, number>();
  private requests = 0;
  readonly signal: AbortSignal;
  private readonly fetcher: typeof fetch;
  private readonly resolver: DnsResolver;
  private readonly pause: NonNullable<Options["pause"]>;

  constructor(options: Options = {}) {
    this.fetcher = options.fetcher ?? fetch;
    this.resolver = options.resolver ?? defaultResolver;
    this.signal = options.signal ?? AbortSignal.timeout(90_000);
    this.pause = options.pause ?? (async (ms, signal) => { await wait(ms, undefined, { signal }); });
  }

  private async request(start: URL, robots: boolean): Promise<Document | null> {
    let url = start;
    for (let redirects = 0; redirects <= 5; redirects++) {
      this.signal.throwIfAborted();
      if (++this.requests > MAX_REQUESTS) throw new CrawlFailure("crawl_limit");
      if (!robots && !await this.allowed(url)) throw new CrawlFailure("robots_blocked");
      const remaining = (this.nextRequest.get(url.origin) ?? 0) - Date.now();
      if (remaining > 0) await this.pause(remaining, this.signal);
      const signal = AbortSignal.any([this.signal, AbortSignal.timeout(8_000)]);
      await checkPublicDns(url.hostname, this.resolver, signal);
      const policy = !robots ? await this.policy(url) : null;
      const delay = Math.max(250, (policy?.getCrawlDelay("yapern") ?? 0) * 1000);
      this.nextRequest.set(url.origin, Date.now() + delay);
      const response = await this.fetcher(url.href, {
        redirect: "manual", signal,
        headers: { "user-agent": CRAWLER_USER_AGENT, accept: robots ? "text/plain" : "text/html,application/rss+xml,application/atom+xml,application/xml,text/xml;q=0.9,application/feed+json;q=0.8" },
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        const location = response.headers.get("location");
        await response.body?.cancel();
        const next = location && safePublicUrl(location, url);
        if (!next || next.protocol !== "https:" || redirects === 5) throw new CrawlFailure("unsafe_redirect");
        url = next;
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        if (robots && [404, 410].includes(response.status)) return { text: "", url, headers: response.headers };
        if (robots) throw new CrawlFailure("robots_unavailable");
        return null;
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!robots && contentType && !/(?:text\/|xml|json)/i.test(contentType)) {
        await response.body?.cancel();
        return null;
      }
      const reader = response.body?.getReader();
      if (!reader) return { text: "", url, headers: response.headers };
      const decoder = new TextDecoder();
      let body = "", bytes = 0;
      try {
        while (true) {
          signal.throwIfAborted();
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > (robots ? 512 * 1024 : MAX_DOCUMENT_BYTES)) throw new CrawlFailure("document_too_large");
          body += decoder.decode(chunk.value, { stream: true });
        }
        body += decoder.decode();
      } finally { await reader.cancel().catch(() => {}); }
      if (robots && /<html\b|<!doctype\s+html/i.test(body)) throw new CrawlFailure("robots_unavailable");
      return { text: body, url, headers: response.headers };
    }
    throw new CrawlFailure("unsafe_redirect");
  }

  async policy(url: URL) {
    let pending = this.policies.get(url.origin);
    if (!pending) {
      pending = this.request(new URL("/robots.txt", url), true).then(document => robotsFor(url.origin, document?.text ?? ""));
      this.policies.set(url.origin, pending);
    }
    return pending;
  }
  async allowed(url: URL): Promise<boolean> { return (await this.policy(url)).isAllowed(url.href, "yapern") === true; }
  async document(url: URL): Promise<Document | null> { return this.request(url, false); }
}

function xml(content: string): any {
  if (/<!DOCTYPE|<!ENTITY/i.test(content)) throw new CrawlFailure("invalid_feed");
  return new XMLParser({ ignoreAttributes: false, attributeNamePrefix: "@", removeNSPrefix: true,
    parseTagValue: false, processEntities: false, ignoreDeclaration: true }).parse(content, true);
}

export function parseFeed(content: string, base: URL): Candidate[] | null {
  if (/^\s*\{/.test(content)) {
    const data = JSON.parse(content);
    if (!String(data.version).startsWith("https://jsonfeed.org/version/")) return null;
    return newest(array<any>(data.items).flatMap(item => {
      const url = articleUrl(item.url ?? item.external_url ?? "", base);
      return url ? [{ url: url.href, title: plain(item.title, 200), summary: plain(item.summary ?? item.content_html ?? item.content_text), publishedAt: date(item.date_published) }] : [];
    }));
  }
  if (!/<(?:\w+:)?(?:rss|feed|RDF)\b/i.test(content)) return null;
  const data = xml(content);
  const entries = data.rss?.channel?.item ?? data.feed?.entry ?? data.RDF?.item;
  return newest(array<any>(entries).flatMap(item => {
    const links = array<any>(item.link);
    const link = links.find(value => typeof value === "string" || !value["@rel"] || value["@rel"] === "alternate");
    const url = articleUrl(plain(text(link) || link?.["@href"] || (item.guid?.["@isPermaLink"] !== "false" ? text(item.guid) : ""), 2048), base);
    return url ? [{ url: url.href, title: plain(text(item.title), 200), summary: plain(text(item.description ?? item.summary ?? item.content ?? item.encoded)),
      publishedAt: date(text(item.pubDate ?? item.published ?? item.date ?? item.updated)) }] : [];
  }));
}

function attributes(tag: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of tag.matchAll(/([\w:-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/g)) {
    attrs[match[1].toLowerCase()] = plain(match[2] ?? match[3] ?? match[4], 2048);
  }
  return attrs;
}

function cleanHtml(content: string): string {
  return content.replace(/<!--[\s\S]*?-->/g, "").replace(/<(script|style|svg)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
}

export function pageMetadata(content: string, base: URL) {
  const html = cleanHtml(content);
  const meta: Record<string, string> = {};
  const feeds: URL[] = [];
  let canonical: URL | null = null;
  for (const match of html.matchAll(/<(?:meta|link)\b(?:"[^"]*"|'[^']*'|[^'">])*>/gi)) {
    const attrs = attributes(match[0]);
    const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
    if (key && attrs.content && !meta[key]) meta[key] = attrs.content;
    const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
    const url = attrs.href && crawlUrl(attrs.href, base);
    if (url && rel.includes("alternate") && /(?:rss|atom|feed\+json)/i.test(attrs.type ?? "")) feeds.push(url);
    if (url && rel.includes("canonical")) canonical = articleUrl(url.href, base);
  }
  return { feeds, canonical, noindex: /\b(?:noindex|none)\b/i.test(`${meta.robots ?? ""} ${meta.yapern ?? ""}`),
    title: plain(meta["og:title"] || meta["twitter:title"] || /<h1\b[^>]*>([\s\S]*?)<\/h1>/i.exec(html)?.[1] || /<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(html)?.[1], 200),
    summary: plain(meta.description || meta["og:description"] || meta["twitter:description"]),
    publishedAt: date(meta["article:published_time"] || meta.date || /<time\b[^>]*datetime\s*=\s*["']([^"']+)/i.exec(html)?.[1]),
    article: /article|blogposting|newsarticle/i.test(`${meta["og:type"] ?? ""} ${content.match(/"@type"\s*:\s*"[^"]+"/g)?.join(" ") ?? ""}`),
  };
}

function firstPageLinks(content: string, base: URL): Candidate[] {
  const html = cleanHtml(content);
  const main = /<main\b[^>]*>([\s\S]*?)<\/main>/i.exec(html)?.[1] ?? html;
  const articles = [...main.matchAll(/<article\b[^>]*>([\s\S]*?)<\/article>/gi)].map(match => match[1]);
  const scope = articles.length ? articles.join("\n") : main.replace(/<(nav|header|footer|aside)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
  return [...scope.matchAll(/<a\b((?:"[^"]*"|'[^']*'|[^'">])*)>([\s\S]*?)<\/a>/gi)].flatMap(match => {
    const attrs = attributes(match[1]);
    const url = attrs.href && articleUrl(attrs.href, base);
    const title = plain(match[2], 200);
    return url && url.pathname !== base.pathname && title.length >= 8 && !/\b(?:nofollow|next|prev)\b/i.test(attrs.rel ?? "") &&
      !/\/(?:tag|tags|categor(?:y|ies)|author|about|contact|login|privacy|terms|page)(?:\/|$)/i.test(url.pathname) &&
      !/\.(?:jpg|png|pdf|zip|xml|json)$/i.test(url.pathname) ? [{ url: url.href, title }] : [];
  });
}

export async function discoverArticles(value: string, options: Options = {}): Promise<{ articles: Article[]; skipped: number }> {
  const start = crawlUrl(value);
  if (!start) throw new CrawlFailure("unsafe_url");
  const access = new CrawlAccess(options);
  // Always resolve robots before any other document on this origin.
  if (!await access.allowed(start)) throw new CrawlFailure("robots_blocked");
  const page = await access.document(start);
  if (!page) throw new CrawlFailure("site_unavailable");
  const sameSite = (url: URL) => url.hostname.replace(/^www\./, "") === page.url.hostname.replace(/^www\./, "");
  const metadata = pageMetadata(page.text, page.url);
  let candidates = parseFeed(page.text, page.url);
  const tried = new Set<string>([page.url.href]);
  const optional = async (url: URL) => {
    if (tried.has(url.href)) return null;
    tried.add(url.href);
    try { return await access.document(url); }
    catch (error) {
      if (access.signal.aborted || (error instanceof CrawlFailure && ["crawl_limit"].includes(error.message))) throw error;
      return null;
    }
  };
  for (const feed of [...metadata.feeds.slice(0, 3), ...["feed", "rss.xml", "atom.xml"].map(path => new URL(path, new URL("./", page.url)))]) {
    if (candidates?.length) break;
    const document = await optional(feed);
    if (document) { try { candidates = parseFeed(document.text, document.url); } catch { /* Try the next discovery format. */ } }
  }
  if (!candidates?.length) {
    const sitemaps = [...(await access.policy(start)).getSitemaps().slice(0, 3), new URL("/sitemap.xml", page.url).href];
    const found: Candidate[] = [];
    for (let index = 0; index < sitemaps.length && index < 6; index++) {
      const target = crawlUrl(sitemaps[index], page.url);
      if (!target) continue;
      const document = await optional(target);
      if (!document) continue;
      try {
        const data = xml(document.text);
        const indexes = newest(array<any>(data.sitemapindex?.sitemap).map(item => ({ url: plain(text(item.loc), 2048), publishedAt: date(text(item.lastmod)) })));
        sitemaps.push(...indexes.slice(0, 3).map(item => item.url));
        for (const item of array<any>(data.urlset?.url)) {
          const url = articleUrl(plain(text(item.loc), 2048), document.url);
          if (url && sameSite(url) && url.pathname !== page.url.pathname && !/\.(?:jpg|png|pdf|xml)$/i.test(url.pathname)) {
            found.push({ url: url.href, publishedAt: date(text(item.news?.publication_date ?? item.lastmod)), title: plain(text(item.news?.title), 200), fromSitemap: true });
          }
        }
      } catch { /* A missing or invalid sitemap can fall back to the first page. */ }
    }
    candidates = newest(found);
  }
  const fallback = !candidates?.length;
  if (fallback) candidates = firstPageLinks(page.text, page.url);
  const unique = new Set<string>();
  const firstPage = candidates!.filter(candidate => {
    const url = crawlUrl(candidate.url);
    if (!url || !sameSite(url) || unique.has(url.href)) return false;
    unique.add(url.href);
    return true;
  }).slice(0, CRAWL_PAGE_SIZE);
  const articles: Article[] = [];
  let skipped = 0;
  for (const candidate of firstPage) {
    const target = crawlUrl(candidate.url)!;
    if (await options.seen?.(target.href)) { skipped++; continue; }
    const document = await optional(target);
    if (!document || !sameSite(document.url)) { skipped++; continue; }
    const details = pageMetadata(document.text, document.url);
    if (details.noindex || /\b(?:noindex|none)\b/i.test(document.headers.get("x-robots-tag") ?? "") ||
      (fallback && !details.article && !details.publishedAt) ||
      (candidate.fromSitemap && !details.article && !details.publishedAt && !candidate.title && !/\/20\d{2}\/\d{2}\//.test(target.pathname))) { skipped++; continue; }
    const canonical = details.canonical && sameSite(details.canonical) ? details.canonical : articleUrl(document.url.href, document.url)!;
    if (!await access.allowed(canonical)) { skipped++; continue; }
    const title = details.title || candidate.title || "";
    if (!title) { skipped++; continue; }
    articles.push({ url: canonical.href, title, summary: details.summary || candidate.summary || "", publishedAt: details.publishedAt || candidate.publishedAt || null });
  }
  if (!firstPage.length) throw new CrawlFailure("no_articles");
  return { articles: newest(articles), skipped };
}
