import { resolve4, resolve6 } from "node:dns/promises";
import { isIP } from "node:net";
import { ApiError } from "./contracts";

const MAX_HTML_BYTES = 256 * 1024;
const MAX_REDIRECTS = 3;
const FETCH_TIMEOUT_MS = 8_000;
const MAX_URL_LENGTH = 2_048;

export type MetadataPreview = {
  image: string | null;
  source: "og" | "twitter" | "favicon" | "placeholder";
  status: "ready" | "failed";
};

export type DnsResolver = {
  resolve4(hostname: string): Promise<string[]>;
  resolve6(hostname: string): Promise<string[]>;
};

export const defaultResolver: DnsResolver = { resolve4, resolve6 };

/** Reject network destinations that can target a local or private service. */
export function safePublicUrl(value: string, base?: string | URL): URL | null {
  try {
    if (value.length > MAX_URL_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) return null;
    const url = new URL(value, base);
    if (!(["http:", "https:"].includes(url.protocol)) || url.username || url.password || url.port) return null;
    const host = url.hostname.toLowerCase();
    // URL canonicalizes decimal, octal, and hexadecimal IPv4 addresses before this check.
    // IP literals are excluded because they can directly address private networks.
    if (host.startsWith("[") || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
    if (!/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(host)) return null;
    if (host.split(".").some((label) => label.startsWith("-") || label.endsWith("-"))) return null;
    if (/\.(?:localhost|local|internal|lan|home|corp|onion|invalid|arpa)$/i.test(host)) return null;
    // A numeric final label is a common spelling of an IPv4 address or internal host.
    if (/^\d+$/.test(host.split(".").at(-1)!)) return null;
    url.hash = "";
    return url;
  } catch {
    return null;
  }
}

export function isPublicAddress(value: string): boolean {
  const family = isIP(value);
  if (family === 4) {
    const [a, b, c] = value.split(".").map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
    if (a === 100 && b >= 64 && b <= 127) return false;
    if (a === 169 && b === 254) return false;
    if (a === 172 && b >= 16 && b <= 31) return false;
    if (a === 192 && (b === 0 || (b === 168) || (b === 88 && c === 99))) return false;
    if (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) return false;
    if (a === 203 && b === 0 && c === 113) return false;
    return true;
  }
  if (family === 6) {
    const address = value.toLowerCase();
    // Global unicast is 2000::/3. Exclude its documentation and transition ranges.
    if (!/^[23][0-9a-f]{0,3}:/.test(address)) return false;
    const [first, second = 0] = address.split(":").map((part) => Number.parseInt(part || "0", 16));
    if (first === 0x2002) return false; // 6to4 can embed a private IPv4 destination.
    if (first === 0x2001 && (second === 0 || second === 0xdb8 ||
      (second >= 0x10 && second <= 0x2f))) return false;
    return true;
  }
  return false;
}

export async function checkPublicDns(hostname: string, resolver: DnsResolver, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  let abortListener: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    abortListener = () => reject(signal.reason);
    signal.addEventListener("abort", abortListener, { once: true });
  });
  try {
    const results = await Promise.race([
      Promise.allSettled([resolver.resolve4(hostname), resolver.resolve6(hostname)]),
      aborted,
    ]);
    const addresses = results.flatMap((result) => result.status === "fulfilled" ? result.value : []);
    if (addresses.length === 0 || addresses.some((address) => !isPublicAddress(address))) {
      throw new Error("Unsafe preview DNS destination");
    }
  } finally {
    if (abortListener) signal.removeEventListener("abort", abortListener);
  }
}

function decodeEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|[0-9]+)|amp|quot|apos|lt|gt|nbsp);?/gi, (match, entity: string) => {
    const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">", nbsp: " " };
    if (!entity.startsWith("#")) return named[entity.toLowerCase()] ?? match;
    const hex = entity[1]?.toLowerCase() === "x";
    const codePoint = Number.parseInt(entity.slice(hex ? 2 : 1), hex ? 16 : 10);
    return codePoint > 0 && codePoint <= 0x10ffff && !(codePoint >= 0xd800 && codePoint <= 0xdfff)
      ? String.fromCodePoint(codePoint) : match;
  });
}

function attributes(tag: string): Record<string, string> {
  const result: Record<string, string> = {};
  const firstSpace = tag.search(/\s/);
  if (firstSpace < 0) return result;
  const attributePattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of tag.slice(firstSpace).matchAll(attributePattern)) {
    const key = match[1].toLowerCase();
    if (!(key in result)) result[key] = decodeEntities(match[2] ?? match[3] ?? match[4] ?? "");
  }
  return result;
}

function tagEnd(html: string, from: number): number {
  let quote = "";
  for (let i = from; i < html.length; i++) {
    const char = html[i];
    if (quote) {
      if (char === quote) quote = "";
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === ">") {
      return i + 1;
    }
  }
  return html.length;
}

