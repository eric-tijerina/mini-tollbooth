// TrollBridge /site-watch lane — data layer (the $0 edition).
// Stateless change detection ($0.05): fetch a URL, normalize the text,
// return its sha256. Pass back ?prev_hash= on the next call to learn whether
// anything changed; pass ?prev_text= (or ?prev_text_b64=) as well and get a
// compact line diff. The bridge stores nothing — the agent keeps the hash,
// which is what makes the lane stateless and the toll honest.
//
// Guards: http/https only, 15s fetch timeout, 500KB body cap, private-IP
// and localhost targets refused (SSRF hygiene).
const crypto = require("crypto");
const dns = require("dns").promises;

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const FETCH_TIMEOUT_MS = 15000;
const MAX_BYTES = 500 * 1024;
const DIFF_MAX_LINES = 40;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function isPrivateIp(ip) {
  if (!ip) return true;
  if (ip === "::1" || ip === "::ffff:127.0.0.1") return true;
  const v4 = ip.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 10) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 0) return true;
  }
  const low = ip.toLowerCase();
  if (low.startsWith("fc") || low.startsWith("fd") || low === "::") return true;
  if (/^fe80:/i.test(ip)) return true;
  return false;
}

async function guardUrl(raw) {
  let u;
  try {
    u = new URL(String(raw || "").trim());
  } catch {
    throw badRequest("url must be a valid http(s) URL");
  }
  if (!["http:", "https:"].includes(u.protocol)) throw badRequest("url must be http or https");
  const host = u.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".localhost") || host === "[::1]") {
    throw badRequest("url target not allowed");
  }
  try {
    const addrs = await dns.lookup(host, { all: true });
    for (const a of addrs) {
      if (isPrivateIp(a.address)) throw badRequest("url target not allowed");
    }
  } catch (e) {
    if (e.statusCode === 400) throw e;
    throw badRequest("could not resolve url hostname");
  }
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
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  if (ct && !/text|html|json|xml|rss/.test(ct)) throw new Error(`unsupported content-type: ${ct.split(";")[0]}`);
  return buf.toString("utf8");
}

// Simple line diff: lines in current not present in previous, and vice versa.
function lineDiff(prevText, curText) {
  const prev = new Set(String(prevText).split("\n").map((l) => l.trim()).filter(Boolean));
  const curLines = String(curText).split("\n").map((l) => l.trim()).filter(Boolean);
  const cur = new Set(curLines);
  const added = curLines.filter((l) => !prev.has(l));
  const prevLines = String(prevText).split("\n").map((l) => l.trim()).filter(Boolean);
  const removed = prevLines.filter((l) => !cur.has(l));
  return {
    added: added.slice(0, DIFF_MAX_LINES),
    removed: removed.slice(0, DIFF_MAX_LINES),
    added_truncated: added.length > DIFF_MAX_LINES,
    removed_truncated: removed.length > DIFF_MAX_LINES,
  };
}

async function siteWatch(url, prevHash, prevText, prevTextB64) {
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
  const hash = crypto.createHash("sha256").update(text, "utf8").digest("hex");

  const prev = (prevHash || "").trim().toLowerCase();
  let changed = null;
  let diff = null;
  let note = "Store `hash` and pass it back as ?prev_hash= next time to detect changes.";
  if (prev) {
    if (!/^[0-9a-f]{64}$/.test(prev)) throw badRequest("prev_hash must be a 64-char hex sha256");
    changed = prev !== hash;
    if (!changed) {
      note = "No change since the previous check (hash matches).";
    } else {
      let prevT = null;
      if (prevTextB64) {
        try {
          prevT = Buffer.from(String(prevTextB64), "base64").toString("utf8");
        } catch {
          throw badRequest("prev_text_b64 must be valid base64");
        }
      } else if (prevText) {
        prevT = stripToText(String(prevText));
      }
      if (prevT) {
        diff = lineDiff(prevT, text);
        note = `Changed since the previous check — diff of first ${DIFF_MAX_LINES} changed lines included.`;
      } else {
        note = "Changed since the previous check. Pass ?prev_text= (or ?prev_text_b64=) with the previous page text to get a diff snippet.";
      }
    }
  }

  return {
    lane: "/site-watch",
    url: target,
    fetched_at: new Date().toISOString(),
    hash,
    prev_hash: prev || null,
    changed,
    diff,
    text_length: text.length,
    snippet: text.slice(0, 500),
    note,
  };
}

module.exports = { siteWatch };
