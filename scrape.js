// TrollBridge /scrape lane — data layer.
// Fetches a public web page and returns clean readable text plus absolute
// links (page→markdown for agents, no subscription). Optional crawl=1 walks
// same-origin links for up to maxPages pages.
//
// HEURISTIC EXTRACTION, NOT A RENDERER: regex-based HTML stripping, not a
// headless browser — JS-rendered content and PDFs are out of reach. Fetches
// public http(s) URLs only; localhost/private hosts are blocked.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const MAX_FETCH_BYTES = 500 * 1024;
const MAX_TEXT_CHARS = 50000;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- tiny TTL cache ----
function makeCache(ttlMs, max = 200) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) return { stale: e.v };
      return { fresh: e.v };
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const scrapeCache = makeCache(5 * 60 * 1000);

// ---- SSRF guard (same as /scam-scan): public http(s) hosts only ----
function assertSafeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw badRequest("url must be a valid http(s):// address");
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest("url must be http(s)://");
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") ||
    /^127\./.test(host) || host === "::1" ||
    /^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw badRequest("url must be a public address");
  }
  return u.toString();
}

// ---- HTML → clean text ----
function extractTitle(html) {
  const m = /<title[^>]*>([\s\S]*?)<\/title>/i.exec(html);
  return m ? decodeEntities(m[1]).replace(/\s+/g, " ").trim().slice(0, 300) : "";
}

function extractLinks(html, baseUrl, limit = 50) {
  const links = [];
  const seen = new Set();
  const re = /<a[^>]+href\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>]+))/gi;
  let m;
  while ((m = re.exec(html)) !== null && links.length < limit) {
    const raw = (m[1] || m[2] || m[3] || "").trim();
    if (!raw || raw.startsWith("#") || /^(javascript|mailto|tel|data):/i.test(raw)) continue;
    let abs;
    try {
      abs = new URL(raw, baseUrl).toString();
    } catch { continue; }
    if (!/^https?:\/\//i.test(abs)) continue;
    const key = abs.split("#")[0];
    if (seen.has(key)) continue;
    seen.add(key);
    links.push(key);
  }
  return links;
}

function decodeEntities(s) {
  return s
    .replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"').replace(/&#39;/g, "'");
}

function extractText(html) {
  let s = html;
  s = s.replace(/<!--[\s\S]*?-->/g, " ");
  s = s.replace(/<script[\s\S]*?<\/script>/gi, " ");
  s = s.replace(/<style[\s\S]*?<\/style>/gi, " ");
  s = s.replace(/<noscript[\s\S]*?<\/noscript>/gi, " ");
  s = s.replace(/<(nav|header|footer|aside)[\s\S]*?<\/\1>/gi, " ");
  s = s.replace(/<[^>]+>/g, " ");
  s = decodeEntities(s);
  return s.replace(/\s+/g, " ").trim().slice(0, MAX_TEXT_CHARS);
}

async function fetchHtml(url, timeoutMs = 10000) {
  const safe = assertSafeUrl(url);
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(safe, { headers: UA, signal: ctrl.signal, redirect: "follow" });
    if (!res.ok) {
      if (res.status < 500) throw badRequest(`GET ${safe} -> HTTP ${res.status}`);
      throw new Error(`GET ${safe} -> HTTP ${res.status}`);
    }
    // Redirects are followed by fetch — re-check the landing host.
    assertSafeUrl(res.url);
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (ct && !/text\/(html|plain)|application\/xhtml/i.test(ct)) {
      throw badRequest(`url did not return an HTML page (content-type: ${ct.split(";")[0] || "unknown"})`);
    }
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES)
      throw badRequest(`page too large (${buf.length} bytes, cap ${MAX_FETCH_BYTES})`);
    return { html: buf.toString("utf8"), finalUrl: res.url };
  } finally {
    clearTimeout(t);
  }
}

function wordCount(text) {
  if (!text) return 0;
  return text.split(/\s+/).length;
}

async function scrapeOne(url) {
  const { html, finalUrl } = await fetchHtml(url);
  const title = extractTitle(html);
  const text = extractText(html);
  const links = extractLinks(html, finalUrl);
  if (text.length < 50)
    throw badRequest("page returned almost no readable text — is the URL an article or content page?");
  return { url: finalUrl, title, text, links, word_count: wordCount(text) };
}

function sameOrigin(a, b) {
  try {
    const ua = new URL(a), ub = new URL(b);
    return ua.protocol === ub.protocol && ua.host === ub.host;
  } catch { return false; }
}

async function scrapePage(rawUrl, opts = {}) {
  if (!rawUrl || typeof rawUrl !== "string" || !rawUrl.trim())
    throw badRequest("missing required param: url (usage: GET /scrape?url=...)");
  const url = rawUrl.trim();

  const crawl = String(opts.crawl || "") === "1";
  let maxPages = parseInt(opts.maxPages, 10);
  if (!isFinite(maxPages) || maxPages < 1) maxPages = 3;
  if (maxPages > 10) maxPages = 10;

  const cacheKey = `${url}|crawl=${crawl ? 1 : 0}|max=${crawl ? maxPages : 0}`;
  const cached = scrapeCache.get(cacheKey);
  if (cached && cached.fresh) return cached.fresh;

  const first = await scrapeOne(url);

  const result = {
    lane: "/scrape",
    url: first.url,
    fetched_at: new Date().toISOString(),
    title: first.title,
    text: first.text,
    links: first.links,
    word_count: first.word_count,
  };

  if (crawl) {
    const pages = [{ url: first.url, title: first.title, text_snippet: first.text.slice(0, 500) }];
    const seen = new Set([first.url.split("#")[0]]);
    const queue = first.links.filter((l) => sameOrigin(l, first.url) && !seen.has(l.split("#")[0]));
    while (pages.length < maxPages && queue.length) {
      const next = queue.shift();
      const key = next.split("#")[0];
      if (seen.has(key)) continue;
      seen.add(key);
      try {
        const p = await scrapeOne(next);
        pages.push({ url: p.url, title: p.title, text_snippet: p.text.slice(0, 500) });
        if (pages.length < maxPages) {
          for (const l of p.links) {
            const lk = l.split("#")[0];
            if (sameOrigin(l, first.url) && !seen.has(lk)) queue.push(l);
          }
        }
      } catch {
        // Skip pages that fail (404, blocked, non-HTML) and keep crawling.
      }
    }
    result.pages = pages;
    result.pages_fetched = pages.length;
  }

  scrapeCache.set(cacheKey, result);
  return result;
}

module.exports = { scrapePage };
