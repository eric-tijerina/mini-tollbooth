// TrollBridge /skill-scan lane — data layer.
// Static supply-chain verdict for a skill.md / MCP manifest / package file:
// env-var reads, shell directives, network/exfil targets, obfuscation
// signals, install hooks, permission overreach — rolled into a 0-100 risk
// score with line-numbered findings.
//
// HEURISTIC SCREEN, NOT AN AUDIT: pattern matches against the file's text,
// not a security review. A clean screen does not mean the file is safe.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const MAX_FETCH_BYTES = 500 * 1024;
const MAX_TEXT_BYTES = 500 * 1024;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- tiny TTL cache ----
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
const scanCache = makeCache(60 * 60 * 1000);

async function fetchText(url, timeoutMs = 20000) {
  if (!/^https?:\/\//i.test(url)) throw badRequest("url must be http(s)://");
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES) throw badRequest(`fetched file too large (${buf.length} bytes, cap ${MAX_FETCH_BYTES})`);
    return buf.toString("utf8");
  } finally {
    clearTimeout(t);
  }
}

function lineNo(text, idx) {
  return text.slice(0, idx).split("\n").length;
}
function snippet(text, idx, len = 120) {
  const start = Math.max(0, idx - 40);
  return text.slice(start, idx + len).replace(/\s+/g, " ").trim().slice(0, 160);
}

// Domains that are ordinary infrastructure, not exfil targets.
const BENIGN_DOMAINS = [
  "github.com", "raw.githubusercontent.com", "gist.githubusercontent.com",
  "npmjs.com", "registry.npmjs.org", "unpkg.com", "jsdelivr.net", "cdn.jsdelivr.net",
  "pypi.org", "files.pythonhosted.org",
  "googleapis.com", "gstatic.com", "githubusercontent.com",
  "openai.com", "anthropic.com", "api.anthropic.com",
  "w3.org", "schema.org", "json-schema.org",
  "example.com", "localhost",
];
function domainOf(u) {
  try {
    return new URL(u).hostname.toLowerCase();
  } catch {
    return null;
  }
}
function isBenignDomain(d) {
  if (!d) return true;
  return BENIGN_DOMAINS.some((b) => d === b || d.endsWith("." + b));
}

