import { FormEvent, useEffect, useRef, useState } from 'react';
import { useWebAgentSession } from './useWebAgentSession';

type Message = {
  id: number;
  role: 'user' | 'assistant';
  text: string;
};

type ProductOption = {
  id: string;
  rank: number;
  name: string;
  price: string;
  image: string;
  source: string;
  description: string;
  whyPicked: string;
};

type SessionWithStreaming = {
  prompt(input: string): Promise<string>;
  promptStreaming?: (input: string) => AsyncIterable<string>;
};

type ToolDescriptor = { name: string };
type ProductCandidate = {
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
  url: string;
  source: string;
};

type QueryConstraints = {
  maxBudget: number | null;
  currency: string | null;
  region: string;
};

const STOP_WORDS = new Set([
  // articles / prepositions / conjunctions
  'a', 'an', 'the', 'for', 'to', 'of', 'and', 'or', 'in', 'on', 'with', 'at', 'by', 'from',
  // conversational verbs / filler
  'want', 'need', 'looking', 'find', 'get', 'buy', 'purchase', 'search', 'show', 'help',
  'can', 'you', 'me', 'my', 'please', 'something', 'some', 'any', 'also', 'just', 'like',
  'would', 'should', 'could', 'recommend', 'suggest', 'what', 'which', 'that', 'this',
  // budget / price words (parsed separately by parseQueryConstraints)
  'under', 'below', 'less', 'than', 'max', 'maximum', 'budget', 'around', 'about',
  'price', 'priced', 'cheap', 'cheapest', 'affordable', 'expensive',
  // quality words (too generic for search)
  'best', 'good', 'great', 'top', 'quality', 'nice', 'decent',
  // gender (handled separately if needed)
  'mens', "men's", 'women', "women's",
]);

const BLOCKED_PAGE_RE = /access denied|robot check|verify you are human|enable javascript and cookies|request blocked|captcha|page not found|404|forbidden/i;
const IRRELEVANT_NAME_RE = /access denied|error|forbidden|blocked|homepage|category|collection|skip to|main content|navigation|cookie|sign in|log in|manage preferences|preferences|search results|my account|my cart|your cart|shopping cart|wish ?list|subscribe|newsletter|contact us|about us|privacy policy|terms of|help center|customer service|page not found/i;

