// TrollBridge /secret-scan lane — data layer.
// Heuristic leaked-secret sweep: fetches a URL (or takes pasted text) and
// runs pattern regexes for common credential shapes (AWS keys, GitHub
// tokens, Slack tokens, private keys, Google API keys, Stripe live keys,
// generic api_key assignments). Returns only redacted previews (first 4 +
// last 4 chars) — NEVER full secret values.
//
// HEURISTIC PATTERN SWEEP, NOT A SECURITY AUDIT: regexes catch known
// shapes, not unknown ones. A "clean" verdict does not mean no secrets are
// present — it means no known pattern matched.
const crypto = require("crypto");

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const MAX_FETCH_BYTES = 500 * 1024;
const MAX_TEXT_CHARS = 200 * 1024;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- tiny TTL cache (5 min) ----
function makeCache(ttlMs, max = 300) {
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
const cache = makeCache(5 * 60 * 1000);

// ---- SSRF guard (copied from scam-scan.js) ----
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

async function fetchRawText(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES)
      throw badRequest(`page too large (${buf.length} bytes, cap ${MAX_FETCH_BYTES})`);
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

// ---- secret patterns ----
const PATTERNS = [
  { type: "aws_access_key", re: /\bAKIA[0-9A-Z]{16}\b/g },
  { type: "github_token", re: /\b(?:ghp_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{22,})\b/g },
  { type: "slack_token", re: /\bxox[bpas]-[A-Za-z0-9-]{10,}\b/g },
  { type: "private_key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH )?PRIVATE KEY-----/g },
  { type: "google_api_key", re: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { type: "stripe_live_key", re: /\bsk_live_[A-Za-z0-9]{24,}\b/g },
  // generic: api_key/secret/token/password = "long high-entropy string"
  { type: "generic_assignment", re: /\b(api[_-]?key|secret|token|password|passwd|pwd)\b\s*[:=]\s*["']?([A-Za-z0-9_\-+/=]{32,})["']?/gi, group: 2, entropyCheck: true },
];

function looksHighEntropy(s) {
  const hasLetter = /[A-Za-z]/.test(s);
  const hasDigit = /\d/.test(s);
  const hasSymbol = /[^A-Za-z0-9]/.test(s);
  return hasLetter && (hasDigit || hasSymbol);
}

function redact(value) {
  if (value.length <= 8) return "…" ;
  return value.slice(0, 4) + "…" + value.slice(-4);
}

function sweep(content) {
  const findings = [];
  for (const p of PATTERNS) {
    p.re.lastIndex = 0;
    const seen = new Set();
    let m;
    while ((m = p.re.exec(content)) !== null) {
      let value = p.group ? m[p.group] : m[0];
      if (!value) continue;
      if (p.entropyCheck && !looksHighEntropy(value)) continue;
      if (seen.has(value)) continue;
      seen.add(value);
    }
    if (seen.size > 0) {
      const first = seen.values().next().value;
      findings.push({ type: p.type, redacted_preview: redact(first), count: seen.size });
    }
  }
  return findings;
}

async function secretScan(params) {
  const url = params && params.url != null ? String(params.url).trim() : "";
  const text = params && params.text != null ? String(params.text) : "";
  const hasUrl = url.length > 0;
  const hasText = text.length > 0;
  if ((hasUrl && hasText) || (!hasUrl && !hasText)) {
    throw badRequest('provide exactly one of: url (usage: GET /secret-scan?url=...) or text (POST body field "text")');
  }

  let source, content, cacheKey;
  if (hasUrl) {
    const safe = assertSafeUrl(url);
    source = "url";
    cacheKey = "url:" + safe;
    const cached = cache.get(cacheKey);
    if (cached && cached.fresh) return cached.fresh;
    content = await fetchRawText(safe);
  } else {
    source = "text";
    if (text.length > MAX_TEXT_CHARS)
      throw badRequest(`text too large (${text.length} chars, cap ${MAX_TEXT_CHARS})`);
    cacheKey = "text:" + crypto.createHash("sha256").update(text).digest("hex");
    const cached = cache.get(cacheKey);
    if (cached && cached.fresh) return cached.fresh;
    content = text;
  }

  const findings = sweep(content);
  const total = findings.reduce((n, f) => n + f.count, 0);
  const result = {
    lane: "/secret-scan",
    source,
    content_chars: content.length,
    scanned_at: new Date().toISOString(),
    findings,
    total_findings: total,
    verdict: total > 0 ? "exposed" : "clean",
    note: "Heuristic pattern sweep for known secret shapes — not a security audit. A clean verdict means no known pattern matched, not that no secrets exist. Rotate any exposed credential immediately; previews are redacted and full values are never stored or returned.",
  };
  cache.set(cacheKey, result);
  return result;
}

module.exports = { secretScan };