const RULES = [
  // [code, severity, title, regex(es), detail]
  { code: "install-hook", severity: "critical", title: "Install hook script", res: [/"(postinstall|preinstall|install)"\s*:/i], detail: "package.json runs a script at install time — the classic supply-chain payload slot. Install hooks execute before you ever read the code." },
  { code: "shell-exec", severity: "high", title: "Shell command execution", res: [/\bchild_process\b/, /\bexecSync\s*\(/, /\bspawnSync\s*\(/, /\bos\.system\s*\(/, /\bsubprocess\.(run|call|Popen)\b/, /\bshell_exec\b/i], detail: "The file can run arbitrary shell commands on the host. Legitimate in build tooling, dangerous in a skill/plugin manifest." },
  { code: "eval-dynamic", severity: "high", title: "Dynamic code execution (eval/Function)", res: [/\beval\s*\(/, /\bnew\s+Function\s*\(/, /\bvm\.runIn\w*\s*\(/], detail: "eval()/new Function() executes strings as code — the standard obfuscation and payload-delivery primitive." },
  { code: "env-read", severity: "medium", title: "Environment variable access", res: [/\bprocess\.env\b/, /\bos\.environ\b/, /\bgetenv\s*\(/, /\bDeno\.env\b/, /\$\{\{\s*secrets/i, /\bprocess\.getenv\b/], detail: "Reads environment variables — where API keys and credentials live. Worth knowing exactly which vars and where they go." },
  { code: "b64-decode", severity: "medium", title: "Base64 decode primitive present", res: [/\batob\s*\(/, /\bBuffer\.from\s*\([^,]+,\s*['"]base64['"]\s*\)/, /\bbase64\.(b64decode|decodebytes)\b/], detail: "Base64 decoding is how payloads hide in plain sight. Harmless alone, suspicious next to eval or network calls." },
  { code: "auto-approve", severity: "high", title: "Auto-approve / always-allow flag", res: [/\balwaysAllow\b/i, /\bauto[_-]?approve\b/i, /\bdangerously[_-]?allow\b/i, /"bypassPermissions"\s*:\s*true/i], detail: "A flag that auto-approves tool actions — removes the human from the loop for whatever this file can do." },
  { code: "credential-pattern", severity: "low", title: "Credential-looking string", res: [/\b(api[_-]?key|secret[_-]?key|passwd|password|bearer[_-]?token)\b\s*[:=]\s*['"][^'"]{4,}['"]/i], detail: "A hardcoded credential-looking value. May be a placeholder, may be a leaked secret — either way it should not ship in a manifest." },
];

const SEV_POINTS = { critical: 40, high: 25, medium: 10, low: 3 };
function verdictFor(score) {
  if (score >= 60) return "dangerous";
  if (score >= 30) return "suspicious";
  if (score >= 10) return "caution";
  return "clean";
}

function scanText(text, source) {
  const findings = [];
  let score = 0;
  const seen = new Set();
  const add = (sev, code, title, detail, idx) => {
    const key = `${code}:${idx == null ? "x" : lineNo(text, idx)}`;
    if (seen.has(key)) return;
    seen.add(key);
    score += SEV_POINTS[sev] || 0;
    findings.push({
      severity: sev,
      code,
      title,
      detail,
      line: idx == null ? null : lineNo(text, idx),
      snippet: idx == null ? null : snippet(text, idx),
    });
  };

  // 1. Static rules
  for (const rule of RULES) {
    for (const re of rule.res) {
      const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
      let m;
      let hits = 0;
      while ((m = g.exec(text)) && hits < 5) {
        add(rule.severity, rule.code, rule.title, rule.detail, m.index);
        hits++;
      }
    }
  }

  // 2. Network targets: every URL, classified
  const urlRe = /https?:\/\/[^\s"'`<>\\]+/g;
  const externalHosts = new Map();
  let m;
  while ((m = urlRe.exec(text))) {
    const d = domainOf(m[0]);
    if (d && !isBenignDomain(d)) {
      if (!externalHosts.has(d)) externalHosts.set(d, m.index);
    }
  }
  const hasNetCall = /\b(fetch|axios|requests\.(get|post)|urllib|curl|wget|http\.request|XMLHttpRequest)\b/i.test(text);
  for (const [d, idx] of externalHosts) {
    add("medium", "external-host", `External host: ${d}`, hasNetCall ? "This file makes network calls AND references a non-infrastructure host — check what data leaves the machine." : "References a host outside common infrastructure. Verify it is expected before installing.", idx);
  }

  // 3. Obfuscation density: hex/unicode escape runs + long base64 blobs
  const escRuns = (text.match(/(\\x[0-9a-fA-F]{2}){8,}/g) || []).length + (text.match(/(\\u[0-9a-fA-F]{4}){8,}/g) || []).length;
  if (escRuns >= 3) add("high", "obfuscation-escapes", "Heavy hex/unicode escape sequences", `${escRuns} runs of 8+ escaped bytes — a common way to hide strings from greppers.`, null);
  const b64blobs = (text.match(/[A-Za-z0-9+/]{300,}={0,2}/g) || []).length;
  if (b64blobs >= 2) add("medium", "obfuscation-b64", "Long base64 blobs embedded", `${b64blobs} base64-looking blobs of 300+ chars embedded in the file. Could be assets, could be payloads.`, null);

  // 4. Combo upgrades: env read + external host, or decode + eval
  const hasEnv = findings.some((f) => f.code === "env-read");
  const hasExt = findings.some((f) => f.code === "external-host");
  const hasEval = findings.some((f) => f.code === "eval-dynamic");
  const hasB64 = findings.some((f) => f.code === "b64-decode");
  if (hasEnv && hasExt) {
    score += 25;
    findings.push({ severity: "high", code: "combo:env-exfil", title: "Env read + external host combo", detail: "The file reads environment variables AND talks to an external host — the exact shape of credential exfiltration.", line: null, snippet: null });
  }
  if (hasEval && (hasB64 || escRuns >= 3)) {
    score += 25;
    findings.push({ severity: "high", code: "combo:decode-eval", title: "Decode + eval combo", detail: "Decoding primitives combined with dynamic code execution — the standard packed-payload shape.", line: null, snippet: null });
  }

  score = Math.min(100, score);
  const verdict = verdictFor(score);
  const worst = findings.find((f) => f.severity === "critical") || findings.find((f) => f.severity === "high") || findings[0];
  const summary =
    verdict === "clean"
      ? `No supply-chain red flags (score ${score}/100): no install hooks, shell exec, env reads, or suspicious hosts detected in ${source}. Heuristic screen, not an audit.`
      : `${verdict.toUpperCase()} (score ${score}/100): ${worst ? worst.title.toLowerCase() : "multiple risk signals"}${findings.length > 1 ? ` +${findings.length - 1} more finding${findings.length > 2 ? "s" : ""}` : ""} in ${source}. Heuristic screen, not an audit.`;

  return {
    lane: "/skill-scan",
    source,
    bytes_scanned: Buffer.byteLength(text),
    verdict,
    risk_score: score,
    findings: findings.sort((a, b) => (SEV_POINTS[b.severity] || 0) - (SEV_POINTS[a.severity] || 0)),
    summary,
    disclaimer: "Heuristic screen, not an audit: static pattern matches against the file's text. A clean screen does not mean the file is safe — review anything you install.",
  };
}

async function skillScan({ url, text }) {
  const u = (url || "").trim();
  const t = text || "";
  if (!u && !t) throw badRequest("supply url= (http/https file to scan) or text= (pasted file content)");
  if (u && t) throw badRequest("supply url= OR text=, not both");
  let body, source;
  if (u) {
    const key = `url:${u.toLowerCase()}`;
    const hit = scanCache.get(key);
    if (hit && hit.fresh) return { ...hit.fresh, cached: true };
    body = await fetchText(u);
    if (Buffer.byteLength(body) > MAX_TEXT_BYTES) throw badRequest("file too large to scan");
    source = u;
    const out = { generated_at: new Date().toISOString(), cached: false, ...scanText(body, source) };
    scanCache.set(key, out);
    return out;
  }
  if (Buffer.byteLength(t, "utf8") > MAX_TEXT_BYTES) throw badRequest("text too large to scan");
  return { generated_at: new Date().toISOString(), cached: false, ...scanText(t, "pasted text") };
}

module.exports = { skillScan };
