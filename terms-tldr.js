// TrollBridge /terms-tldr lane — data layer (the $0 edition).
// Terms TL;DR ($0.02): EXTRACTIVE keyword extraction (no LLM on the server).
// Fetch a terms/bounty/rules page and pull out the parts agents actually
// need: deadlines and dates, prize/reward amounts, requirements and
// eligibility, and "gotcha" phrases (arbitration, auto-renewal,
// non-refundable, perjury attestations) — each with the source snippet it
// came from so the agent can verify.
//
// KEYWORD EXTRACTION, NOT LEGAL ADVICE: regexes find candidate sentences;
// they can miss context or misfire. Read the source before acting on money.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 500 * 1024;
const MAX_PER_CAT = 10;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

async function guardUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw badRequest("url must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw badRequest("url must be http or https");
  return u.toString();
}

function stripToText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/\s+/g, " ")
    .trim();
}

async function fetchText(url) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
  let res;
  try {
    res = await fetch(url, { headers: UA, signal: ctrl.signal, redirect: "follow" });
  } catch (e) {
    clearTimeout(t);
    throw new Error(`fetch failed: ${e.message}`);
  }
  clearTimeout(t);
  if (!res.ok) throw new Error(`fetch -> HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length > MAX_BYTES) throw new Error(`page too large (${buf.length} bytes > 500KB cap)`);
  return buf.toString("utf8");
}

function sentences(text) {
  return String(text)
    .split(/(?<=[.!?])\s+(?=[A-Z0-9"“])/)
    .map((s) => s.trim())
    .filter((s) => s.length > 20 && s.length < 600);
}

function snippetAround(text, idx, len = 160) {
  const start = Math.max(0, idx - 60);
  const s = text.slice(start, idx + len).replace(/\s+/g, " ").trim();
  return (start > 0 ? "…" : "") + s.slice(0, 220) + (start + 220 < text.length ? "…" : "");
}

function uniqPush(arr, item) {
  if (arr.length >= MAX_PER_CAT) return;
  const key = item.snippet.slice(0, 80).toLowerCase();
  if (!arr.some((x) => x.snippet.slice(0, 80).toLowerCase() === key)) arr.push(item);
}

const MONTHS = "january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sep|sept|oct|nov|dec";
const DATE_RES = [
  new RegExp(`\\b(${MONTHS})\\s+\\d{1,2}(?:st|nd|rd|th)?,?\\s+\\d{4}\\b`, "gi"),
  /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/g,
  /\b\d{4}-\d{2}-\d{2}\b/g,
];
const DATE_CTX = /deadline|expir|ends?|closes?|closing|starts?|begins?|effective|opens?|last day|must .* by|before|after|through|until|from/i;
const MONEY_RE = /\$\s?\d[\d,]*(?:\.\d{2})?(?:\s?(?:million|billion|k))?/gi;
const MONEY_CTX = /prize|reward|win\b|winner|worth|payout|bonus|cash|grand|award|payment|fee|cost|price|deposit|penalt/i;
const REQ_RES = [
  /\bmust be\b/i, /\brequired\b/i, /eligib/i, /\b\d{2}\s*years?\s*of\s*age\b/i,
  /\bresident(s)?\s+of\b/i, /limit\s+\d*\s*per\b/i, /one\s*\(1\)\s*per\b/i,
  /\bneed to\b/i, /you\s+will\s+need/i, /to\s+qualify/i, /no\s+purchase\s+necessary/i,
];
const GOTCHA_RES = [
  [/arbitration/i, "arbitration clause"],
  [/class action waiver|waive.*class action/i, "class-action waiver"],
  [/auto-?renew/i, "auto-renewal"],
  [/automatically\s+renew/i, "automatic renewal"],
  [/non-?refundable/i, "non-refundable"],
  [/no\s+refunds?/i, "no refunds"],
  [/restocking fee/i, "restocking fee"],
  [/early termination fee/i, "early termination fee"],
  [/cancellation fee/i, "cancellation fee"],
  [/penalty/i, "penalty clause"],
  [/under penalty of perjury/i, "sworn under penalty of perjury"],
  [/binding/i, "binding terms"],
  [/final sale/i, "final sale"],
  [/we may (change|modify|update).*(terms|fees|price)/i, "unilateral change clause"],
  [/share.*(data|information).*third part/i, "third-party data sharing"],
];

async function termsTldr(url) {
  const target = await guardUrl(url);
  let html;
  try {
    html = await fetchText(target);
  } catch (e) {
    const err = new Error(`upstream fetch failed: ${e.message}`);
    err.upstream = true;
    throw err;
  }
  const text = stripToText(html);
  if (text.length < 100) throw badRequest("page returned almost no readable text — nothing to extract");

  const deadlines = [];
  const prizes = [];
  const requirements = [];
  const gotchas = [];

  // Dates with deadline-ish context.
  for (const re of DATE_RES) {
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(text)) !== null && deadlines.length < MAX_PER_CAT) {
      const ctx = text.slice(Math.max(0, m.index - 100), m.index + 100);
      if (DATE_CTX.test(ctx)) {
        uniqPush(deadlines, { date: m[0], snippet: snippetAround(text, m.index) });
      }
    }
  }

  // Money near prize-ish context.
  {
    const re = new RegExp(MONEY_RE.source, "gi");
    let m;
    while ((m = re.exec(text)) !== null && prizes.length < MAX_PER_CAT) {
      const ctx = text.slice(Math.max(0, m.index - 120), m.index + 120);
      if (MONEY_CTX.test(ctx)) {
        uniqPush(prizes, { amount: m[0].replace(/\s+/g, ""), snippet: snippetAround(text, m.index) });
      }
    }
  }

  // Requirement sentences.
  for (const s of sentences(text)) {
    if (requirements.length >= MAX_PER_CAT) break;
    if (REQ_RES.some((re) => re.test(s))) {
      uniqPush(requirements, { snippet: s.slice(0, 220) });
    }
  }

  // Gotcha phrases.
  for (const s of sentences(text)) {
    if (gotchas.length >= MAX_PER_CAT) break;
    for (const [re, label] of GOTCHA_RES) {
      if (re.test(s)) {
        uniqPush(gotchas, { flag: label, snippet: s.slice(0, 220) });
        break;
      }
    }
  }

  const summaryBits = [];
  if (deadlines.length) summaryBits.push(`${deadlines.length} date${deadlines.length === 1 ? "" : "s"} that look like deadlines`);
  if (prizes.length) summaryBits.push(`${prizes.length} money amount${prizes.length === 1 ? "" : "s"} near prize/fee language`);
  if (requirements.length) summaryBits.push(`${requirements.length} requirement/eligibility sentence${requirements.length === 1 ? "" : "s"}`);
  if (gotchas.length) summaryBits.push(`${gotchas.length} gotcha flag${gotchas.length === 1 ? "" : "s"}`);
  const summary = summaryBits.length
    ? `Extracted from ${text.length.toLocaleString()} chars of page text: ${summaryBits.join(", ")}. Keyword extraction, not legal advice — verify against the source.`
    : "No deadlines, prizes, requirements, or gotcha phrases matched — the page may use unusual wording. Keyword extraction only.";

  return {
    lane: "/terms-tldr",
    url: target,
    extracted_at: new Date().toISOString(),
    text_length: text.length,
    deadlines,
    prizes,
    requirements,
    gotchas,
    summary,
    disclaimer: "Keyword extraction, not legal advice: regexes find candidate sentences and can miss context or misfire. Read the source page before acting on money, signing, or attesting to anything.",
  };
}

module.exports = { termsTldr };
