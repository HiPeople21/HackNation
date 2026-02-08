import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { randomUUID } from "node:crypto";

// --- Types ---

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  source: string;
}

interface ExtractedProduct {
  name: string | null;
  price: number | null;
  currency: string | null;
  availability: string | null;
  brand: string | null;
  category: string | null;
  key_features: string[];
  images: string[];
  specs: Record<string, string>;
  confidence: number;
}

interface StructuredExtract {
  name?: string;
  price?: number;
  currency?: string;
  availability?: string;
  brand?: string;
  category?: string;
  key_features?: string[];
  images?: string[];
  specs?: Record<string, string>;
  usedStructuredData: boolean;
}

interface CartItem {
  id: string;
  name: string;
  url: string;
  price: number;
  currency: string;
  source: string;
  imageUrl: string | null;
  category: string | null;
}

const cart: CartItem[] = [];

// --- Search helpers ---

const SEARCH_UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

function extractHostname(urlStr: string): string {
  const m = urlStr.match(/^https?:\/\/([^/?#:]+)/i);
  return m ? m[1].toLowerCase() : "";
}

function isBlockedHost(host: string): boolean {
  return /duckduckgo\.com$|bing\.com$|doubleclick|googleadservices|googleads|taboola|outbrain|coldest\.com/i.test(host);
}

async function fetchWithTimeout(url: string, timeoutMs: number, extraHeaders?: Record<string, string>): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        "User-Agent": SEARCH_UA,
        Accept: "text/html,application/xhtml+xml",
        "Accept-Language": "en-US,en;q=0.9",
        ...extraHeaders,
      },
    });
  } finally {
    clearTimeout(timer);
  }
}

function parseDdgHtmlResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();

  // Primary: result__a class links
  const resultBlockRe =
    /<div[^>]*class="[^"]*result results_links[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;

  let blockMatch: RegExpExecArray | null;
  while (
    (blockMatch = resultBlockRe.exec(html)) !== null &&
    results.length < maxResults
  ) {
    const block = blockMatch[0];

    const titleMatch = block.match(
      /<a[^>]*class="result__a"[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/
    );
    if (!titleMatch) continue;

    const rawHref = titleMatch[1];
    const titleHtml = titleMatch[2];

    const snippetMatch = block.match(
      /<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/
    );
    const snippetHtml = snippetMatch ? snippetMatch[1] : "";

    const title = stripTags(titleHtml).trim();
    const snippet = stripTags(snippetHtml).trim();

    const resolvedUrl = unwrapDdgUrl(rawHref);
    if (!resolvedUrl || !title) continue;
    if (seen.has(resolvedUrl)) continue;
    seen.add(resolvedUrl);

    const host = extractHostname(resolvedUrl);
    if (isBlockedHost(host)) continue;

    results.push({ title, url: resolvedUrl, snippet, source: host || resolvedUrl });
  }

  // Fallback: generic anchor parsing if block parsing yielded nothing
  if (results.length === 0) {
    const anchorRe =
      /<a[^>]*class=["'][^"']*(result__a|result-link)[^"']*["'][^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = anchorRe.exec(html)) !== null && results.length < maxResults) {
      const href = unwrapDdgUrl(m[2]);
      const title = stripTags(m[3]).trim();
      if (!href || !title) continue;
      if (seen.has(href)) continue;
      seen.add(href);
      const host = extractHostname(href);
      if (isBlockedHost(host)) continue;
      results.push({ title, url: href, snippet: "", source: host || href });
    }
  }

  return results;
}

function parseBingHtmlResults(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const blockRe = /<li[^>]*class=["'][^"']*\bb_algo\b[^"']*["'][^>]*>([\s\S]*?)<\/li>/gi;
  let block: RegExpExecArray | null;
  while ((block = blockRe.exec(html)) !== null && results.length < maxResults) {
    const chunk = block[1];
    const linkMatch = chunk.match(/<h2[^>]*>\s*<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/i);
    if (!linkMatch) continue;

    const href = linkMatch[1].trim();
    if (!/^https?:\/\//i.test(href)) continue;
    if (seen.has(href)) continue;
    seen.add(href);

    const title = stripTags(linkMatch[2]).trim();
    if (!title) continue;

    const host = extractHostname(href);
    if (isBlockedHost(host)) continue;

    let snippet = "";
    const snippetMatch = chunk.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    if (snippetMatch) snippet = stripTags(snippetMatch[1]).trim();

    results.push({ title, url: href, snippet, source: host || href });
  }
  return results;
}

function parseGenericAnchors(html: string, maxResults: number): SearchResult[] {
  const results: SearchResult[] = [];
  const seen = new Set<string>();
  const anchorRe = /<a[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = anchorRe.exec(html)) !== null && results.length < maxResults) {
    const href = unwrapDdgUrl(m[1]);
    if (!href || !/^https?:\/\//i.test(href)) continue;
    const host = extractHostname(href);
    if (!host || isBlockedHost(host)) continue;
    if (seen.has(href)) continue;
    const title = stripTags(m[2]).trim();
    if (!title || title.length < 5) continue;
    seen.add(href);
    results.push({ title, url: href, snippet: "", source: host });
  }
  return results;
}

function buildFallbackMerchantLinks(query: string, maxResults: number): SearchResult[] {
  const q = encodeURIComponent(query.trim());
  const seeds: SearchResult[] = [
    { title: `Amazon: "${query}"`, url: `https://www.amazon.com/s?k=${q}`, snippet: "Fallback merchant search", source: "amazon.com" },
    { title: `Best Buy: "${query}"`, url: `https://www.bestbuy.com/site/searchpage.jsp?st=${q}`, snippet: "Fallback merchant search", source: "bestbuy.com" },
    { title: `Walmart: "${query}"`, url: `https://www.walmart.com/search?q=${q}`, snippet: "Fallback merchant search", source: "walmart.com" },
    { title: `Target: "${query}"`, url: `https://www.target.com/s?searchTerm=${q}`, snippet: "Fallback merchant search", source: "target.com" },
    { title: `Newegg: "${query}"`, url: `https://www.newegg.com/p/pl?d=${q}`, snippet: "Fallback merchant search", source: "newegg.com" },
    { title: `eBay: "${query}"`, url: `https://www.ebay.com/sch/i.html?_nkw=${q}`, snippet: "Fallback merchant search", source: "ebay.com" },
  ];
  return seeds.slice(0, Math.min(maxResults, 6));
}

async function searchDdgHtml(query: string, maxResults: number, region: string | null): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (region) params.set("kl", region);
  const url = `https://html.duckduckgo.com/html/?${params.toString()}`;
  const res = await fetchWithTimeout(url, 20000);
  if (!res.ok) throw new Error(`DuckDuckGo HTML returned HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDdgHtmlResults(html, maxResults);
  if (results.length === 0) {
    const generic = parseGenericAnchors(html, maxResults);
    if (generic.length > 0) return generic;
  }
  return results;
}

async function searchDdgLite(query: string, maxResults: number, region: string | null): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (region) params.set("kl", region);
  const url = `https://lite.duckduckgo.com/lite/?${params.toString()}`;
  const res = await fetchWithTimeout(url, 20000);
  if (!res.ok) throw new Error(`DuckDuckGo Lite returned HTTP ${res.status}`);
  const html = await res.text();
  const results = parseDdgHtmlResults(html, maxResults);
  if (results.length === 0) return parseGenericAnchors(html, maxResults);
  return results;
}

async function searchBingHtml(query: string, maxResults: number, region: string | null): Promise<SearchResult[]> {
  const params = new URLSearchParams({ q: query });
  if (region) params.set("setmkt", region);
  const url = `https://www.bing.com/search?${params.toString()}`;
  const res = await fetchWithTimeout(url, 20000);
  if (!res.ok) throw new Error(`Bing returned HTTP ${res.status}`);
  const html = await res.text();
  const results = parseBingHtmlResults(html, maxResults);
  if (results.length === 0) return parseGenericAnchors(html, maxResults);
  return results;
}

type SearchAttempt = { provider: string; ok: boolean; count?: number; error?: string };

// Rate-limit awareness: if DDG returns 403/429, skip all DDG endpoints for a cooldown period.
let ddgBlockedUntil = 0;
let bingBlockedUntil = 0;
const RATE_LIMIT_COOLDOWN_MS = 60_000; // 60 seconds

function isDdgRateLimited(): boolean {
  return Date.now() < ddgBlockedUntil;
}

function markDdgRateLimited(): void {
  ddgBlockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  console.warn(`[web_search] DDG rate-limited, skipping DDG endpoints for ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
}

function isBingRateLimited(): boolean {
  return Date.now() < bingBlockedUntil;
}

function markBingRateLimited(): void {
  bingBlockedUntil = Date.now() + RATE_LIMIT_COOLDOWN_MS;
  console.warn(`[web_search] Bing rate-limited, skipping for ${RATE_LIMIT_COOLDOWN_MS / 1000}s`);
}

function isRateLimitError(msg: string): boolean {
  return /HTTP 403|HTTP 429|rate.?limit|too many requests/i.test(msg);
}

async function searchWithFallbacks(
  query: string,
  maxResults: number,
  region: string | null,
): Promise<{ results: SearchResult[]; provider: string; attempts: SearchAttempt[] }> {
  const attempts: SearchAttempt[] = [];
  let results: SearchResult[] = [];
  let provider = "none";

  // 1. DDG HTML (skip if rate-limited)
  if (!isDdgRateLimited()) {
    try {
      provider = "duckduckgo_html";
      console.log(`[web_search] trying duckduckgo_html for: ${query}`);
      results = await searchDdgHtml(query, maxResults, region);
      attempts.push({ provider, ok: true, count: results.length });
      console.log(`[web_search] duckduckgo_html returned ${results.length} results`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({ provider, ok: false, error: msg });
      console.warn(`[web_search] duckduckgo_html failed: ${msg}`);
      if (isRateLimitError(msg)) markDdgRateLimited();
    }
  } else {
    attempts.push({ provider: "duckduckgo_html", ok: false, error: "skipped (rate-limited)" });
  }

  // 2. DDG Lite — skip if DDG is rate-limited (same rate limit pool)
  if (results.length === 0 && !isDdgRateLimited()) {
    try {
      provider = "duckduckgo_lite";
      console.log(`[web_search] trying duckduckgo_lite...`);
      results = await searchDdgLite(query, maxResults, region);
      attempts.push({ provider, ok: true, count: results.length });
      console.log(`[web_search] duckduckgo_lite returned ${results.length} results`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({ provider, ok: false, error: msg });
      console.warn(`[web_search] duckduckgo_lite failed: ${msg}`);
      if (isRateLimitError(msg)) markDdgRateLimited();
    }
  }

  // 3. Bing HTML (skip if rate-limited)
  if (results.length === 0 && !isBingRateLimited()) {
    try {
      provider = "bing_html";
      console.log(`[web_search] trying bing_html...`);
      results = await searchBingHtml(query, maxResults, region);
      attempts.push({ provider, ok: true, count: results.length });
      console.log(`[web_search] bing_html returned ${results.length} results`);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      attempts.push({ provider, ok: false, error: msg });
      console.warn(`[web_search] bing_html failed: ${msg}`);
      if (isRateLimitError(msg)) markBingRateLimited();
    }
  }

  // 4. Fallback merchant links (always available)
  if (results.length === 0) {
    provider = "fallback_merchant_links";
    results = buildFallbackMerchantLinks(query, maxResults);
    attempts.push({ provider, ok: true, count: results.length });
    console.log(`[web_search] using fallback merchant links (${results.length})`);
  }

  return { results: results.slice(0, maxResults), provider, attempts };
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function cleanHtml(rawHtml: string): string {
  let html = rawHtml;
  html = html.replace(/<script\b[^<]*(?:(?!<\/script>)<[^<]*)*<\/script>/gi, "");
  html = html.replace(/<style\b[^<]*(?:(?!<\/style>)<[^<]*)*<\/style>/gi, "");
  html = html.replace(/<noscript\b[^<]*(?:(?!<\/noscript>)<[^<]*)*<\/noscript>/gi, "");
  html = html.replace(/<iframe\b[^<]*(?:(?!<\/iframe>)<[^<]*)*<\/iframe>/gi, "");
  return html;
}

function htmlToText(cleaned: string): string {
  let text = cleaned;
  text = text.replace(/<\/(?:p|div|section|article|header|footer|li|ul|ol|h[1-6]|tr|table)>/gi, "\n");
  text = text.replace(/<br\s*\/?\s*>/gi, "\n");
  text = text.replace(/<[^>]+>/g, " ");
  text = normalizeWhitespace(text).replace(/\n{3,}/g, "\n\n").trim();
  return text;
}

function extractTitle(html: string): string | null {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m ? normalizeWhitespace(stripTags(m[1])) : null;
}

function unwrapDdgUrl(raw: string): string | null {
  if (raw.includes("duckduckgo.com/l/?")) {
    try {
      const full = raw.startsWith("//") ? `https:${raw}` : raw;
      const parsed = new URL(full);
      const uddg = parsed.searchParams.get("uddg");
      return uddg ?? null;
    } catch {
      return null;
    }
  }
  if (raw.startsWith("http")) return raw;
  if (raw.startsWith("//")) return `https:${raw}`;
  return null;
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function decodeEntities(value: string): string {
  return value
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ");
}

function toNumber(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const cleaned = value.replace(/[, ]/g, "").replace(/[^0-9.]/g, "");
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
}

function firstString(...values: unknown[]): string | null {
  for (const value of values) {
    if (typeof value === "string") {
      const v = normalizeWhitespace(decodeEntities(value));
      if (v) return v;
    }
  }
  return null;
}

function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value
      .filter((v): v is string => typeof v === "string")
      .map((v) => normalizeWhitespace(decodeEntities(v)))
      .filter(Boolean);
  }
  if (typeof value === "string") {
    const v = normalizeWhitespace(decodeEntities(value));
    return v ? [v] : [];
  }
  return [];
}

function parseCurrencyFromPrice(raw: string): string | null {
  if (/£/.test(raw) || /\bGBP\b/i.test(raw)) return "GBP";
  if (/\$/.test(raw) || /\bUSD\b/i.test(raw)) return "USD";
  if (/€/.test(raw) || /\bEUR\b/i.test(raw)) return "EUR";
  if (/\bCAD\b/i.test(raw)) return "CAD";
  if (/\bAUD\b/i.test(raw)) return "AUD";
  if (/\bJPY\b/i.test(raw) || /¥/.test(raw)) return "JPY";
  if (/\bINR\b/i.test(raw) || /₹/.test(raw)) return "INR";
  return null;
}

function normalizeAvailability(value: string | null): string | null {
  if (!value) return null;
  const v = value.toLowerCase();
  if (v.includes("instock") || v.includes("in stock")) return "in_stock";
  if (v.includes("outofstock") || v.includes("out of stock")) return "out_of_stock";
  if (v.includes("preorder") || v.includes("pre-order")) return "preorder";
  if (v.includes("limited")) return "limited";
  return normalizeWhitespace(value);
}

function parseJsonSafely(input: string): unknown | null {
  try {
    return JSON.parse(input);
  } catch {
    return null;
  }
}

function collectProductNodes(node: unknown, out: Record<string, unknown>[]): void {
  if (!node) return;
  if (Array.isArray(node)) {
    for (const item of node) collectProductNodes(item, out);
    return;
  }
  if (typeof node !== "object") return;

  const obj = node as Record<string, unknown>;
  const type = obj["@type"];
  const typeValues = Array.isArray(type) ? type : [type];
  if (typeValues.some((t) => typeof t === "string" && t.toLowerCase() === "product")) {
    out.push(obj);
  }

  if (obj["@graph"]) collectProductNodes(obj["@graph"], out);
}

function scoreProductNode(node: Record<string, unknown>): number {
  let score = 0;
  if (typeof node.name === "string") score += 3;
  if (node.offers) score += 3;
  if (node.brand) score += 1;
  if (node.image) score += 1;
  if (node.category) score += 1;
  return score;
}

function extractFromJsonLd(html: string): StructuredExtract {
  const scripts: string[] = [];
  const re = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    scripts.push(match[1]);
  }

  const candidates: Record<string, unknown>[] = [];
  for (const script of scripts) {
    const parsed = parseJsonSafely(script.trim());
    if (parsed) collectProductNodes(parsed, candidates);
  }

  if (candidates.length === 0) {
    return { usedStructuredData: false };
  }

  candidates.sort((a, b) => scoreProductNode(b) - scoreProductNode(a));
  const product = candidates[0];

  const offersRaw = product.offers;
  const offers = Array.isArray(offersRaw) ? offersRaw : offersRaw ? [offersRaw] : [];
  const offer = (offers.find((o) => typeof o === "object" && o !== null && (o as Record<string, unknown>).price !== undefined) ||
    offers[0]) as Record<string, unknown> | undefined;

  const additionalProperty = Array.isArray(product.additionalProperty)
    ? product.additionalProperty
    : [];
  const specs: Record<string, string> = {};
  for (const item of additionalProperty) {
    if (!item || typeof item !== "object") continue;
    const p = item as Record<string, unknown>;
    const key = firstString(p.name);
    const val = firstString(p.value);
    if (key && val) specs[key] = val;
  }

  const description = firstString(product.description);
  const key_features = description
    ? description
        .split(/[.•]\s+/)
        .map((v) => normalizeWhitespace(v))
        .filter(Boolean)
        .slice(0, 6)
    : [];

  const brandRaw = product.brand as Record<string, unknown> | string | undefined;
  const brand =
    typeof brandRaw === "string"
      ? firstString(brandRaw)
      : brandRaw && typeof brandRaw === "object"
        ? firstString(brandRaw.name)
        : null;

  const price = offer ? toNumber((offer as Record<string, unknown>).price) : null;
  const currency = offer
    ? firstString((offer as Record<string, unknown>).priceCurrency) || null
    : null;
  const availability = offer
    ? normalizeAvailability(firstString((offer as Record<string, unknown>).availability))
    : null;

  return {
    name: firstString(product.name) || undefined,
    price: price ?? undefined,
    currency: currency ?? undefined,
    availability: availability ?? undefined,
    brand: brand || undefined,
    category: firstString(product.category) || undefined,
    key_features,
    images: stringArray(product.image),
    specs,
    usedStructuredData: true,
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getAttr(attrs: string, name: string): string | null {
  const re = new RegExp(`\\b${escapeRegExp(name)}\\s*=\\s*["']([^"']+)["']`, "i");
  const match = attrs.match(re);
  return match ? decodeEntities(match[1]).trim() : null;
}

function extractItempropValues(html: string, prop: string): string[] {
  const re = new RegExp(
    `<([a-zA-Z0-9]+)([^>]*\\bitemprop=["'][^"']*\\b${escapeRegExp(
      prop
    )}\\b[^"']*["'][^>]*)>([\\s\\S]*?)<\\/\\1>|<([a-zA-Z0-9]+)([^>]*\\bitemprop=["'][^"']*\\b${escapeRegExp(
      prop
    )}\\b[^"']*["'][^>]*)\\/?\\s*>`,
    "gi"
  );

  const out: string[] = [];
  let match: RegExpExecArray | null;
  while ((match = re.exec(html)) !== null) {
    const attrs = match[2] || match[5] || "";
    const inner = match[3] || "";
    const content = getAttr(attrs, "content");
    const value = getAttr(attrs, "value");
    const href = getAttr(attrs, "href");
    const src = getAttr(attrs, "src");
    const fallbackInner = normalizeWhitespace(stripTags(inner));
    const resolved = firstString(content, value, href, src, fallbackInner);
    if (resolved) out.push(resolved);
  }
  return out;
}

function extractFromMicrodata(html: string): StructuredExtract {
  const name = firstString(...extractItempropValues(html, "name")) || undefined;
  const brand = firstString(...extractItempropValues(html, "brand")) || undefined;
  const category = firstString(...extractItempropValues(html, "category")) || undefined;
  const image = extractItempropValues(html, "image");
  const availability = normalizeAvailability(
    firstString(...extractItempropValues(html, "availability"))
  );

  const priceCandidates = extractItempropValues(html, "price");
  const price = toNumber(firstString(...priceCandidates));
  const currency =
    firstString(...extractItempropValues(html, "priceCurrency")) ||
    (priceCandidates.length > 0 ? parseCurrencyFromPrice(priceCandidates[0]) : null);

  const specs: Record<string, string> = {};
  const props = extractItempropValues(html, "additionalProperty");
  for (const p of props) {
    const parts = p.split(":");
    if (parts.length >= 2) {
      const key = normalizeWhitespace(parts[0]);
      const val = normalizeWhitespace(parts.slice(1).join(":"));
      if (key && val) specs[key] = val;
    }
  }

  const used = Boolean(name || price || currency || availability || brand || category || image.length);

  return {
    name,
    price: price ?? undefined,
    currency: currency || undefined,
    availability: availability || undefined,
    brand,
    category,
    images: image,
    specs,
    usedStructuredData: used,
  };
}

function isJunkImage(src: string): boolean {
  const lower = src.toLowerCase();
  return (
    /\b(logo|icon|sprite|pixel|tracking|badge|banner|avatar|flag|arrow|spinner|loading|placeholder|blank|spacer)\b/.test(lower) ||
    /\.(gif|svg)(\?|$)/.test(lower) ||
    /data:image/.test(lower) ||
    /1x1|transparent|base64/.test(lower) ||
    lower.length < 10
  );
}

function extractImageCandidates(html: string): string[] {
  const out = new Set<string>();
  const metaRe =
    /<meta[^>]+(?:property|name)=["'](?:og:image|twitter:image|image)["'][^>]+content=["']([^"']+)["'][^>]*>/gi;
  let match: RegExpExecArray | null;
  while ((match = metaRe.exec(html)) !== null) {
    const value = normalizeWhitespace(decodeEntities(match[1]));
    if (value && !isJunkImage(value)) out.add(value);
  }

  // Prefer product images from common e-commerce patterns
  const productImgRe = /<img[^>]+src=["']([^"']+)["'][^>]*>/gi;
  while ((match = productImgRe.exec(html)) !== null && out.size < 8) {
    const value = normalizeWhitespace(decodeEntities(match[1]));
    if (!value || isJunkImage(value)) continue;
    // Check if the img tag has product-related context (alt, class, id)
    const tag = match[0].toLowerCase();
    const isProductImage =
      /\b(product|hero|main|gallery|primary|detail)\b/.test(tag) ||
      /\balt=["'][^"']{5,}/.test(tag); // Has meaningful alt text
    if (isProductImage || out.size === 0) {
      out.add(value);
    }
  }

  // If still empty, take any non-junk images
  if (out.size === 0) {
    productImgRe.lastIndex = 0;
    while ((match = productImgRe.exec(html)) !== null && out.size < 4) {
      const value = normalizeWhitespace(decodeEntities(match[1]));
      if (value && !isJunkImage(value)) out.add(value);
    }
  }

  return Array.from(out).slice(0, 8);
}

function extractPriceFromText(text: string): { price: number | null; currency: string | null } {
  const regex =
    /(?:USD|EUR|GBP|CAD|AUD|JPY|INR|[$£€¥₹])\s?\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?|\d{1,3}(?:[,\s]\d{3})*(?:\.\d{2})?\s?(?:USD|EUR|GBP|CAD|AUD|JPY|INR)\b/gi;
  let best: { score: number; price: number; currency: string | null; index: number } | null = null;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    const raw = match[0];
    const number = toNumber(raw);
    if (number === null) continue;
    const currency = parseCurrencyFromPrice(raw);

    const start = Math.max(0, match.index - 50);
    const end = Math.min(text.length, match.index + raw.length + 50);
    const context = text.slice(start, end).toLowerCase();
    let score = 0;
    if (/\b(price|our price|now|sale|buy)\b/.test(context)) score += 2;
    if (/\b(list price|msrp|was)\b/.test(context)) score -= 1;

    const candidate = { score, price: number, currency, index: match.index };
    if (
      !best ||
      candidate.score > best.score ||
      (candidate.score === best.score && candidate.index < best.index)
    ) {
      best = candidate;
    }
  }

  return {
    price: best?.price ?? null,
    currency: best?.currency ?? null,
  };
}

function extractAvailabilityFromText(text: string): string | null {
  const lower = text.toLowerCase();
  if (/\bin stock\b/.test(lower)) return "in_stock";
  if (/\bout of stock\b/.test(lower)) return "out_of_stock";
  if (/\bpre[- ]?order\b/.test(lower)) return "preorder";
  if (/\bcurrently unavailable\b/.test(lower)) return "unavailable";
  return null;
}

function extractKeyFeaturesFromText(text: string): string[] {
  const lines = text
    .split("\n")
    .map((l) => normalizeWhitespace(l))
    .filter(Boolean);
  const bullets = lines
    .filter((line) => /^[-*•]\s+/.test(line))
    .map((line) => line.replace(/^[-*•]\s+/, "").trim())
    .filter((line) => {
      if (line.length < 8 || line.length > 180) return false;
      // Filter out review-like content
      if (/\b(i |my |we |our |love it|hate it|bought this|great product|terrible|amazing|disappointed|i'm |i've )\b/i.test(line)) return false;
      // Filter out promotional/shipping text
      if (/\b(free shipping|add to cart|buy now|limited time|coupon|promo code|subscribe|newsletter)\b/i.test(line)) return false;
      return true;
    });
  return bullets.slice(0, 8);
}

function extractSpecsFromText(text: string): Record<string, string> {
  const specs: Record<string, string> = {};
  const lines = text
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  for (const line of lines) {
    if (Object.keys(specs).length >= 25) break;
    const match = line.match(/^([A-Za-z][A-Za-z0-9 \-\/]{1,40})\s*:\s*(.{1,200})$/);
    if (!match) continue;
    const key = normalizeWhitespace(match[1]);
    const value = normalizeWhitespace(match[2]);
    if (key && value && !specs[key]) specs[key] = value;
  }
  return specs;
}

function extractNameFromText(text: string): string | null {
  const lines = text
    .split("\n")
    .map((l) => normalizeWhitespace(l))
    .filter(Boolean);
  for (const line of lines.slice(0, 30)) {
    if (line.length < 6 || line.length > 140) continue;
    if (/^(home|cart|menu|login|sign in|sign up|register|search|skip to|skip navigation|main content|cookie|accept|close|subscribe|newsletter|free shipping)$/i.test(line)) continue;
    // Skip accessibility/nav boilerplate
    if (/^skip\s+to\b/i.test(line)) continue;
    if (/^(main menu|navigation|breadcrumb|all categories|departments|back to)/i.test(line)) continue;
    if (/^\$?\d+(?:\.\d+)?$/.test(line)) continue;
    // Skip lines that are just site/nav text
    if (/^(shop|browse|categories|deals|new arrivals|sale|clearance|customer service|help|contact|about)$/i.test(line)) continue;
    return line;
  }
  return null;
}

function computeConfidence(
  product: Omit<ExtractedProduct, "confidence">,
  usedStructuredData: boolean
): number {
  let score = 0;
  if (product.name) score += 0.2;
  if (product.price !== null) score += product.currency ? 0.25 : 0.15;
  if (product.availability) score += 0.1;
  if (product.brand) score += 0.1;
  if (product.category) score += 0.05;
  if (product.key_features.length > 0) score += 0.1;
  if (product.images.length > 0) score += 0.1;
  if (Object.keys(product.specs).length > 0) score += 0.1;
  if (usedStructuredData) score += 0.1;
  return Math.max(0, Math.min(1, Number(score.toFixed(2))));
}

function extractProduct(input: {
  url: string;
  html: string;
  text: string;
}): ExtractedProduct {
  const html = input.html || "";
  const text = decodeEntities(input.text || "");

  const fromJsonLd = extractFromJsonLd(html);
  const fromMicrodata = extractFromMicrodata(html);
  const usedStructuredData = fromJsonLd.usedStructuredData || fromMicrodata.usedStructuredData;

  const mergedSpecs: Record<string, string> = {
    ...(fromJsonLd.specs || {}),
    ...(fromMicrodata.specs || {}),
  };

  let name = fromJsonLd.name || fromMicrodata.name || null;
  let price = fromJsonLd.price ?? fromMicrodata.price ?? null;
  let currency = fromJsonLd.currency || fromMicrodata.currency || null;
  let availability = fromJsonLd.availability || fromMicrodata.availability || null;
  let brand = fromJsonLd.brand || fromMicrodata.brand || null;
  let category = fromJsonLd.category || fromMicrodata.category || null;
  let key_features = [...(fromJsonLd.key_features || []), ...(fromMicrodata.key_features || [])];
  let images = [...(fromJsonLd.images || []), ...(fromMicrodata.images || [])];

  if (!name) {
    name = extractNameFromText(text);
  }
  if (price === null) {
    const priceFallback = extractPriceFromText(text);
    price = priceFallback.price;
    if (!currency) currency = priceFallback.currency;
  }
  if (!availability) {
    availability = extractAvailabilityFromText(text);
  }
  if (!brand) {
    const m = text.match(/\bbrand\s*[:\-]\s*([^\n|]{2,60})/i);
    if (m) brand = normalizeWhitespace(m[1]);
  }
  if (!category) {
    const m = text.match(/\bcategory\s*[:\-]\s*([^\n|]{2,80})/i);
    if (m) category = normalizeWhitespace(m[1]);
  }

  if (key_features.length === 0) {
    key_features = extractKeyFeaturesFromText(text);
  }
  key_features = Array.from(new Set(key_features.map((v) => normalizeWhitespace(v)).filter(Boolean))).slice(0, 10);

  if (images.length === 0) {
    images = extractImageCandidates(html);
  }
  images = Array.from(new Set(images.map((v) => normalizeWhitespace(v)).filter(Boolean))).slice(0, 12);

  const specsFromText = extractSpecsFromText(text);
  const specs = {
    ...mergedSpecs,
    ...specsFromText,
  };

  const base: Omit<ExtractedProduct, "confidence"> = {
    name,
    price,
    currency,
    availability,
    brand,
    category,
    key_features,
    images,
    specs,
  };

  return {
    ...base,
    confidence: computeConfidence(base, usedStructuredData),
  };
}

// --- MCP Server ---

export const server = new McpServer({
  name: "web-search-mcp",
  version: "1.0.0",
});

server.tool(
  "web_search",
  "Search the web and return organic results (no ads). Uses DuckDuckGo.",
  {
    query: z.string().describe("The search query"),
    max_results: z
      .number()
      .int()
      .min(1)
      .max(20)
      .default(5)
      .describe("Maximum number of results to return (default 5)"),
    region: z
      .string()
      .nullable()
      .default(null)
      .describe(
        'DuckDuckGo region code, e.g. "us-en", "uk-en", "de-de". Null for default.'
      ),
  },
  async (params) => {
    const { results, provider, attempts } = await searchWithFallbacks(
      params.query,
      params.max_results,
      params.region,
    );

    console.warn(
      `[web_search] query="${params.query}" provider=${provider} total=${results.length} attempts=${JSON.stringify(attempts)}`,
    );

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ results, provider, total: results.length, attempts }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "extract_product",
  "Extract normalized product data from raw e-commerce HTML/text without interpretation.",
  {
    url: z.string().url().describe("Product page URL"),
    html: z.string().describe("Raw page HTML"),
    text: z.string().describe("Visible page text"),
  },
  async (params) => {
    const extracted = extractProduct({
      url: params.url,
      html: params.html,
      text: params.text,
    });

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(extracted, null, 2),
        },
      ],
    };
  }
);

// --- Compare products logic ---

interface CompareProduct {
  name: string;
  price: number | null;
  currency: string | null;
  brand: string | null;
  key_features: string[];
  specs: Record<string, string>;
  source: string;
}

interface CompareCriteria {
  max_budget: number | null;
  currency: string | null;
  use_case: string;
  preferences: string[];
}

interface RankedProduct {
  name: string;
  score: number;
  pros: string[];
  cons: string[];
  reason: string;
}

type RuntimePage = {
  goto: (url: string, options?: Record<string, unknown>) => Promise<unknown>;
  url: () => string;
  title: () => Promise<string>;
  content: () => Promise<string>;
  evaluate: <T>(fn: (...args: any[]) => T | Promise<T>, ...args: any[]) => Promise<T>;
  locator: (selector: string) => {
    first: () => {
      click: (options?: Record<string, unknown>) => Promise<void>;
      fill: (value: string, options?: Record<string, unknown>) => Promise<void>;
      type: (value: string, options?: Record<string, unknown>) => Promise<void>;
      press: (key: string, options?: Record<string, unknown>) => Promise<void>;
      selectOption: (value: string | { value?: string; label?: string; index?: number }) => Promise<void>;
      waitFor: (options?: Record<string, unknown>) => Promise<void>;
      count: () => Promise<number>;
    };
  };
  waitForLoadState: (state?: string, options?: Record<string, unknown>) => Promise<void>;
};

type RuntimeContext = {
  newPage: () => Promise<RuntimePage>;
  close: () => Promise<void>;
};

type RuntimeBrowser = {
  newContext: (options?: Record<string, unknown>) => Promise<RuntimeContext>;
  close: () => Promise<void>;
  isConnected?: () => boolean;
};

type PlaywrightModule = {
  chromium: {
    launch: (options?: Record<string, unknown>) => Promise<RuntimeBrowser>;
  };
};

const browserState: {
  browser: RuntimeBrowser | null;
  context: RuntimeContext | null;
  page: RuntimePage | null;
} = {
  browser: null,
  context: null,
  page: null,
};

async function loadPlaywright(): Promise<PlaywrightModule> {
  try {
    const dynamicImport = new Function("m", "return import(m)") as (m: string) => Promise<unknown>;
    const mod = (await dynamicImport("playwright")) as PlaywrightModule;
    if (!mod?.chromium?.launch) {
      throw new Error("Playwright chromium launcher is unavailable");
    }
    return mod;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(
      `Playwright is required for browser interaction tools. Install it with: npm --prefix web-search-mcp install playwright (${message})`
    );
  }
}

function ensurePage(): RuntimePage {
  if (!browserState.page) {
    throw new Error("No active browser page. Call browser_start first.");
  }
  return browserState.page;
}

async function closeBrowserSession(): Promise<void> {
  try {
    if (browserState.context) {
      await browserState.context.close();
    }
  } catch {
    // Ignore cleanup failures.
  }
  try {
    if (browserState.browser) {
      await browserState.browser.close();
    }
  } catch {
    // Ignore cleanup failures.
  }
  browserState.browser = null;
  browserState.context = null;
  browserState.page = null;
}

function toToolText(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function compareProducts(
  products: CompareProduct[],
  criteria: CompareCriteria
): RankedProduct[] {
  if (products.length === 0) return [];

  // Collect stats across all products for relative scoring
  const prices = products
    .map((p) => p.price)
    .filter((p): p is number => p !== null);
  const minPrice = prices.length > 0 ? Math.min(...prices) : 0;
  const maxPrice = prices.length > 0 ? Math.max(...prices) : 0;
  const priceRange = maxPrice - minPrice || 1;

  const allSpecKeys = new Set<string>();
  for (const p of products) {
    for (const key of Object.keys(p.specs)) allSpecKeys.add(key.toLowerCase());
  }
  const totalSpecKeys = allSpecKeys.size || 1;

  const maxFeatures = Math.max(...products.map((p) => p.key_features.length), 1);

  const useCaseLower = criteria.use_case.toLowerCase();
  const preferencesLower = criteria.preferences.map((p) => p.toLowerCase());

  const ranked = products.map((product): RankedProduct => {
    const pros: string[] = [];
    const cons: string[] = [];
    const reasons: string[] = [];

    // --- Data completeness (max 20) ---
    let completeness = 0;
    if (product.price !== null) {
      completeness += 8;
    } else {
      cons.push("Price not available");
      reasons.push("-8 missing price");
    }
    if (product.currency) {
      completeness += 2;
    } else if (product.price !== null) {
      cons.push("Currency not specified");
      reasons.push("-2 missing currency");
    }
    if (product.brand) {
      completeness += 3;
    } else {
      reasons.push("-3 missing brand");
    }
    if (Object.keys(product.specs).length > 0) {
      completeness += 4;
    } else {
      cons.push("No specs listed");
      reasons.push("-4 missing specs");
    }
    if (product.key_features.length > 0) {
      completeness += 3;
    } else {
      cons.push("No features listed");
      reasons.push("-3 missing features");
    }

    // --- Budget (max 25) ---
    let budgetScore = 0;
    if (
      criteria.max_budget !== null &&
      product.price !== null
    ) {
      if (product.price > criteria.max_budget) {
        budgetScore = 0;
        cons.push(
          `Over budget (${product.price} vs max ${criteria.max_budget}${criteria.currency ? " " + criteria.currency : ""})`
        );
        reasons.push("-25 exceeds max budget");
      } else {
        budgetScore = 25;
        const savings = criteria.max_budget - product.price;
        if (savings > 0) {
          pros.push(
            `Under budget by ${savings.toFixed(2)}${criteria.currency ? " " + criteria.currency : ""}`
          );
        }
        reasons.push("+25 within budget");
      }
    } else if (criteria.max_budget !== null && product.price === null) {
      budgetScore = 0;
      cons.push("Cannot verify budget compliance — price missing");
      reasons.push("-25 price unknown, budget cannot be verified");
    } else {
      // No budget constraint — award neutral baseline
      budgetScore = 15;
      reasons.push("+15 no budget constraint");
    }

    // --- Value / relative price (max 20) ---
    let valueScore = 0;
    if (product.price !== null && prices.length > 1) {
      // Lower price = higher score
      const normalized = 1 - (product.price - minPrice) / priceRange;
      valueScore = Math.round(normalized * 20);
      if (product.price === minPrice) {
        pros.push("Lowest price among compared products");
      } else if (product.price === maxPrice) {
        cons.push("Highest price among compared products");
      }
      reasons.push(`+${valueScore} relative price position`);
    } else if (product.price !== null) {
      valueScore = 10; // Only product with a price
      reasons.push("+10 only priced product");
    } else {
      valueScore = 0;
      reasons.push("+0 no price for value comparison");
    }

    // --- Specs richness (max 15) ---
    const specCount = Object.keys(product.specs).length;
    const specRatio = specCount / totalSpecKeys;
    const specScore = Math.round(specRatio * 15);
    if (specCount >= 5) pros.push(`Detailed specs (${specCount} attributes)`);
    reasons.push(`+${specScore} spec coverage (${specCount}/${totalSpecKeys})`);

    // --- Features richness (max 10) ---
    const featureRatio = product.key_features.length / maxFeatures;
    const featureScore = Math.round(featureRatio * 10);
    if (product.key_features.length >= 4)
      pros.push(`Rich feature list (${product.key_features.length} features)`);
    reasons.push(
      `+${featureScore} feature coverage (${product.key_features.length}/${maxFeatures})`
    );

    // --- Preference matching (max 10) ---
    let prefScore = 0;
    if (preferencesLower.length > 0) {
      const searchable = [
        product.name,
        product.brand ?? "",
        ...product.key_features,
        ...Object.keys(product.specs),
        ...Object.values(product.specs),
      ]
        .join(" ")
        .toLowerCase();

      let matched = 0;
      for (const pref of preferencesLower) {
        if (searchable.includes(pref)) {
          matched++;
          pros.push(`Matches preference: "${pref}"`);
        }
      }
      prefScore = Math.round((matched / preferencesLower.length) * 10);
      if (matched === 0 && preferencesLower.length > 0) {
        cons.push("No stated preferences matched");
      }
      reasons.push(
        `+${prefScore} preference match (${matched}/${preferencesLower.length})`
      );
    } else {
      prefScore = 5; // Neutral when no preferences given
      reasons.push("+5 no preferences specified");
    }

    // --- Use-case relevance bonus (included in reason but no separate bucket) ---
    if (useCaseLower) {
      const searchable = [
        product.name,
        product.brand ?? "",
        ...product.key_features,
        ...Object.values(product.specs),
      ]
        .join(" ")
        .toLowerCase();

      if (searchable.includes(useCaseLower)) {
        pros.push(`Relevant to use case: "${criteria.use_case}"`);
      }
    }

    const rawScore =
      completeness + budgetScore + valueScore + specScore + featureScore + prefScore;
    const score = Math.max(0, Math.min(100, rawScore));

    const reason = `Score ${score}/100: ${reasons.join("; ")}`;

    return { name: product.name, score, pros, cons, reason };
  });

  ranked.sort((a, b) => b.score - a.score);
  return ranked;
}

const CompareProductSchema = z.object({
  name: z.string().describe("Product name"),
  price: z.number().nullable().describe("Product price or null if unknown"),
  currency: z
    .string()
    .nullable()
    .describe("Currency code (e.g. USD) or null"),
  brand: z.string().nullable().describe("Brand name or null"),
  key_features: z.array(z.string()).describe("List of key features"),
  specs: z.record(z.string(), z.string()).describe("Spec key-value pairs"),
  source: z.string().describe("Source website or store"),
});

const CompareCriteriaSchema = z.object({
  max_budget: z
    .number()
    .nullable()
    .describe("Maximum budget or null for no limit"),
  currency: z
    .string()
    .nullable()
    .describe("Budget currency code or null"),
  use_case: z.string().describe("Intended use case for the product"),
  preferences: z
    .array(z.string())
    .describe("User preferences to match against product data"),
});

server.tool(
  "compare_products",
  "Compare and rank products by score (0-100) based on price, budget, specs, features, and user preferences. Pure logic, no external calls.",
  {
    products: z
      .array(CompareProductSchema)
      .min(1)
      .describe("Products to compare"),
    criteria: CompareCriteriaSchema.describe("Comparison criteria"),
  },
  async (params) => {
    const ranked = compareProducts(params.products, params.criteria);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ ranked }, null, 2),
        },
      ],
    };
  }
);