export function extractMetadata(html: string, pageUrl: URL): { og: URL | null; twitter: URL | null; favicon: URL | null } {
  let base = pageUrl;
  let baseSeen = false;
  let og: URL | null = null;
  let twitter: URL | null = null;
  let favicon: URL | null = null;
  const tags = /<!--|<(?:meta|link|base|script|style|\/head|body)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = tags.exec(html))) {
    if (match[0] === "<!--") {
      const close = html.indexOf("-->", tags.lastIndex);
      if (close < 0) break;
      tags.lastIndex = close + 3;
      continue;
    }
    const name = match[0].slice(1).toLowerCase();
    if (name === "/head" || name === "body") break;
    const end = tagEnd(html, tags.lastIndex);
    const tag = html.slice(match.index, end);
    tags.lastIndex = end;
    if (name === "script" || name === "style") {
      const close = html.slice(end).search(new RegExp(`</${name}\\s*>`, "i"));
      if (close >= 0) tags.lastIndex = end + close + name.length + 3;
      continue;
    }
    const attrs = attributes(tag);
    if (name === "base" && attrs.href && !baseSeen) {
      baseSeen = true;
      base = safePublicUrl(attrs.href, pageUrl) ?? base;
    } else if (name === "meta" && attrs.content) {
      const key = (attrs.property ?? attrs.name ?? "").toLowerCase();
      if ((key === "og:image" || key === "og:image:url" || key === "og:image:secure_url") && !og) {
        og = safePublicUrl(attrs.content.trim(), base);
      } else if ((key === "twitter:image" || key === "twitter:image:src") && !twitter) {
        twitter = safePublicUrl(attrs.content.trim(), base);
      }
    } else if (name === "link" && attrs.href && !favicon) {
      const rel = (attrs.rel ?? "").toLowerCase().split(/\s+/);
      if (rel.includes("icon") || rel.includes("apple-touch-icon")) {
        favicon = safePublicUrl(attrs.href.trim(), base);
      }
    }
  }
  return { og, twitter, favicon };
}

async function fetchWithSafeRedirects(
  start: URL, fetcher: typeof fetch, signal: AbortSignal,
  checkHost: (hostname: string) => Promise<void>, accept: string,
): Promise<{ response: Response; url: URL }> {
  let url = start;
  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects++) {
    await checkHost(url.hostname);
    const response = await fetcher(url.toString(), {
      method: "GET",
      redirect: "manual",
      headers: { accept },
      signal,
    });
    if (![301, 302, 303, 307, 308].includes(response.status)) return { response, url };
    const location = response.headers.get("location");
    await response.body?.cancel();
    const next = location && safePublicUrl(location, url);
    if (!next || redirects === MAX_REDIRECTS) throw new Error("Unsafe or excessive preview redirect");
    url = next;
  }
  throw new Error("Excessive preview redirects");
}

async function readBoundedHtml(response: Response): Promise<string | null> {
  if (!response.ok || !/^(?:text\/html|application\/xhtml\+xml)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "")) {
    await response.body?.cancel();
    return null;
  }
  const body = response.body;
  if (!body) return null;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let html = "";
  try {
    while (bytes < MAX_HTML_BYTES) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      const chunk = decoder.decode(value.subarray(0, Math.max(0, MAX_HTML_BYTES - (bytes - value.byteLength))), { stream: true });
      const headEnd = /<\/head\s*>/i.test(html.slice(-32) + chunk);
      html += chunk;
      if (headEnd) break;
    }
    html += decoder.decode();
  } finally {
    await reader.cancel().catch(() => {});
  }
  return html;
}

async function usableFavicon(
  url: URL, fetcher: typeof fetch, signal: AbortSignal, checkHost: (hostname: string) => Promise<void>,
): Promise<boolean> {
  try {
    const { response } = await fetchWithSafeRedirects(url, fetcher, signal, checkHost, "image/avif,image/webp,image/png,image/*;q=0.8");
    await response.body?.cancel();
    return response.ok && /^image\/(?:png|jpeg|gif|webp|x-icon|vnd\.microsoft\.icon|svg\+xml)(?:\s*;|$)/i.test(response.headers.get("content-type") ?? "");
  } catch {
    return false;
  }
}

/** Performs a single bounded lookup; network failures become a terminal fallback. */
export async function lookupPreview(
  value: string, fetcher: typeof fetch = fetch, resolver: DnsResolver = defaultResolver,
): Promise<MetadataPreview> {
  const start = safePublicUrl(value);
  if (!start) throw new ApiError(400, "invalid_request");
  const signal = AbortSignal.timeout(FETCH_TIMEOUT_MS);
  const checkedHosts = new Set<string>();
  const checkHost = async (hostname: string): Promise<void> => {
    if (checkedHosts.has(hostname)) return;
    await checkPublicDns(hostname, resolver, signal);
    checkedHosts.add(hostname);
  };
  try {
    const { response, url } = await fetchWithSafeRedirects(
      start, fetcher, signal, checkHost, "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
    );
    const html = await readBoundedHtml(response);
    if (html) {
      const metadata = extractMetadata(html, url);
      if (metadata.og) return { image: metadata.og.toString(), source: "og", status: "ready" };
      if (metadata.twitter) return { image: metadata.twitter.toString(), source: "twitter", status: "ready" };
      if (metadata.favicon && await usableFavicon(metadata.favicon, fetcher, signal, checkHost)) {
        return { image: metadata.favicon.toString(), source: "favicon", status: "failed" };
      }
    }
    const favicon = safePublicUrl("/favicon.ico", url);
    if (favicon && await usableFavicon(favicon, fetcher, signal, checkHost)) {
      return { image: favicon.toString(), source: "favicon", status: "failed" };
    }
  } catch {
    // Preview failure should not block sending a message with this link.
  }
  return { image: null, source: "placeholder", status: "failed" };
}