export default function App() {
  const [messages, setMessages] = useState<Message[]>([
    { id: 1, role: 'assistant', text: 'Hello. I am ready to help.' },
  ]);
  const [input, setInput] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [currentWorkStep, setCurrentWorkStep] = useState('Idle');
  const [workLog, setWorkLog] = useState<string[]>([]);
  const [thinkingTick, setThinkingTick] = useState(0);
  const [researchUpdates, setResearchUpdates] = useState<string[]>([]);
  const [productOptions, setProductOptions] = useState<ProductOption[]>([]);
  const [selectedOptionId, setSelectedOptionId] = useState<string | null>(null);
  const [liveVisitEnabled, setLiveVisitEnabled] = useState(true);
  const [cartItems, setCartItems] = useState<ProductOption[]>(() => {
    try {
      const saved = localStorage.getItem('uwa-cart');
      return saved ? JSON.parse(saved) : [];
    } catch {
      return [];
    }
  });
  const [showCart, setShowCart] = useState(false);
  const [showCheckout, setShowCheckout] = useState(false);
  const researchWindowRef = useRef<Window | null>(null);
  const thinkingBoxRef = useRef<HTMLDivElement | null>(null);

  const {
    session,
    isLoading,
    models,
    selectedModel,
    setSelectedModel,
    requestModelPermissions,
    error,
  } = useWebAgentSession();

  const normalizeHttpUrl = (value: string): string | null => {
    const raw = String(value || '').trim();
    if (!raw || raw.toLowerCase() === 'n/a') return null;
    if (raw.startsWith('//')) return `https:${raw}`;
    if (/^https?:\/\//i.test(raw)) return raw;
    return null;
  };

  const unwrapSearchRedirectUrl = (value: string): string => {
    const raw = String(value || '').trim();
    if (!raw) return raw;
    try {
      const url = new URL(raw);
      // DuckDuckGo redirect wrappers
      const uddg = url.searchParams.get('uddg');
      if (uddg) return decodeURIComponent(uddg);
      const u3 = url.searchParams.get('u3');
      if (u3) {
        const nested = decodeURIComponent(u3);
        try {
          const nestedUrl = new URL(nested);
          const u = nestedUrl.searchParams.get('u');
          if (u) return decodeURIComponent(u);
          return nested;
        } catch {
          return nested;
        }
      }
      // Bing ad click wrappers
      const u = url.searchParams.get('u');
      if (u) return decodeURIComponent(u);
    } catch {
      // ignore
    }
    return raw;
  };

  const isAdOrAggregatorUrl = (value: string): boolean => {
    const v = String(value || '').toLowerCase();
    return (
      /duckduckgo\.com\/y\.js/.test(v) ||
      /doubleclick\.net/.test(v) ||
      /bing\.com\/aclick/.test(v) ||
      /[?&]ad_domain=/.test(v)
    );
  };

  const getHostLabel = (value: string): string => {
    const normalized = normalizeHttpUrl(value);
    if (!normalized) return value || 'N/A';
    try {
      return new URL(normalized).hostname.replace(/^www\./, '');
    } catch {
      return normalized;
    }
  };

  const isLikelyListingPageUrl = (value: string): boolean => {
    const v = value.toLowerCase();
    return (
      // Review/guide/listicle pages
      /best|top|review|under-|under\/|list|guide|comparison|vs|category|blog/.test(v) ||
      /rtings\.com|wirecutter|topten|reviews\./.test(v) ||
      // Amazon search/browse pages
      /amazon\.[^/]+\/s[?/]/.test(v) ||
      /amazon\.[^/]+\/b[?/]/.test(v) ||
      // Walmart search/browse pages
      /walmart\.com\/search/.test(v) ||
      /walmart\.com\/browse\//.test(v) ||
      // Target search/browse pages
      /target\.com\/s[?/]/.test(v) ||
      // Best Buy search/browse pages
      /bestbuy\.com\/site\/searchpage/.test(v) ||
      /bestbuy\.com\/site\/.*\/pcmcat/.test(v) ||
      // eBay search pages
      /ebay\.com\/sch\//.test(v) ||
      // Newegg search/browse pages
      /newegg\.com\/p\/pl/.test(v) ||
      /newegg\.com\/global\/search/.test(v) ||
      /newegg\.com\/.*\/SubCategory/.test(v) ||
      // Generic search result patterns
      /[?&](?:q|k|query|search|searchTerm|keyword)=/.test(v)
    );
  };

  const isLikelyProductUrl = (value: string): boolean => {
    const v = value.toLowerCase();
    return (
      /\/dp\/|\/gp\/product\/|\/product\/|\/products\/|\/shop\/p\/|\/shop\/product\/|\/shop\/[^/?#]+\/[^/?#]+\/?|\/p\/[^/?#]+\/?|\bsku\b|item=|pid=|asin=|\/ip\/\d|\.html$|\.htm$|\/Product\b|Item=N\d/.test(v) &&
      !isLikelyListingPageUrl(v)
    );
  };

  const getQueryTerms = (query: string): string[] => {
    // Strip budget/price phrases first so bare numbers don't leak into search terms.
    const stripped = String(query || '')
      .toLowerCase()
      .replace(/(?:under|below|less than|around|about|max(?:imum)?(?:\s+budget)?)\s*[£$€]?\s*\d[\d,.]*\b/gi, ' ')
      .replace(/[£$€]\s*\d[\d,.]*\b/g, ' ')
      .replace(/\b\d{2,5}(?:\.\d{1,2})?\s*(?:dollars?|usd|gbp|eur|euros?|pounds?|bucks?)\b/gi, ' ');
    return stripped
      .replace(/[^a-z0-9\s-]/g, ' ')
      .split(/\s+/)
      .map((w) => w.trim())
      .filter((w) => w.length >= 2 && !STOP_WORDS.has(w) && !/^\d+$/.test(w));
  };

  const extractUrlsFromQuery = (query: string): string[] => {
    const matches = String(query || '').match(/https?:\/\/[^\s)>"']+/gi) || [];
    const cleaned = matches
      .map((u) => u.replace(/[),.;!?]+$/, '').trim())
      .filter((u) => /^https?:\/\//i.test(u));
    return Array.from(new Set(cleaned));
  };

  const isBlockedOrErrorPage = (name: string | null, text: string | null): boolean => {
    const v = `${name || ''} ${text || ''}`.toLowerCase();
    return BLOCKED_PAGE_RE.test(v);
  };

  const relevanceScore = (
    queryTerms: string[],
    candidate: Pick<ProductCandidate, 'name' | 'category' | 'key_features' | 'url' | 'source'>,
  ): number => {
    const haystack = [
      candidate.name || '',
      candidate.category || '',
      ...(candidate.key_features || []),
      candidate.url || '',
      candidate.source || '',
    ]
      .join(' ')
      .toLowerCase();
    let score = 0;
    for (const t of queryTerms) {
      if (haystack.includes(t)) score += 1;
    }
    return score;
  };

  const matchesQueryTerms = (queryTerms: string[], text: string): boolean => {
    if (queryTerms.length === 0) return true;
    const hay = String(text || '').toLowerCase();
    return queryTerms.some((t) => hay.includes(t));
  };

  const looksLikeRealProductCandidate = (
    queryTerms: string[],
    candidate: Pick<ProductCandidate, 'name' | 'category' | 'key_features' | 'url' | 'availability' | 'confidence'>,
  ): boolean => {
    if (!candidate.name) return false;
    const name = candidate.name.trim();
    if (/^(results?|search|shop|home|product category|access denied)$/i.test(name)) return false;
    if (/\b(bundle|faq|save up to|shipping|returns)\b/i.test(name)) return false;
    if (IRRELEVANT_NAME_RE.test(candidate.name)) return false;
    if (isBlockedOrErrorPage(candidate.name, candidate.category || null)) return false;
    if (isLikelyListingPageUrl(candidate.url || '')) return false;
    // Reject extractions whose features/category look like search/listing page boilerplate
    const featuresText = (candidate.key_features || []).join(' ') + ' ' + (candidate.category || '');
    if (/\b(search results|related searches|search within|showing results|sort by|filter by|refine by|browse all|all categories|did you mean)\b/i.test(featuresText)) return false;
    // Don't require isLikelyProductUrl — many real product pages have non-standard URL patterns
    const topicalText = [
      candidate.name || '',
      candidate.category || '',
      ...(candidate.key_features || []),
      candidate.url || '',
    ].join(' ');
    if (!matchesQueryTerms(queryTerms, topicalText)) return false;
    if ((candidate.confidence ?? 0) < 0.1) return false;
    if (candidate.availability === 'out_of_stock') return false;
    return true;
  };

  const extractLikelyProductLinks = (html: string, baseUrl: string, queryTerms: string[]): string[] => {
    const out = new Set<string>();
    const preferredHosts = /(amazon\.|bestbuy\.|newegg\.|walmart\.|target\.|currys\.|scan\.co\.uk|overclockers\.co\.uk|ebuyer\.|microcenter\.|logitech\.|corsair\.|razer\.|steelseries\.|hyperx\.|dell\.|hp\.|lenovo\.|asus\.|msi\.|bhphotovideo\.|adorama\.)/i;
    const hrefRe = /<a[^>]+href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
    let m: RegExpExecArray | null;
    while ((m = hrefRe.exec(html)) !== null && out.size < 30) {
      const href = String(m[1] || '').trim();
      const anchorText = String(m[2] || '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
      if (!href || href.startsWith('#') || href.startsWith('javascript:') || href.startsWith('mailto:')) continue;
      try {
        const abs = new URL(href, baseUrl).toString();
        if (!/^https?:\/\//i.test(abs)) continue;
        const lower = abs.toLowerCase();
        if (/\/cart|\/checkout|\/account|\/help|\/customer-service|\/gift-card|\/mattress|\/couch|\/bedding|\/nike-shoes/.test(lower)) {
          continue;
        }
        const hasQuerySignal =
          queryTerms.length === 0 ||
          queryTerms.some((t) => lower.includes(t) || anchorText.includes(t));
        const productSignal = isLikelyProductUrl(abs);
        const hasHostAndDetailSignal =
          preferredHosts.test(abs) &&
          /(\/dp\/|\/gp\/product\/|\/product\/|\/products\/|\/shop\/p\/|\/shop\/product\/|\/p\/[^/?#]+|\bsku\b|item=|pid=|asin=|\/ip\/\d|\/Product\b|Item=N\d)/.test(lower);
        // For links with strong product URL structure on the same host, relax query matching
        const sameHost = new URL(abs).hostname === new URL(baseUrl).hostname;
        const strongProductLink = hasHostAndDetailSignal || (sameHost && productSignal);
        if ((productSignal || hasHostAndDetailSignal) && (hasQuerySignal || strongProductLink)) {
          out.add(abs);
        }
      } catch {
        // ignore
      }
    }
    return Array.from(out).slice(0, 8);
  };

  const parseJsonText = (value: string): unknown => {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  };

  const parseToolResultPayload = (result: unknown): unknown => {
    if (!result || typeof result !== 'object') return result;
    const obj = result as Record<string, unknown>;

    if (Array.isArray(obj.content)) {
      const textParts = obj.content
        .filter((c) => c && typeof c === 'object' && (c as Record<string, unknown>).type === 'text')
        .map((c) => String((c as Record<string, unknown>).text ?? ''))
        .join('\n')
        .trim();
      if (!textParts) return obj;
      return parseJsonText(textParts) ?? textParts;
    }

    return obj;
  };

  const buildHumanWhyPicked = (
    p: ProductCandidate,
    constraints: QueryConstraints,
  ): string => {
    const reasons: string[] = [];
    if (p.price !== null && constraints.maxBudget !== null) {
      if (p.price <= constraints.maxBudget) {
        reasons.push(`within your budget (${p.price} ${p.currency || ''})`.trim());
      }
    } else if (p.price !== null) {
      reasons.push(`strong value point at ${p.price} ${p.currency || ''}`.trim());
    }
    if (p.brand) {
      reasons.push(`recognized brand (${p.brand})`);
    }
    if (p.key_features?.length) {
      reasons.push(`features match your gaming use case`);
    }
    const host = getHostLabel(p.url || p.source || '');
    if (host && host !== 'N/A') {
      reasons.push(`sourced from ${host}`);
    }
    if (p.availability === 'out_of_stock') {
      reasons.push('currently out of stock');
    }
    return reasons.length > 0
      ? reasons.slice(0, 3).join('; ')
      : 'fits your request based on available product signals';
  };

  const toOption = (p: ProductCandidate, rank: number, constraints: QueryConstraints): ProductOption => {
    // Filter out review-like features and search page boilerplate from description
    const cleanFeatures = (p.key_features || []).filter(
      (f) =>
        !/\b(i |my |we |our |love it|hate it|bought this|wouldn't|i'm |i've )\b/i.test(f) &&
        !/\b(search results|related searches|search within|sort by|filter by|refine by|browse all|showing results|all categories|did you mean)\b/i.test(f),
    );
    const specSummary = Object.entries(p.specs || {})
      .slice(0, 3)
      .map(([k, v]) => `${k}: ${v}`)
      .join(' | ');

    return {
      id: `${Date.now()}-${rank}-${p.url}`,
      rank,
      name: p.name || `Product ${rank}`,
      price: p.price !== null ? `${p.price} ${p.currency || ''}`.trim() : 'N/A',
      image: p.images?.[0] || '',
      source: p.url || p.source || '',
      description:
        cleanFeatures.slice(0, 3).join(' | ') ||
        specSummary ||
        [p.brand, p.category].filter(Boolean).join(' | ') ||
        '',
      whyPicked: buildHumanWhyPicked(p, constraints),
    };
  };

  const closeResearchWindow = () => {
    const win = researchWindowRef.current;
    if (win && !win.closed) {
      try {
        win.close();
      } catch {
        // ignore
      }
    }
    researchWindowRef.current = null;
  };

  const mergeUniqueOptions = (primary: ProductOption[], extra: ProductOption[]): ProductOption[] => {
    const out: ProductOption[] = [];
    const seen = new Set<string>();
    for (const item of [...primary, ...extra]) {
      const key = `${item.name.toLowerCase()}|${(normalizeHttpUrl(item.source) || item.source || '').toLowerCase()}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out.map((item, idx) => ({ ...item, rank: idx + 1 }));
  };

  const supplementOptionsWithModel = async (
    query: string,
    existing: ProductOption[],
    minCount: number,
    activeSession: SessionWithStreaming,
  ): Promise<ProductOption[]> => {
    if (existing.length >= minCount) return existing;
    const missing = minCount - existing.length;
    const context = existing
      .map((o, idx) => `#${idx + 1} ${o.name} | ${o.price} | ${o.source}`)
      .join('\n');

    const prompt = `You are filling missing product recommendation options.

User request: ${query}
Need at least ${minCount} total options. Current options count: ${existing.length}. Add ${missing} more.

Current options:
${context || '(none)'}

Rules:
- Return ONLY the following format:
RANKED_OPTIONS:
OPTION 1
Name:
Price:
Image URL:
Product link:
Description:
Why picked:

- Product link must be a direct product detail page URL (not category/search/list pages).
- Description must be a brief product description.
- Why picked must be 2-3 concise sentences with concrete tradeoffs.
- Prefer in-stock products and strong value.
`;
    const reply = await activeSession.prompt(prompt);
    const parsed = parseProductOptions(reply)
      .filter((o) => {
        const source = normalizeHttpUrl(o.source);
        return Boolean(source && isLikelyProductUrl(source));
      });
    return mergeUniqueOptions(existing, parsed).slice(0, 8);
  };

  const parseQueryConstraints = (query: string): QueryConstraints => {
    const q = String(query || '').toLowerCase();

    const currency =
      /£|\bgbp\b|\bpound\b|\bpounds\b/.test(q)
        ? 'GBP'
        : /\$|\busd\b|\bdollar\b|\bdollars\b/.test(q)
          ? 'USD'
          : /€|\beur\b|\beuro\b|\beuros\b/.test(q)
            ? 'EUR'
            : null;

    const budgetMatch =
      q.match(/\b(?:under|below|less than|max(?:imum)?(?: budget)?)\s*[£$€]?\s*(\d{2,5}(?:\.\d{1,2})?)/i) ||
      q.match(/[£$€]\s*(\d{2,5}(?:\.\d{1,2})?)/i);
    const maxBudget = budgetMatch ? Number(budgetMatch[1]) : null;

    const region =
      currency === 'GBP'
        ? 'uk-en'
        : currency === 'EUR'
          ? 'de-de'
          : 'us-en';

    return {
      maxBudget: Number.isFinite(maxBudget ?? NaN) ? maxBudget : null,
      currency,
      region,
    };
  };

  const runToolWorkflow = async (
    query: string,
    researchWindow: Window | null,
  ): Promise<{ options: ProductOption[]; updates: string[] } | null> => {
    const listTools = window.agent?.tools?.list;
    const callTool = window.agent?.tools?.call;
    if (!listTools || !callTool) {
      return null;
    }

    const isRetryableError = (msg: string): boolean =>
      /session not found|SSE connection not established|no active session|failed to fetch|network|ECONNREFUSED|ECONNRESET|disconnected|timed out|timeout|MCP request timed/i.test(msg);

    const callToolWithTimeout = async (
      tool: string,
      args: Record<string, unknown>,
      timeoutMs: number,
      label: string,
      _retries = 0,
    ): Promise<unknown> => {
      const attempt = async (): Promise<unknown> => {
        const timeoutPromise = new Promise<never>((_, reject) => {
          const id = window.setTimeout(() => {
            window.clearTimeout(id);
            reject(new Error(`${label} timed out after ${timeoutMs}ms`));
          }, timeoutMs);
        });
        return Promise.race([callTool({ tool, args }), timeoutPromise]);
      };

      try {
        return await attempt();
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        if (isRetryableError(msg)) {
          setWorkLog((prev) => [...prev, `${label}: connection error, retrying in 2s...`]);
          await new Promise((r) => setTimeout(r, 2000));
          try {
            return await attempt();
          } catch (retryErr: unknown) {
            const retryMsg = retryErr instanceof Error ? retryErr.message : String(retryErr);
            if (isRetryableError(retryMsg)) {
              setWorkLog((prev) => [...prev, `${label}: still failing, one more retry in 3s...`]);
              await new Promise((r) => setTimeout(r, 3000));
              return await attempt();
            }
            throw retryErr;
          }
        }
        throw err;
      }
    };

    // Re-request tool permissions at call-time (grants may be denied/expired per-origin).
    try {
      await window.agent?.requestPermissions?.({
        scopes: ['mcp:tools.list', 'mcp:tools.call'],
        reason: 'Need MCP tool access for web search and product extraction workflow.',
      });
    } catch {
      setWorkLog((prev) => [...prev, 'Permission prompt failed for mcp:tools.list/mcp:tools.call.']);
    }

    let tools: ToolDescriptor[] = [];
    try {
      tools = await listTools();
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setWorkLog((prev) => [...prev, `tools.list failed: ${msg}`]);
      return null;
    }
    const availableNames = (tools || []).map((t: ToolDescriptor) => t.name);
    const names = new Set(availableNames);
    const resolveTool = (preferred: string, suffix: string, prefixHint?: string | null): string | null => {
      if (names.has(preferred)) return preferred;
      if (prefixHint) {
        const hinted = `${prefixHint}/${suffix}`;
        if (names.has(hinted)) return hinted;
      }
      const found = availableNames.find((n) => n === suffix || n.endsWith(`/${suffix}`));
      return found || null;
    };

    const webSearchTool = resolveTool('web-search-mcp/web_search', 'web_search');
    const inferredPrefix = webSearchTool?.includes('/') ? webSearchTool.split('/')[0] : null;
    const openPageTool = resolveTool('open-page-mcp/open_page', 'open_page', inferredPrefix);
    const extractProductTool = resolveTool('web-search-mcp/extract_product', 'extract_product', inferredPrefix);
    const compareProductsTool = resolveTool('compare-products-mcp/compare_products', 'compare_products', inferredPrefix);
    const browserStartTool = resolveTool('web-search-mcp/browser_start', 'browser_start', inferredPrefix);
    const browserOpenTool = resolveTool('web-search-mcp/browser_open', 'browser_open', inferredPrefix);
    const browserScrollTool = resolveTool('web-search-mcp/browser_scroll', 'browser_scroll', inferredPrefix);
    const browserClickTool = resolveTool('web-search-mcp/browser_click', 'browser_click', inferredPrefix);
    const browserTypeTool = resolveTool('web-search-mcp/browser_type', 'browser_type', inferredPrefix);
    const browserWaitForTool = resolveTool('web-search-mcp/browser_wait_for', 'browser_wait_for', inferredPrefix);
    const browserSnapshotTool = resolveTool('web-search-mcp/browser_snapshot', 'browser_snapshot', inferredPrefix);
    const browserCloseTool = resolveTool('web-search-mcp/browser_close', 'browser_close', inferredPrefix);
    const hasBrowserFallback =
      Boolean(browserStartTool) && Boolean(browserOpenTool) && Boolean(browserSnapshotTool);
    const preferBrowserPath = hasBrowserFallback;

    const hasPageAcquisitionTool = Boolean(openPageTool) || hasBrowserFallback;
    if (!webSearchTool || !extractProductTool || !hasPageAcquisitionTool) {
      setWorkLog((prev) => [
        ...prev,
        `Missing required tools. Found: ${availableNames.join(', ') || '(none)'}`,
        `Required: web_search=${Boolean(webSearchTool)}, extract_product=${Boolean(extractProductTool)}, page_acquisition(open_page or browser tools)=${hasPageAcquisitionTool}`,
      ]);
      return null;
    }

    setWorkLog((prev) => [
      ...prev,
      `Tools: web_search=${webSearchTool}, open_page=${openPageTool || 'N/A'}, browser=${hasBrowserFallback ? 'yes' : 'no'}, prefer_browser=${preferBrowserPath}`,
    ]);

    const updates: string[] = [];
    const constraints = parseQueryConstraints(query);
    const queryTerms = getQueryTerms(query);
    let browserStarted = false;
    updates.push('finding candidate products with web_search');
    setResearchUpdates([...updates]);
    setCurrentWorkStep('Tool: web_search');
    setWorkLog((prev) => [...prev, 'Running web_search...']);

    // Extract clean search terms from user input (strip conversational fluff).
    const searchTerms = queryTerms.join(' ');
    const cleanQuery = searchTerms.length >= 3 ? searchTerms : query.trim();
    const baseQuery = `${cleanQuery} buy`;
    setWorkLog((prev) => [...prev, `Search query: "${baseQuery}" (from: "${query.trim()}")`]);

    const allResults: Array<{ url?: string; source?: string }> = [];
    const seenUrls = new Set<string>();
    const explicitUrls = extractUrlsFromQuery(query);
    if (explicitUrls.length > 0) {
      setWorkLog((prev) => [
        ...prev,
        `Using ${explicitUrls.length} explicit URL(s) from your prompt as priority candidates.`,
      ]);
      for (const url of explicitUrls) {
        if (seenUrls.has(url)) continue;
        seenUrls.add(url);
        allResults.push({ url, source: getHostLabel(url) });
      }
    }

    const doSearch = async (sq: string) => {
      updates.push(`searching: ${sq.slice(0, 60)}`);
      setResearchUpdates([...updates]);
      const searchRaw = await callToolWithTimeout(
        webSearchTool,
        { query: sq, max_results: 10, region: constraints.region },
        45000,
        'web_search',
      );
      const search = parseToolResultPayload(searchRaw) as { results?: Array<{ url?: string; source?: string }> };
      for (const r of search?.results || []) {
        const unwrapped = unwrapSearchRedirectUrl(String(r.url || ''));
        if (!unwrapped || isAdOrAggregatorUrl(unwrapped)) continue;
        if (seenUrls.has(unwrapped)) continue;
        seenUrls.add(unwrapped);
        allResults.push({ ...r, url: unwrapped });
      }
    };

    try {
      await doSearch(baseQuery);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      setWorkLog((prev) => [...prev, `Search failed for "${baseQuery}": ${msg}`]);
    }

    // Only fire a second query if the first returned very few results.
    // Use site:-specific queries instead of OR (DDG OR produces off-topic results).
    if (allResults.length < 5) {
      try {
        await doSearch(`${cleanQuery} site:amazon.com`);
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        setWorkLog((prev) => [...prev, `Follow-up search failed: ${msg}`]);
      }
    }

    // Diversify: ensure we have results from different domains
    const byDomain = new Map<string, typeof allResults>();
    for (const r of allResults) {
      try {
        const host = new URL(r.url as string).hostname.replace(/^www\./, '');
        if (!byDomain.has(host)) byDomain.set(host, []);
        byDomain.get(host)!.push(r);
      } catch {
        // skip
      }
    }

    // Pick up to 2 results per domain, round-robin across domains
    const results: typeof allResults = [];
    const domainEntries = Array.from(byDomain.entries());
    for (let pass = 0; pass < 3 && results.length < 20; pass++) {
      for (const [, domainResults] of domainEntries) {
        if (pass < domainResults.length && results.length < 20) {
          results.push(domainResults[pass]);
        }
      }
    }

    if (results.length === 0) {
      setWorkLog((prev) => [...prev, 'web_search returned no candidate URLs.']);
      return { options: [], updates };
    }
    setWorkLog((prev) => [...prev, `Found ${results.length} candidates from ${byDomain.size} different sites.`]);

    const extracted: ProductCandidate[] = [];
    const visited = new Set<string>();
    const pushIfUseful = (candidate: ProductCandidate | null) => {
      if (!candidate?.name) return;
      const key = `${candidate.name.toLowerCase()}|${candidate.url}`;
      if (extracted.some((e) => `${e.name?.toLowerCase()}|${e.url}` === key)) return;
      extracted.push(candidate);
    };

    const tryBrowserInteractions = async (queryText: string, skipSearch = false) => {
      if (!browserWaitForTool || !browserClickTool || !browserTypeTool) return;
      // Wait for page to settle.
      try {
        await callToolWithTimeout(
          browserWaitForTool,
          { selector: 'body', timeout_ms: 8000 },
          9000,
          'browser_wait_for',
          0,
        );
      } catch {
        // continue
      }
      // Best-effort cookie dismiss.
      const cookieSelectors = [
        'button#onetrust-accept-btn-handler',
        'button[aria-label*="Accept"]',
        'button[title*="Accept"]',
        'button:has-text("Accept all")',
        'button:has-text("I agree")',
      ];
      for (const selector of cookieSelectors) {
        try {
          await callToolWithTimeout(
            browserClickTool,
            { selector, wait_for_navigation: false, timeout_ms: 2000 },
            3000,
            'browser_click',
            0,
          );
          break;
        } catch {
          // try next selector
        }
      }
      // If this is a homepage/listing, try searching like a human in-site.
      // Skip this on product detail pages — typing a search navigates away.
      if (!skipSearch) {
        const searchSelectors = [
          'input[type="search"]',
          'input[name="q"]',
          'input[aria-label*="Search"]',
          'input[placeholder*="Search"]',
        ];
        for (const selector of searchSelectors) {
          try {
            await callToolWithTimeout(
              browserTypeTool,
              { selector, text: queryText, append: false, press_enter: true, timeout_ms: 3000 },
              5000,
              'browser_type',
              0,
            );
            break;
          } catch {
            // try next selector
          }
        }
      }
      if (browserScrollTool) {
        try {
          await callToolWithTimeout(
            browserScrollTool,
            { mode: 'by', x: 0, y: 900 },
            6000,
            'browser_scroll',
            0,
          );
        } catch {
          // continue
        }
      }
    };

    const extractFromUrl = async (
      targetUrl: string,
      source: string,
    ): Promise<{ product: ProductCandidate | null; html: string | null }> => {
      if (visited.has(targetUrl)) return { product: null, html: null };
      visited.add(targetUrl);

      if (preferBrowserPath && hasBrowserFallback && browserStartTool && browserOpenTool && browserSnapshotTool) {
        if (!browserStarted) {
          setCurrentWorkStep('Tool: browser_start');
          await callToolWithTimeout(
            browserStartTool,
            { headless: false, timeout_ms: 15000, start_url: targetUrl },
            30000,
            'browser_start',
          );
          browserStarted = true;
        } else {
          setCurrentWorkStep('Tool: browser_open');
          await callToolWithTimeout(
            browserOpenTool,
            { url: targetUrl, timeout_ms: 15000 },
            30000,
            'browser_open',
          );
        }
        // On product pages, only dismiss cookies (skip search typing to avoid navigating away).
        // On listing/homepage URLs, do full interactions including search.
        const isProductPage = isLikelyProductUrl(targetUrl);
        await tryBrowserInteractions(cleanQuery, isProductPage);
        setCurrentWorkStep('Tool: browser_snapshot');
        const snapRaw = await callToolWithTimeout(
          browserSnapshotTool,
          { include_html: true, max_text_chars: 100000 },
          25000,
          'browser_snapshot',
        );
        const snap = parseToolResultPayload(snapRaw) as { url?: string; html?: string; text?: string };
        if (!snap?.url || !snap?.html || !snap?.text) {
          throw new Error('browser_snapshot missing html/text');
        }
        if (isBlockedOrErrorPage(null, snap.text)) {
          throw new Error('blocked/error page from browser_snapshot');
        }
        setCurrentWorkStep('Tool: extract_product');
        const exRaw = await callToolWithTimeout(
          extractProductTool,
          { url: snap.url, html: snap.html, text: snap.text },
          20000,
          'extract_product',
        );
        const product = parseToolResultPayload(exRaw) as Omit<ProductCandidate, 'url' | 'source'>;
        return {
          product: {
            ...product,
            url: snap.url,
            source: source || snap.url,
          },
          html: snap.html,
        };
      }

      if (openPageTool) {
        try {
          const pageRaw = await callToolWithTimeout(
            openPageTool,
            { url: targetUrl },
            30000,
            'open_page',
          );
          const page = parseToolResultPayload(pageRaw) as { url?: string; html?: string; text?: string };
          if (!page?.url || !page?.html || !page?.text) {
            throw new Error('open_page missing url/html/text');
          }
          if (isBlockedOrErrorPage(null, page.text)) {
            throw new Error('blocked/error page from open_page');
          }
          setCurrentWorkStep('Tool: extract_product');
          const exRaw = await callToolWithTimeout(
            extractProductTool,
            { url: page.url, html: page.html, text: page.text },
            10000,
            'extract_product',
          );
          const product = parseToolResultPayload(exRaw) as Omit<ProductCandidate, 'url' | 'source'>;
          return {
            product: {
              ...product,
              url: page.url,
              source: source || page.url,
            },
            html: page.html,
          };
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          setWorkLog((prev) => [...prev, `open_page failed for ${targetUrl}: ${message}`]);
          // Fall through to browser fallback when available.
        }
      }

      if (hasBrowserFallback && browserStartTool && browserOpenTool && browserSnapshotTool) {
        if (!browserStarted) {
          setCurrentWorkStep('Tool: browser_start');
          await callToolWithTimeout(
            browserStartTool,
            { headless: false, timeout_ms: 15000, start_url: targetUrl },
            30000,
            'browser_start',
          );
          browserStarted = true;
        } else {
          setCurrentWorkStep('Tool: browser_open');
          await callToolWithTimeout(
            browserOpenTool,
            { url: targetUrl, timeout_ms: 15000 },
            30000,
            'browser_open',
          );
        }
        if (browserScrollTool) {
          setCurrentWorkStep('Tool: browser_scroll');
          await callToolWithTimeout(
            browserScrollTool,
            { mode: 'by', x: 0, y: 1200 },
            5000,
            'browser_scroll',
          );
        }
        setCurrentWorkStep('Tool: browser_snapshot');
        const snapRaw = await callToolWithTimeout(
          browserSnapshotTool,
          { include_html: true, max_text_chars: 100000 },
          25000,
          'browser_snapshot',
        );
        const snap = parseToolResultPayload(snapRaw) as { url?: string; html?: string; text?: string };
        if (!snap?.url || !snap?.html || !snap?.text) {
          throw new Error('browser_snapshot missing html/text');
        }
        if (isBlockedOrErrorPage(null, snap.text)) {
          throw new Error('blocked/error page from browser_snapshot');
        }
        setCurrentWorkStep('Tool: extract_product');
        const exRaw = await callToolWithTimeout(
          extractProductTool,
          { url: snap.url, html: snap.html, text: snap.text },
          20000,
          'extract_product',
        );
        const product = parseToolResultPayload(exRaw) as Omit<ProductCandidate, 'url' | 'source'>;
        return {
          product: {
            ...product,
            url: snap.url,
            source: source || snap.url,
          },
          html: snap.html,
        };
      }

      throw new Error('No usable page acquisition path');
    };

    const MAX_TOTAL_VISITS = 15;
    let totalVisits = 0;

    try {
      for (const r of results) {
        if (totalVisits >= MAX_TOTAL_VISITS) break;
        totalVisits++;
        updates.push(`visiting ${r.url} (${totalVisits}/${MAX_TOTAL_VISITS})`);
        setResearchUpdates([...updates]);
        setCurrentWorkStep('Tool: open_page');
        setWorkLog((prev) => [...prev, `Opening candidate: ${r.url}`]);

        if (r.url && liveVisitEnabled) {
          try {
            if (!researchWindow || researchWindow.closed) {
              researchWindowRef.current = window.open(
                r.url as string,
                'uwa-research-window',
                'width=1100,height=800',
              );
              if (!researchWindowRef.current) {
                setWorkLog((prev) => [...prev, 'Popup blocked by browser. Allow popups to watch live navigation.']);
              }
            } else {
              researchWindow.location.href = r.url;
            }
          } catch {
            setWorkLog((prev) => [...prev, `Could not open live visit window for: ${r.url}`]);
          }
        }

        try {
          const firstPass = await extractFromUrl(r.url as string, r.source || (r.url as string));
          const candidate = firstPass.product;
          const weakCandidate =
            !candidate ||
            !candidate.name ||
            IRRELEVANT_NAME_RE.test(candidate.name || '') ||
            candidate.price === null ||
            (candidate.confidence ?? 0) < 0.2 ||
            isLikelyListingPageUrl(candidate.url);

          if (!weakCandidate) {
            if (looksLikeRealProductCandidate(queryTerms, candidate)) {
              pushIfUseful(candidate);
              setWorkLog((prev) => [...prev, `Extracted product from: ${candidate.url}`]);
            } else {
              setWorkLog((prev) => [...prev, `Skipping irrelevant/blocked candidate: ${candidate.url}`]);
            }
            continue;
          }

          // Likely a list/review page; follow likely product links from the HTML.
          const childLinks = firstPass.html ? extractLikelyProductLinks(firstPass.html, r.url as string, queryTerms) : [];
          if (childLinks.length > 0) {
            setWorkLog((prev) => [...prev, `Found ${childLinks.length} likely product links on ${r.url}`]);
          }
          for (const childUrl of childLinks.slice(0, 5)) {
            if (totalVisits >= MAX_TOTAL_VISITS) break;
            totalVisits++;
            try {
              updates.push(`visiting ${childUrl} (${totalVisits}/${MAX_TOTAL_VISITS})`);
              setResearchUpdates([...updates]);
              const child = await extractFromUrl(childUrl, childUrl);
              if (child.product && child.product.name && !IRRELEVANT_NAME_RE.test(child.product.name)) {
                if (looksLikeRealProductCandidate(queryTerms, child.product)) {
                  pushIfUseful(child.product);
                  setWorkLog((prev) => [...prev, `Extracted product link: ${childUrl}`]);
                } else {
                  setWorkLog((prev) => [...prev, `Skipping irrelevant child link: ${childUrl}`]);
                }
              }
            } catch {
              // continue other links
            }
          }
        } catch (error: unknown) {
          const message = error instanceof Error ? error.message : String(error);
          setWorkLog((prev) => [...prev, `Candidate failed: ${r.url} (${message})`]);
          // If we have products and hit a session/timeout error, stop visiting and return what we have
          if (extracted.length > 0 && isRetryableError(message)) {
            setWorkLog((prev) => [...prev, `Connection unstable after ${totalVisits} visits — returning ${extracted.length} products found so far.`]);
            break;
          }
        }
      }
      setWorkLog((prev) => [...prev, `Visited ${totalVisits} pages total, extracted ${extracted.length} products.`]);
    } finally {
      if (browserStarted && browserCloseTool) {
        try {
          await callToolWithTimeout(
            browserCloseTool,
            {},
            10000,
            'browser_close',
          );
        } catch {
          // Best effort cleanup.
        }
      }
    }

    const valid = extracted.filter((p) => {
      if (!p.name) return false;
      if (IRRELEVANT_NAME_RE.test(p.name)) return false;
      if (isBlockedOrErrorPage(p.name, p.category || null)) return false;
      // Accept products with price OR high confidence structured data
      if (p.price === null && (p.confidence ?? 0) < 0.25) return false;
      if (constraints.currency && p.currency && String(p.currency).toUpperCase() !== constraints.currency) return false;
      if (constraints.maxBudget !== null && (p.price ?? Infinity) > constraints.maxBudget) return false;
      if (p.availability && p.availability === 'out_of_stock') return false;
      return (p.confidence ?? 0) >= 0.1;
    });

    if (valid.length === 0) {
      const softCandidates = extracted
        .filter((p) => p.name && !IRRELEVANT_NAME_RE.test(p.name) && (p.confidence ?? 0) >= 0.08)
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3);
      if (softCandidates.length > 0) {
        setWorkLog((prev) => [
          ...prev,
          `Strict filters produced 0 results; using ${softCandidates.length} best-available candidates.`,
        ]);
        return {
          options: softCandidates.map((p, idx) => toOption(p, idx + 1, constraints)),
          updates,
        };
      }
      // Last resort: return any extracted product with a name, even without confidence
      const lastResort = extracted
        .filter((p) => p.name && !IRRELEVANT_NAME_RE.test(p.name))
        .sort((a, b) => (b.confidence ?? 0) - (a.confidence ?? 0))
        .slice(0, 3);
      if (lastResort.length > 0) {
        setWorkLog((prev) => [
          ...prev,
          `All filters produced 0 results; returning ${lastResort.length} best-effort candidates.`,
        ]);
        return {
          options: lastResort.map((p, idx) => toOption(p, idx + 1, constraints)),
          updates,
        };
      }
      setWorkLog((prev) => [
        ...prev,
        `Extracted ${extracted.length} products but none passed filters (query constraints + confidence).`,
      ]);
      return { options: [], updates };
    }

    updates.push('comparing quality, price, and reputation');
    setResearchUpdates([...updates]);
    setCurrentWorkStep('Tool: compare_products');

    let ranked = valid;
    try {
      if (!compareProductsTool) {
        throw new Error('compare_products not available');
      }
      const compareRaw = await callToolWithTimeout(
        compareProductsTool,
        {
          products: valid,
          criteria: {
            budget: {
              currency: constraints.currency,
              max: constraints.maxBudget,
            },
            prioritize: ['quality', 'price', 'reputation'],
            user_requirements: query,
          },
        },
        20000,
        'compare_products',
      );
      const compare = parseToolResultPayload(compareRaw) as {
        ranked?: Array<{ product?: ProductCandidate }>;
      };
      const compared = (compare?.ranked || [])
        .map((entry) => entry.product)
        .filter((p): p is ProductCandidate => !!p);
      if (compared.length > 0) ranked = compared;
    } catch {
      setWorkLog((prev) => [...prev, 'compare_products unavailable/failed, using fallback ranking.']);
      ranked = [...valid].sort((a, b) => {
        const scoreA = (a.confidence ?? 0) - (a.price ?? 9999) / 200;
        const scoreB = (b.confidence ?? 0) - (b.price ?? 9999) / 200;
        return scoreB - scoreA;
      });
    }

    return {
      options: ranked.slice(0, 3).map((p, idx) => toOption(p, idx + 1, constraints)),
      updates,
    };
  };

  useEffect(() => {
    if (!isSending) return;
    const id = window.setInterval(() => {
      setThinkingTick((prev) => (prev + 1) % 3);
    }, 350);
    return () => {
      window.clearInterval(id);
    };
  }, [isSending]);

  useEffect(() => {
    try {
      localStorage.setItem('uwa-cart', JSON.stringify(cartItems));
    } catch {
      // storage full or unavailable
    }
  }, [cartItems]);

  const addToCart = (item: ProductOption) => {
    setCartItems((prev) => {
      const normalizedSource = (normalizeHttpUrl(item.source) || item.source || '').toLowerCase();
      if (prev.some((c) => (normalizeHttpUrl(c.source) || c.source || '').toLowerCase() === normalizedSource)) {
        return prev;
      }
      return [...prev, item];
    });
    setSelectedOptionId(null);
  };

  const removeFromCart = (itemId: string) => {
    setCartItems((prev) => prev.filter((c) => c.id !== itemId));
  };

  const clearCart = () => {
    setCartItems([]);
    setShowCheckout(false);
  };

  const parsePrice = (priceStr: string): number => {
    const cleaned = priceStr.replace(/[^0-9.]/g, '');
    const n = parseFloat(cleaned);
    return Number.isFinite(n) ? n : 0;
  };

  const cartSubtotal = cartItems.reduce((sum, item) => sum + parsePrice(item.price), 0);

  const getSection = (text: string, header: string, nextHeader?: string): string => {
    const startRegex = new RegExp(`^${header}\\s*$`, 'im');
    const startMatch = text.match(startRegex);
    if (!startMatch || startMatch.index === undefined) {
      return '';
    }
    const start = startMatch.index + startMatch[0].length;

    if (!nextHeader) {
      return text.slice(start).trim();
    }

    const remainder = text.slice(start);
    const endRegex = new RegExp(`^${nextHeader}\\s*$`, 'im');
    const endMatch = remainder.match(endRegex);
    if (!endMatch || endMatch.index === undefined) {
      return remainder.trim();
    }
    return remainder.slice(0, endMatch.index).trim();
  };

  const parseResearchUpdates = (text: string): string[] => {
    const updatesSection = getSection(text, 'RESEARCH_UPDATES:', 'RANKED_OPTIONS:');
    const source = updatesSection || text;

    const lines = source
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.replace(/^(?:-|\*|\d+\.)\s*/, ''))
      .filter((line) => /^(visiting|checking|searching|finding|comparing|screening|reviewing)/i.test(line));

    return Array.from(new Set(lines));
  };

  const parseProductOptions = (text: string): ProductOption[] => {
    const optionsSection = getSection(text, 'RANKED_OPTIONS:');
    const source = optionsSection || text;

    const normalized = source.replace(/\r/g, '');
    const rawBlocks = normalized
      .split(/\n(?=OPTION\s+\d+\s*$|\d+\.\s+Name\s*:|Name\s*:)/i)
      .map((block) => block.trim())
      .filter((block) => /(OPTION\s+\d+|Name\s*:)/i.test(block));

    const allFieldLabels =
      '(Name|Price|image|image url|source\\/link or product|source|product link|link|product|desctiption|description|why you picked|why i picked|why picked)';
    const getField = (block: string, labelPattern: string): string => {
      const pattern = new RegExp(`^${labelPattern}\\s*:\\s*([\\s\\S]*?)(?=^${allFieldLabels}\\s*:|^OPTION\\s+\\d+\\s*$|$)`, 'gim');
      const match = pattern.exec(block);
      return match?.[1]?.trim() || '';
    };

    const parsed = rawBlocks
      .map((block) => {
        const cleanedBlock = block.replace(/^OPTION\s+\d+\s*$/im, '').trim();
        const name = getField(cleanedBlock, 'Name');
        if (!name) return null;

        const price = getField(cleanedBlock, 'Price');
        const image = getField(cleanedBlock, 'image url|image');
        const source = getField(cleanedBlock, 'source\\/link or product|product link|source|link|product');
        const description = getField(cleanedBlock, 'desctiption|description');
        const whyPicked = getField(cleanedBlock, 'why you picked|why i picked|why picked');

        return {
          id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          rank: 0,
          name,
          price,
          image,
          source,
          description,
          whyPicked,
        } as ProductOption;
      })
      .filter((v): v is ProductOption => v !== null);

    return parsed.map((item, idx) => ({
      ...item,
      rank: idx + 1,
    }));
  };

  const onSend = async (e: FormEvent) => {
    e.preventDefault();
    const value = input.trim();
    if (!value || isSending) return;

    setMessages((prev) => [
      ...prev,
      { id: Date.now(), role: 'user', text: value },
    ]);
    setInput('');
    setWorkLog([]);
    setResearchUpdates([]);
    setProductOptions([]);
    setSelectedOptionId(null);
    setCurrentWorkStep('Gathering requirements');

    if (liveVisitEnabled) {
      setWorkLog((prev) => [...prev, 'Live visit is enabled. A popup will open when the first candidate URL is visited.']);
    }

    const promptText = `You are a product research assistant.

User requirements:
${value}

Page URL: ${window.location.href}
Page Title: ${document.title}

Return plain text with this exact layout:

RESEARCH_UPDATES:
- visiting x site...
- finding best options...
- comparing quality, price, and reputation...

RANKED_OPTIONS:
OPTION 1
Name:
Price:
image:
source/link or product:
desctiption:
why you picked:

OPTION 2
Name:
Price:
image:
source/link or product:
desctiption:
why you picked:

OPTION 3
Name:
Price:
image:
source/link or product:
desctiption:
why you picked:

Ranking rules:
- Rank by overall quality, value for price, and seller/brand reputation.
- Ensure recommendations satisfy all user requirements.
- Provide at least 3 options when possible.
- Keep each field concise and useful.
- No extra format outside these sections.`;

    setIsSending(true);
    try {
      setCurrentWorkStep('Researching in background (querying model)');
      setWorkLog((prev) => [...prev, 'Prepared requirements and page context.']);

      let toolResult: { options: ProductOption[]; updates: string[] } | null = null;
      try {
        toolResult = await runToolWorkflow(value, researchWindowRef.current);
      } catch (workflowError: unknown) {
        const message = workflowError instanceof Error ? workflowError.message : String(workflowError);
        if (/timed out|timeout|MCP request timed out/i.test(message)) {
          setWorkLog((prev) => [
            ...prev,
            'MCP request timed out. Check Harbor tool server status and remote endpoint connectivity.',
          ]);
        }
        setWorkLog((prev) => [...prev, `Tool workflow error: ${message}`]);
      }
      if (toolResult && toolResult.options.length > 0) {
        let finalOptions = toolResult.options;
        // Ensure broad queries still return a useful set of options.
        if (session) {
          try {
            finalOptions = await supplementOptionsWithModel(value, finalOptions, 5, session);
          } catch {
            // Model enrichment failed (likely timeout) — use original options as-is
            setWorkLog((prev) => [...prev, 'supplementOptionsWithModel failed — using raw tool results.']);
          }
        }
        setProductOptions(finalOptions);
        setWorkLog((prev) => [...prev, `Tool workflow returned ${finalOptions.length} options.`]);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            text: `I used MCP tools and found ${finalOptions.length} ranked options with direct product links.`,
          },
        ]);
        closeResearchWindow();
        setCurrentWorkStep('Completed');
        return;
      }

      const toolStatus = toolResult === null ? 'Tools not connected (is the SSE server running at localhost:8787?)' : `Tools connected but extracted 0 valid products from visited pages.`;
      setWorkLog((prev) => [...prev, `Falling back to model: ${toolStatus}`]);
      if (!session) {
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            text: `${toolStatus} Model session also unavailable — check that your model is loaded in Harbor/Ollama and permissions are granted.`,
          },
        ]);
        closeResearchWindow();
        setCurrentWorkStep('Failed');
        return;
      }

      try {
        const streamingSession = session as SessionWithStreaming;
        let replyText = '';
        if (streamingSession.promptStreaming) {
          for await (const token of streamingSession.promptStreaming(promptText)) {
            replyText += token;
            const liveUpdates = parseResearchUpdates(replyText);
            if (liveUpdates.length > 0) {
              setResearchUpdates(liveUpdates);
            }
          }
        } else {
          replyText = await session.prompt(promptText);
        }

        setCurrentWorkStep('Parsing ranked options');
        const parsedUpdates = parseResearchUpdates(replyText);
        const parsedOptions = parseProductOptions(replyText);

        if (parsedUpdates.length > 0) {
          setResearchUpdates(parsedUpdates);
        }

        if (parsedOptions.length > 0) {
          const filtered = parsedOptions.filter((o) => {
            const source = normalizeHttpUrl(o.source);
            return Boolean(source && isLikelyProductUrl(source));
          });
          let supplemented = filtered;
          try {
            supplemented = await supplementOptionsWithModel(value, filtered, 5, session);
          } catch {
            setWorkLog((prev) => [...prev, 'supplementOptionsWithModel failed — using parsed options as-is.']);
          }
          setProductOptions(supplemented);
          setWorkLog((prev) => [...prev, `Parsed ${supplemented.length} ranked options.`]);
          setMessages((prev) => [
            ...prev,
            {
              id: Date.now() + 1,
              role: 'assistant',
              text: `I found ${supplemented.length} ranked options with direct product links.`,
            },
          ]);
        } else {
          setWorkLog((prev) => [...prev, 'Could not parse structured options, showing raw response.']);
          setMessages((prev) => [
            ...prev,
            { id: Date.now() + 1, role: 'assistant', text: replyText || 'No results found. Try a more specific query.' },
          ]);
        }
      } catch (modelError: unknown) {
        const modelMsg = modelError instanceof Error ? modelError.message : String(modelError);
        setWorkLog((prev) => [...prev, `Model fallback failed: ${modelMsg}`]);
        setMessages((prev) => [
          ...prev,
          {
            id: Date.now() + 1,
            role: 'assistant',
            text: `Could not get results. Tool workflow found no valid products and the model fallback also failed (${modelMsg}). Try again or use a different query.`,
          },
        ]);
      }

      closeResearchWindow();
      setCurrentWorkStep('Completed');
    } catch (sendError: unknown) {
      const errorText =
        sendError instanceof Error ? sendError.message : 'Failed to get response from window.ai';
      setMessages((prev) => [
        ...prev,
        { id: Date.now() + 1, role: 'assistant', text: `Error: ${errorText}` },
      ]);
      setWorkLog((prev) => [...prev, `Request failed: ${errorText}`]);
      setCurrentWorkStep('Failed');
    } finally {
      closeResearchWindow();
      setIsSending(false);
    }
  };

  useEffect(() => {
    const el = thinkingBoxRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [workLog, researchUpdates, currentWorkStep, isSending]);

  return (
    <div style={{ fontFamily: 'system-ui, -apple-system, Segoe UI, sans-serif' }}>
      <div
        style={{
          position: 'fixed',
          top: 0,
          right: 0,
          width: '360px',
          height: '100vh',
          background: '#111827',
          color: '#e5e7eb',
          borderLeft: '1px solid #374151',
          display: 'flex',
          flexDirection: 'column',
          boxShadow: '-8px 0 20px rgba(0, 0, 0, 0.35)',
        }}
      >
        <header
          style={{
            padding: '16px',
            borderBottom: '1px solid #374151',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          <div style={{ fontSize: '16px', fontWeight: 600, display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <span>Universal Web Agent</span>
            <button
              type="button"
              onClick={() => { setShowCart(!showCart); setShowCheckout(false); }}
              style={{
                background: 'none',
                border: 'none',
                color: '#e5e7eb',
                cursor: 'pointer',
                fontSize: '18px',
                position: 'relative',
                padding: '4px 8px',
              }}
              title="View cart"
            >
              {'\uD83D\uDED2'}
              {cartItems.length > 0 && (
                <span
                  style={{
                    position: 'absolute',
                    top: '-2px',
                    right: '0px',
                    background: '#ef4444',
                    color: '#fff',
                    fontSize: '10px',
                    fontWeight: 700,
                    borderRadius: '50%',
                    width: '16px',
                    height: '16px',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    lineHeight: 1,
                  }}
                >
                  {cartItems.length}
                </span>
              )}
            </button>
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: '6px', fontSize: '12px', color: '#9ca3af' }}>
            Model
            <select
              value={selectedModel}
              onChange={(e) => setSelectedModel(e.target.value)}
              disabled={isLoading}
              style={{
                background: '#0f172a',
                color: '#e5e7eb',
                border: '1px solid #374151',
                borderRadius: '8px',
                padding: '8px 10px',
                fontSize: '13px',
                outline: 'none',
              }}
            >
              {models.length === 0 ? (
                selectedModel ? (
                  <option value={selectedModel}>{selectedModel}</option>
                ) : (
                  <option value="">Default model</option>
                )
              ) : (
                <>
                  {!models.some((m) => m.value === selectedModel) && selectedModel ? (
                    <option value={selectedModel}>{selectedModel}</option>
                  ) : null}
                  {models.map((model) => (
                    <option key={model.value} value={model.value}>
                      {model.label}
                      {model.requiresApiKey ? ' (API key required)' : ''}
                    </option>
                  ))}
                </>
              )}
            </select>
          </label>
        </header>

        <main
          style={{
            flex: 1,
            overflowY: 'auto',
            padding: '16px',
            display: 'flex',
            flexDirection: 'column',
            gap: '10px',
          }}
        >
          {isLoading && (
            <div
              style={{
                alignSelf: 'flex-start',
                maxWidth: '85%',
                padding: '10px 12px',
                borderRadius: '12px',
                background: '#1f2937',
                border: '1px solid #374151',
                lineHeight: 1.4,
                fontSize: '14px',
              }}
            >
              Connecting to Web Agent session...
            </div>
          )}
          {error && (
            <div
              style={{
                alignSelf: 'flex-start',
                maxWidth: '85%',
                padding: '10px 12px',
                borderRadius: '12px',
                background: '#3f1d1d',
                border: '1px solid #7f1d1d',
                lineHeight: 1.4,
                fontSize: '14px',
              }}
            >
              Error: {error}
              {error.toLowerCase().includes('permission') && (
                <div style={{ marginTop: '8px' }}>
                  <button
                    type="button"
                    onClick={() => {
                      requestModelPermissions().catch(() => {
                        // keep existing error text
                      });
                    }}
                    style={{
                      background: '#2563eb',
                      color: '#fff',
                      border: 'none',
                      borderRadius: '6px',
                      padding: '6px 10px',
                      fontSize: '12px',
                      fontWeight: 600,
                      cursor: 'pointer',
                    }}
                  >
                    Grant Access
                  </button>
                </div>
              )}
            </div>
          )}
          {messages.map((msg) => (
            <div
              key={msg.id}
              style={{
                alignSelf: msg.role === 'user' ? 'flex-end' : 'flex-start',
                maxWidth: '85%',
                padding: '10px 12px',
                borderRadius: '12px',
                background: msg.role === 'user' ? '#2563eb' : '#1f2937',
                border: '1px solid #374151',
                lineHeight: 1.4,
                fontSize: '14px',
              }}
            >
              {msg.text}
            </div>
          ))}

          {productOptions.length > 0 && !showCart && !showCheckout && (
            <section
              style={{
                marginTop: '4px',
                padding: '10px',
                borderRadius: '10px',
                background: '#0f172a',
                border: '1px solid #334155',
              }}
            >
              <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '8px' }}>
                Ranked Options (pick one)
              </div>
              <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                {productOptions.map((option) => {
                  const selected = selectedOptionId === option.id;
                  const imageUrl = normalizeHttpUrl(option.image);
                  const sourceUrl = normalizeHttpUrl(option.source);
                  const fallbackIcon = sourceUrl
                    ? `https://www.google.com/s2/favicons?sz=128&domain_url=${encodeURIComponent(sourceUrl)}`
                    : null;
                  const alreadyInCart = cartItems.some(
                    (c) => (normalizeHttpUrl(c.source) || '').toLowerCase() === (sourceUrl || '').toLowerCase(),
                  );
                  return (
                    <div
                      key={option.id}
                      onClick={() => setSelectedOptionId(option.id)}
                      style={{
                        background: selected ? '#1d4ed8' : '#111827',
                        color: '#e5e7eb',
                        border: selected ? '1px solid #60a5fa' : '1px solid #374151',
                        borderRadius: '10px',
                        padding: '10px',
                        cursor: 'pointer',
                        display: 'grid',
                        gridTemplateColumns: '76px 1fr',
                        gap: '10px',
                      }}
                    >
                      <div
                        style={{
                          width: '76px',
                          height: '76px',
                          borderRadius: '8px',
                          background: '#0b1220',
                          border: '1px solid #334155',
                          display: 'flex',
                          alignItems: 'center',
                          justifyContent: 'center',
                          overflow: 'hidden',
                          fontSize: '11px',
                          color: '#94a3b8',
                          textAlign: 'center',
                        }}
                      >
                        {imageUrl || fallbackIcon ? (
                          <img
                            src={imageUrl || fallbackIcon || ''}
                            alt={option.name}
                            style={{
                              width: '100%',
                              height: '100%',
                              objectFit: imageUrl ? 'contain' : 'cover',
                              display: 'block',
                            }}
                          />
                        ) : (
                          'No image'
                        )}
                      </div>

                      <div style={{ minWidth: 0 }}>
                        <div style={{ fontWeight: 700, marginBottom: '4px' }}>
                          {selected ? '◉' : '○'} #{option.rank} {option.name}
                          {alreadyInCart && (
                            <span style={{ fontSize: '10px', color: '#4ade80', marginLeft: '6px' }}>In cart</span>
                          )}
                        </div>
                        <div style={{ fontSize: '12px', lineHeight: 1.4, wordBreak: 'break-word' }}>
                          <div><strong>Price:</strong> {option.price || 'N/A'}</div>
                          <div>
                            <strong>Image URL:</strong>{' '}
                            {imageUrl ? (
                              <a
                                href={imageUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: '#bfdbfe', textDecoration: 'underline' }}
                              >
                                Open image
                              </a>
                            ) : (
                              'N/A'
                            )}
                          </div>
                          <div>
                            <strong>Product link:</strong>{' '}
                            {sourceUrl ? (
                              <a
                                href={sourceUrl}
                                target="_blank"
                                rel="noreferrer"
                                onClick={(e) => e.stopPropagation()}
                                style={{ color: '#bfdbfe', textDecoration: 'underline' }}
                              >
                                {getHostLabel(sourceUrl)}
                              </a>
                            ) : (
                              'N/A'
                            )}
                          </div>
                          <div><strong>Description:</strong> {option.description || 'N/A'}</div>
                          <div><strong>Why picked:</strong> {option.whyPicked || 'N/A'}</div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>

              {selectedOptionId && (() => {
                const selectedItem = productOptions.find((o) => o.id === selectedOptionId);
                if (!selectedItem) return null;
                const alreadyInCart = cartItems.some(
                  (c) => (normalizeHttpUrl(c.source) || '').toLowerCase() === (normalizeHttpUrl(selectedItem.source) || '').toLowerCase(),
                );
                return (
                  <button
                    type="button"
                    disabled={alreadyInCart}
                    onClick={() => addToCart(selectedItem)}
                    style={{
                      marginTop: '10px',
                      width: '100%',
                      padding: '10px',
                      borderRadius: '8px',
                      border: 'none',
                      background: alreadyInCart ? '#374151' : '#16a34a',
                      color: '#fff',
                      fontWeight: 700,
                      fontSize: '14px',
                      cursor: alreadyInCart ? 'not-allowed' : 'pointer',
                    }}
                  >
                    {alreadyInCart ? 'Already in cart' : 'Add to Cart'}
                  </button>
                );
              })()}
            </section>
          )}

          {showCart && !showCheckout && (
            <section>
              <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '10px' }}>
                Cart ({cartItems.length} {cartItems.length === 1 ? 'item' : 'items'})
              </div>
              {cartItems.length === 0 ? (
                <div style={{ fontSize: '13px', color: '#9ca3af', padding: '20px 0', textAlign: 'center' }}>
                  Your cart is empty. Search for products and add them here.
                </div>
              ) : (
                <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {cartItems.map((item) => {
                    const imgUrl = normalizeHttpUrl(item.image);
                    const srcUrl = normalizeHttpUrl(item.source);
                    const fallback = srcUrl
                      ? `https://www.google.com/s2/favicons?sz=64&domain_url=${encodeURIComponent(srcUrl)}`
                      : null;
                    return (
                      <div
                        key={item.id}
                        style={{
                          background: '#1f2937',
                          border: '1px solid #374151',
                          borderRadius: '10px',
                          padding: '10px',
                          display: 'grid',
                          gridTemplateColumns: '52px 1fr 28px',
                          gap: '8px',
                          alignItems: 'center',
                        }}
                      >
                        <div
                          style={{
                            width: '52px',
                            height: '52px',
                            borderRadius: '6px',
                            background: '#0b1220',
                            border: '1px solid #334155',
                            overflow: 'hidden',
                            display: 'flex',
                            alignItems: 'center',
                            justifyContent: 'center',
                          }}
                        >
                          {(imgUrl || fallback) ? (
                            <img
                              src={imgUrl || fallback || ''}
                              alt={item.name}
                              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
                            />
                          ) : (
                            <span style={{ fontSize: '10px', color: '#94a3b8' }}>No img</span>
                          )}
                        </div>
                        <div style={{ minWidth: 0 }}>
                          <div style={{ fontWeight: 600, fontSize: '13px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {item.name}
                          </div>
                          <div style={{ fontSize: '12px', color: '#9ca3af' }}>
                            {item.price || 'N/A'} &middot;{' '}
                            {srcUrl ? (
                              <a href={srcUrl} target="_blank" rel="noreferrer" style={{ color: '#93c5fd', textDecoration: 'none' }}>
                                {getHostLabel(srcUrl)}
                              </a>
                            ) : 'N/A'}
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeFromCart(item.id)}
                          title="Remove from cart"
                          style={{
                            background: 'none',
                            border: 'none',
                            color: '#ef4444',
                            cursor: 'pointer',
                            fontSize: '16px',
                            padding: '4px',
                          }}
                        >
                          ✕
                        </button>
                      </div>
                    );
                  })}

                  <div style={{
                    marginTop: '8px',
                    padding: '10px',
                    background: '#0f172a',
                    borderRadius: '8px',
                    border: '1px solid #334155',
                  }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '14px', fontWeight: 600 }}>
                      <span>Subtotal</span>
                      <span>${cartSubtotal.toFixed(2)}</span>
                    </div>
                    <div style={{ fontSize: '11px', color: '#9ca3af', marginTop: '4px' }}>
                      {cartItems.length} {cartItems.length === 1 ? 'item' : 'items'} from {new Set(cartItems.map((c) => getHostLabel(c.source))).size} {new Set(cartItems.map((c) => getHostLabel(c.source))).size === 1 ? 'site' : 'sites'}
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: '8px', marginTop: '4px' }}>
                    <button
                      type="button"
                      onClick={() => setShowCart(false)}
                      style={{
                        flex: 1,
                        padding: '10px',
                        borderRadius: '8px',
                        border: '1px solid #374151',
                        background: '#1f2937',
                        color: '#e5e7eb',
                        fontWeight: 600,
                        fontSize: '13px',
                        cursor: 'pointer',
                      }}
                    >
                      Continue Shopping
                    </button>
                    <button
                      type="button"
                      onClick={() => setShowCheckout(true)}
                      style={{
                        flex: 1,
                        padding: '10px',
                        borderRadius: '8px',
                        border: 'none',
                        background: '#2563eb',
                        color: '#fff',
                        fontWeight: 600,
                        fontSize: '13px',
                        cursor: 'pointer',
                      }}
                    >
                      Checkout
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={clearCart}
                    style={{
                      marginTop: '4px',
                      background: 'none',
                      border: 'none',
                      color: '#ef4444',
                      cursor: 'pointer',
                      fontSize: '12px',
                      textAlign: 'center',
                      width: '100%',
                      padding: '4px',
                    }}
                  >
                    Clear cart
                  </button>
                </div>
              )}
            </section>
          )}

          {showCheckout && (
            <section>
              <div style={{ fontSize: '14px', fontWeight: 600, marginBottom: '10px' }}>
                Checkout Summary
              </div>
              <div style={{
                padding: '12px',
                background: '#0f172a',
                borderRadius: '10px',
                border: '1px solid #334155',
                fontSize: '13px',
              }}>
                <div style={{ marginBottom: '10px', color: '#9ca3af', fontSize: '12px' }}>
                  Your virtual cart collects items from multiple stores. Click each link to purchase from that retailer.
                </div>

                {cartItems.map((item, idx) => {
                  const srcUrl = normalizeHttpUrl(item.source);
                  return (
                    <div
                      key={item.id}
                      style={{
                        padding: '8px 0',
                        borderTop: idx > 0 ? '1px solid #1e293b' : 'none',
                        display: 'flex',
                        justifyContent: 'space-between',
                        alignItems: 'center',
                        gap: '8px',
                      }}
                    >
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <div style={{ fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {item.name}
                        </div>
                        <div style={{ fontSize: '11px', color: '#9ca3af' }}>
                          {srcUrl ? (
                            <a href={srcUrl} target="_blank" rel="noreferrer" style={{ color: '#93c5fd' }}>
                              {getHostLabel(srcUrl)} &rarr;
                            </a>
                          ) : 'N/A'}
                        </div>
                      </div>
                      <div style={{ fontWeight: 600, whiteSpace: 'nowrap' }}>
                        {item.price || 'N/A'}
                      </div>
                    </div>
                  );
                })}

                <div style={{
                  marginTop: '10px',
                  paddingTop: '10px',
                  borderTop: '1px solid #334155',
                  display: 'flex',
                  justifyContent: 'space-between',
                  fontWeight: 700,
                  fontSize: '15px',
                }}>
                  <span>Total</span>
                  <span>${cartSubtotal.toFixed(2)}</span>
                </div>

                <div style={{ marginTop: '6px', fontSize: '11px', color: '#9ca3af' }}>
                  Across {new Set(cartItems.map((c) => getHostLabel(c.source))).size} {new Set(cartItems.map((c) => getHostLabel(c.source))).size === 1 ? 'retailer' : 'retailers'}
                </div>
              </div>

              <div style={{ display: 'flex', gap: '8px', marginTop: '10px' }}>
                <button
                  type="button"
                  onClick={() => setShowCheckout(false)}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: '8px',
                    border: '1px solid #374151',
                    background: '#1f2937',
                    color: '#e5e7eb',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                  }}
                >
                  Back to Cart
                </button>
                <button
                  type="button"
                  onClick={() => {
                    // Browsers block opening multiple tabs from one click.
                    // Open a single tab with all product links listed.
                    const items = cartItems
                      .map((item) => ({
                        name: item.name,
                        price: item.price,
                        url: normalizeHttpUrl(item.source),
                      }))
                      .filter((item): item is { name: string; price: string; url: string } => !!item.url);
                    const html = `<!DOCTYPE html><html><head><title>Cart Links</title>
<style>body{font-family:system-ui;background:#0f172a;color:#e5e7eb;padding:24px;max-width:600px;margin:0 auto}
a{color:#93c5fd;text-decoration:none;font-size:15px}a:hover{text-decoration:underline}
.item{padding:12px 0;border-bottom:1px solid #334155}.price{color:#9ca3af;font-size:13px;margin-top:2px}
h1{font-size:18px;margin-bottom:16px}</style></head><body>
<h1>Your Cart Links (${items.length} items)</h1>
${items.map((it, i) => `<div class="item"><a href="${it.url}" target="_blank" rel="noopener">${i + 1}. ${it.name}</a><div class="price">${it.price || 'N/A'}</div></div>`).join('')}
</body></html>`;
                    const blob = new Blob([html], { type: 'text/html' });
                    const blobUrl = URL.createObjectURL(blob);
                    window.open(blobUrl, '_blank');
                  }}
                  style={{
                    flex: 1,
                    padding: '10px',
                    borderRadius: '8px',
                    border: 'none',
                    background: '#16a34a',
                    color: '#fff',
                    fontWeight: 600,
                    fontSize: '13px',
                    cursor: 'pointer',
                  }}
                >
                  Open All Links
                </button>
              </div>

              <button
                type="button"
                onClick={() => { setShowCart(false); setShowCheckout(false); }}
                style={{
                  marginTop: '8px',
                  width: '100%',
                  padding: '8px',
                  borderRadius: '8px',
                  border: '1px solid #374151',
                  background: 'none',
                  color: '#9ca3af',
                  fontSize: '12px',
                  cursor: 'pointer',
                }}
              >
                Continue Shopping
              </button>
            </section>
          )}
        </main>

        <section
          style={{
            borderTop: '1px solid #374151',
            padding: '10px 12px',
            background: '#0a1020',
            flexShrink: 0,
          }}
        >
          <div style={{ fontSize: '12px', color: '#9ca3af', marginBottom: '6px' }}>Thinking & Research</div>
          <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '12px', marginBottom: '8px', color: '#cbd5e1' }}>
            <input
              type="checkbox"
              checked={liveVisitEnabled}
              onChange={(e) => setLiveVisitEnabled(e.target.checked)}
            />
            Show live page visits in popup while researching
          </label>
          <div
            ref={thinkingBoxRef}
            style={{
              background: '#111827',
              border: '1px solid #374151',
              borderRadius: '8px',
              padding: '8px',
              fontSize: '12px',
              color: '#d1d5db',
              lineHeight: 1.5,
              maxHeight: '130px',
              overflowY: 'auto',
              overflowX: 'hidden',
            }}
          >
            <div>
              <strong>Status:</strong>{' '}
              {isSending ? `${currentWorkStep}${'.'.repeat(thinkingTick + 1)}` : currentWorkStep}
            </div>
            <div style={{ marginTop: '6px' }}>
              {workLog.length > 0 ? workLog.join(' ') : 'No background steps yet.'}
            </div>
            <div style={{ marginTop: '8px' }}>
              <strong>Research updates:</strong>
              <div style={{ marginTop: '4px' }}>
                {researchUpdates.length > 0
                  ? researchUpdates.map((line, idx) => <div key={`${line}-${idx}`}>- {line}</div>)
                  : 'No research updates yet.'}
              </div>
            </div>
            <div style={{ marginTop: '8px' }}>
              <strong>How picks are chosen:</strong>
              <div style={{ marginTop: '4px' }}>
                <div>- Budget fit and value for money</div>
                <div>- Feature relevance to your request</div>
                <div>- Source quality and product detail completeness</div>
              </div>
            </div>
          </div>
        </section>

        <form
          onSubmit={onSend}
          style={{
            padding: '12px',
            borderTop: '1px solid #374151',
            display: 'flex',
            gap: '8px',
          }}
        >
          <input
            value={input}
            onChange={(e) => setInput(e.target.value)}
            placeholder="Ask something..."
            style={{
              flex: 1,
              background: '#0f172a',
              color: '#e5e7eb',
              border: '1px solid #374151',
              borderRadius: '8px',
              padding: '10px 12px',
              fontSize: '14px',
              outline: 'none',
            }}
          />
          <button
            type="submit"
            disabled={isSending}
            style={{
              background: isSending ? '#4b5563' : '#2563eb',
              color: '#fff',
              border: 'none',
              borderRadius: '8px',
              padding: '10px 14px',
              fontWeight: 600,
              cursor: isSending ? 'not-allowed' : 'pointer',
            }}
          >
            {isSending ? 'Sending...' : 'Send'}
          </button>
        </form>
      </div>
    </div>
  );
}