server.tool(
  "browser_start",
  "Start or reset a browser session for interactive navigation.",
  {
    start_url: z.string().url().nullable().default(null).describe("Optional URL to open immediately"),
    headless: z.boolean().default(true).describe("Run browser headless or visible"),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000).describe("Default navigation timeout"),
  },
  async (params) => {
    await closeBrowserSession();
    const pw = await loadPlaywright();
    const browser = await pw.chromium.launch({ headless: params.headless });
    const context = await browser.newContext();
    const page = await context.newPage();

    browserState.browser = browser;
    browserState.context = context;
    browserState.page = page;

    if (params.start_url) {
      await page.goto(params.start_url, {
        waitUntil: "domcontentloaded",
        timeout: params.timeout_ms,
      });
    }

    return toToolText({
      ok: true,
      url: page.url(),
      message: "Browser session started",
    });
  }
);

server.tool(
  "browser_open",
  "Navigate current browser page to a URL.",
  {
    url: z.string().url().describe("Absolute URL to open"),
    timeout_ms: z.number().int().min(1000).max(120000).default(30000),
  },
  async (params) => {
    const page = ensurePage();
    await page.goto(params.url, { waitUntil: "domcontentloaded", timeout: params.timeout_ms });
    return toToolText({
      ok: true,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_click",
  "Click an element by CSS selector.",
  {
    selector: z.string().min(1).describe("CSS selector"),
    wait_for_navigation: z.boolean().default(false).describe("Wait for page load after click"),
    timeout_ms: z.number().int().min(500).max(120000).default(15000),
  },
  async (params) => {
    const page = ensurePage();
    const target = page.locator(params.selector).first();
    await target.click({ timeout: params.timeout_ms });
    if (params.wait_for_navigation) {
      await page.waitForLoadState("domcontentloaded", { timeout: params.timeout_ms });
    }
    return toToolText({
      ok: true,
      selector: params.selector,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_type",
  "Type or fill text into an input field by CSS selector.",
  {
    selector: z.string().min(1).describe("Input element CSS selector"),
    text: z.string().describe("Text to input"),
    append: z.boolean().default(false).describe("Use typing append instead of fill"),
    press_enter: z.boolean().default(false).describe("Press Enter after input"),
    timeout_ms: z.number().int().min(500).max(120000).default(15000),
  },
  async (params) => {
    const page = ensurePage();
    const target = page.locator(params.selector).first();
    if (params.append) {
      await target.type(params.text, { timeout: params.timeout_ms });
    } else {
      await target.fill(params.text, { timeout: params.timeout_ms });
    }
    if (params.press_enter) {
      await target.press("Enter", { timeout: params.timeout_ms });
    }
    return toToolText({
      ok: true,
      selector: params.selector,
      typed: params.text.length,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_select",
  "Select a dropdown option by value/label/index.",
  {
    selector: z.string().min(1).describe("Select element CSS selector"),
    value: z.string().nullable().default(null).describe("Option value"),
    label: z.string().nullable().default(null).describe("Option label"),
    index: z.number().int().min(0).nullable().default(null).describe("Option index"),
  },
  async (params) => {
    const page = ensurePage();
    const target = page.locator(params.selector).first();
    const option =
      params.value !== null
        ? { value: params.value }
        : params.label !== null
          ? { label: params.label }
          : params.index !== null
            ? { index: params.index }
            : null;
    if (!option) {
      throw new Error("Provide one of value, label, or index");
    }
    await target.selectOption(option);
    return toToolText({
      ok: true,
      selector: params.selector,
      selected: option,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_scroll",
  "Scroll the current page.",
  {
    mode: z.enum(["by", "to"]).default("by").describe("Scroll by delta or to absolute position"),
    x: z.number().default(0),
    y: z.number().default(700),
  },
  async (params) => {
    const page = ensurePage();
    if (params.mode === "to") {
      await page.evaluate(
        (coords: { x: number; y: number }) => {
          window.scrollTo(coords.x, coords.y);
          return { x: window.scrollX, y: window.scrollY };
        },
        { x: params.x, y: params.y }
      );
    } else {
      await page.evaluate(
        (coords: { x: number; y: number }) => {
          window.scrollBy(coords.x, coords.y);
          return { x: window.scrollX, y: window.scrollY };
        },
        { x: params.x, y: params.y }
      );
    }
    const pos = await page.evaluate(() => ({ x: window.scrollX, y: window.scrollY }));
    return toToolText({
      ok: true,
      mode: params.mode,
      position: pos,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_wait_for",
  "Wait for an element to appear.",
  {
    selector: z.string().min(1).describe("CSS selector"),
    timeout_ms: z.number().int().min(500).max(120000).default(15000),
  },
  async (params) => {
    const page = ensurePage();
    const target = page.locator(params.selector).first();
    await target.waitFor({ timeout: params.timeout_ms, state: "visible" });
    return toToolText({
      ok: true,
      selector: params.selector,
      url: page.url(),
    });
  }
);

server.tool(
  "browser_snapshot",
  "Return current page URL/title/text and optional HTML.",
  {
    include_html: z.boolean().default(false),
    max_text_chars: z.number().int().min(500).max(500000).default(25000),
  },
  async (params) => {
    const page = ensurePage();
    const title = await page.title();
    const url = page.url();
    const text = await page.evaluate(() => {
      const bodyText = document.body?.innerText ?? "";
      return bodyText.replace(/\s+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
    });
    const payload: Record<string, unknown> = {
      url,
      title,
      text: String(text).slice(0, params.max_text_chars),
    };
    if (params.include_html) {
      payload.html = await page.content();
    }
    return toToolText(payload);
  }
);

server.tool(
  "browser_close",
  "Close the active browser session.",
  {},
  async () => {
    await closeBrowserSession();
    return toToolText({
      ok: true,
      message: "Browser session closed",
    });
  }
);

// --- open_page tool ---

server.tool(
  "open_page",
  "Fetch a web page and return cleaned HTML/text and metadata.",
  {
    url: z.string().url().describe("Absolute page URL"),
  },
  async (params) => {
    const controller = new AbortController();
    const fetchTimer = setTimeout(() => controller.abort(), 12000);
    let res: Response;
    try {
      res = await fetch(params.url, {
        method: "GET",
        redirect: "follow",
        signal: controller.signal,
        headers: {
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
          Accept:
            "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.9",
        },
      });
    } finally {
      clearTimeout(fetchTimer);
    }

    if (!res.ok) {
      throw new Error(`open_page failed: HTTP ${res.status}`);
    }

    const rawHtml = await res.text();
    const challengePattern =
      /(enable javascript and cookies|verify you are human|checking your browser|access denied|request blocked)/i;
    if (challengePattern.test(rawHtml)) {
      throw new Error("open_page blocked by anti-bot/cookie challenge");
    }

    const html = cleanHtml(rawHtml);
    const text = htmlToText(html);
    const title = extractTitle(rawHtml);

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ url: res.url, title, html, text }, null, 2),
        },
      ],
    };
  }
);

// --- Cart tools ---

server.tool(
  "add_to_cart",
  "Add an item to the shopping cart.",
  {
    name: z.string().describe("Product name"),
    url: z.string().url().describe("Product URL"),
    price: z.number().describe("Product price"),
    currency: z.string().describe("Currency code (e.g. USD, EUR)"),
    source: z.string().describe("Source website or store"),
    imageUrl: z
      .string()
      .nullable()
      .default(null)
      .describe("Product image URL"),
    category: z
      .string()
      .nullable()
      .default(null)
      .describe("Product category"),
  },
  async (params) => {
    const item: CartItem = {
      id: randomUUID(),
      name: params.name.trim(),
      url: params.url.trim(),
      price: params.price,
      currency: params.currency.trim(),
      source: params.source.trim(),
      imageUrl: params.imageUrl,
      category: params.category,
    };

    const dup = cart.find((c) => c.url === item.url);
    if (dup) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              {
                ok: false,
                message: `Item already in cart for URL: ${item.url}`,
                cart,
              },
              null,
              2
            ),
          },
        ],
      };
    }

    cart.push(item);
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, message: `Added item ${item.id}`, cart },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "list_cart",
  "List all items in the shopping cart.",
  {},
  async () => {
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, message: "Current cart", cart },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "remove_from_cart",
  "Remove an item from the shopping cart by its id.",
  {
    id: z.string().describe("UUID of the cart item to remove"),
  },
  async (params) => {
    const id = params.id.trim();
    const index = cart.findIndex((item) => item.id === id);
    if (index === -1) {
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify(
              { ok: false, message: `No item found with id "${id}"`, cart },
              null,
              2
            ),
          },
        ],
      };
    }
    const removed = cart.splice(index, 1)[0];
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, message: `Removed item ${removed.id}`, cart },
            null,
            2
          ),
        },
      ],
    };
  }
);

server.tool(
  "clear_cart",
  "Remove all items from the shopping cart.",
  {},
  async () => {
    cart.length = 0;
    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(
            { ok: true, message: "Cleared cart", cart },
            null,
            2
          ),
        },
      ],
    };
  }
);

// --- Start ---

export async function startStdioServer() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

if (require.main === module) {
  startStdioServer().catch((err) => {
    console.error("Fatal error:", err);
    process.exit(1);
  });
}
