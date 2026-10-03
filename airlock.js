// TrollBridge /airlock lane — data layer.
// Re-entry decontamination scan ("body armor" for agents): an agent submits
// inbound content it is about to ingest into its context (a fetched web page,
// a tool result, a file) and gets prompt-injection / hidden-instruction /
// encoded-payload / exfiltration patterns flagged BEFORE the content touches
// its context. Stateless pure function, NO network calls, NO dependencies.
//
// HEURISTIC SCREEN, NOT A SECURITY GUARANTEE — a determined attacker can
// encode around any pattern list. Triage, not a verdict. The module never
// echoes the scanned content back; match snippets are truncated to 120 chars.

const MAX_CONTENT_BYTES = 50 * 1024;
const MAX_SOURCE_CHARS = 200;
const SNIPPET_MAX = 120;
const NEAR_WINDOW = 200; // chars: max distance for "A near B" pair checks

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// Snippet centered on a match, whitespace-collapsed, hard-capped.
function snippet(text, idx, len) {
  const start = Math.max(0, idx - 40);
  const end = Math.min(text.length, idx + Math.max(len, 1) + 40);
  let s = text.slice(start, end).replace(/\s+/g, " ").trim();
  if (s.length > SNIPPET_MAX) s = s.slice(0, SNIPPET_MAX - 1) + "…";
  return s;
}

// All match start indexes of a global regex in text.
function allPositions(text, re) {
  const g = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
  const out = [];
  let m;
  while ((m = g.exec(text)) !== null) {
    out.push({ idx: m.index, len: m[0].length });
    if (m[0].length === 0) g.lastIndex++;
    if (out.length > 50) break;
  }
  return out;
}

// True when any A-match sits within NEAR_WINDOW chars of any B-match.
function nearHit(text, reA, reB) {
  const a = allPositions(text, reA);
  if (!a.length) return null;
  const b = allPositions(text, reB);
  if (!b.length) return null;
  for (const x of a) {
    for (const y of b) {
      if (Math.abs(x.idx - y.idx) <= NEAR_WINDOW) {
        const lo = Math.min(x.idx, y.idx);
        const hi = Math.max(x.idx + x.len, y.idx + y.len);
        return { lo, hi };
      }
    }
  }
  return null;
}

const CHECKS = [
  {
    id: "instruction-override",
    severity: "high",
    detail: "attempt to override or replace the agent's own instructions",
    patterns: [
      /ignore\s+(all\s+)?previous\s+instructions/i,
      /disregard\s+(all\s+)?prior\s+(instructions|directives)/i,
      /forget\s+(your|all)\s+(prior\s+)?instructions/i,
      /override\s+(your|all)\s+instructions/i,
      /your\s+new\s+instructions/i,
      /new\s+system\s+prompt/i,
      /developer\s+mode/i,
      /jailbreak/i,
      /\bDAN\s+mode\b/i,
    ],
  },
  {
    id: "role-reassignment",
    severity: "high",
    detail: "attempt to reassign the agent's identity or role",
    patterns: [
      /you\s+are\s+now\b/i,
      /you\s+are\s+(meta\s+ai|chatgpt|claude|grok|gemini)\b/i,
      /\bact\s+as\b/i,
      /pretend\s+(you\s+are|to\s+be)/i,
      /roleplay\s+as/i,
      /take\s+on\s+the\s+role/i,
    ],
  },
  {
    id: "delimiter-smuggling",
    severity: "high",
    detail: "chat-template delimiter smuggled into content — tries to forge a system turn",
    patterns: [
      /\[SYSTEM\]/,
      /<\|system\|>/,
      /<\|im_start\|>\s*system/,
      /<\|im_end\|>/,
      /###\s*system\s*:/i,
      /\[INST\]/,
      /^\s*system\s*:/im,
    ],
  },
  {
    id: "encoded-payload",
    severity: "medium",
    detail: "encoded blob — decode before trusting; payloads hide inside encodings",
    patterns: [
      // base64-ish run, 40+ chars, no spaces; skip http(s) URLs
      /(?<![/:])(?<![A-Za-z0-9+/=])[A-Za-z0-9+/]{40,}={0,3}(?![A-Za-z0-9+/=])/,
    ],
    extra: [
      {
        id: "encoded-payload",
        severity: "low",
        detail: "long hex run — could be an encoded payload or key material",
        re: /\b(?:[0-9a-fA-F]{2}){20,}\b/,
      },
    ],
  },
  {
    id: "exfiltration",
    severity: "high",
    detail: "exfiltration endpoint or data-theft instruction in inbound content",
    patterns: [
      /discord\.com\/api\/webhooks/i,
      /requestbin\.(com|net)/i,
      /webhook\.site/i,
      /pipedream\.net/i,
      // instruction to email/send/forward a secret somewhere — the verb plus
      // the secret noun in one breath (e.g. "email the password to …")
      /\b(e-?mail|send|forward|share|post)\b[^.\n]{0,80}\b(password|secret|api[\s_-]?key|private[\s_-]?key|mnemonic|seed\s+phrase)\b/i,
    ],
    pairs: [
      {
        a: /send\s+(it\s+|the\s+|this\s+|all\s+)?(to|via)\s+https?:/i,
        b: /password|secret|api[\s_-]?key|private[\s_-]?key|mnemonic|seed\s+phrase|wallet/i,
        label: "instruction to send sensitive data to an external URL",
      },
      {
        a: /\bPOST\b\s+(it\s+|the\s+|this\s+)?to\s+https?:/i,
        b: /password|secret|api[\s_-]?key|private[\s_-]?key|mnemonic|seed\s+phrase|wallet|token/i,
        label: "instruction to POST sensitive data to an external URL",
      },
    ],
  },
  {
    id: "authority-urgency",
    severity: "medium",
    detail: "manufactured urgency paired with a fake authority — classic social-engineering shape",
    pairs: [
      {
        a: /\burgent\b|\bimmediately\b|critical\s+security|act\s+now|account\s+suspended/i,
        b: /your\s+administrator|system\s+administrator|security\s+team|IT\s+department|help\s+desk/i,
        label: "urgency language next to an authority claim",
      },
    ],
  },
  {
    id: "indirect-injection",
    severity: "high",
    detail: "polite indirect injection — task-preemption, authority, or sequencing framing paired with a directive to the agent",
    pairs: [
      {
        a: /\bbefore you (can|do|continue|proceed|solve|complete|finish|go on)\b/i,
        b: /\bplease (send|email|e-mail|delete|create|book|cancel|share|post|forward|transfer|wire|do|click|open|run|execute)\b/i,
        label: "task-preemption framing ('before you…') paired with a polite imperative",
      },
      {
        a: /\bdo (the following|this|that) first\b|\bas a first step\b|\bbefore anything else\b|\bfirst,\s*please\b/i,
        b: /\b(send|email|e-mail|delete|create|book|cancel|share|post|forward|transfer|wire)\s+(the|this|all|a|an|my|your)\b/i,
        label: "sequencing directive ('do … first') paired with an action verb",
      },
      {
        a: /\b(important|urgent|crucial|critical)\s+(message|notice|announcement|update|alert)\b|\baction required\b|\bofficial\s+(notification|notice|announcement)\b/i,
        b: /\bto you,?\s+the\s+(AI\s+)?assistant\b|\bdear\s+(AI\s+)?assistant\b|\bthe AI assistant\b/i,
        label: "authority claim paired with direct address to the assistant",
      },
      {
        a: /\b(important|urgent|crucial|critical)\s+(message|notice|announcement|update|alert)\b/i,
        b: /\bbefore you (can|do|continue|proceed|solve|complete|finish|go on)\b/i,
        label: "authority claim paired with task-preemption framing",
      },
      {
        a: /\bto you,?\s+the\s+(AI\s+)?assistant\b|\bdear\s+(AI\s+)?assistant\b/i,
        b: /\bplease (send|email|e-mail|delete|create|book|cancel|share|post|forward|transfer|wire|do|click|open|run|execute)\b/i,
        label: "direct address to the assistant paired with a polite imperative",
      },
    ],
  },
  {
    id: "injection-marker-tag",
    severity: "medium",
    detail: "known prompt-injection marker tag — AgentDojo-style INFORMATION/IMPORTANT block delimiters wrapping a directive",
    patterns: [/<(INFORMATION|IMPORTANT)>/i],
  },
];

const SEVERITY_POINTS = { high: 25, medium: 10, low: 4 };
const MAX_FINDINGS = 25;

function runChecks(text) {
  const findings = [];
  for (const check of CHECKS) {
    if (findings.length >= MAX_FINDINGS) break;
    // direct patterns
    for (const re of check.patterns || []) {
      if (findings.length >= MAX_FINDINGS) break;
      const hits = allPositions(text, re);
      for (const h of hits.slice(0, 3)) {
        findings.push({
          check: check.id,
          severity: check.severity,
          match: snippet(text, h.idx, h.len),
          detail: check.detail,
        });
        if (findings.length >= MAX_FINDINGS) break;
      }
    }
    // extra sub-checks (different severity within the same family)
    for (const ex of check.extra || []) {
      if (findings.length >= MAX_FINDINGS) break;
      const hits = allPositions(text, ex.re);
      for (const h of hits.slice(0, 3)) {
        findings.push({
          check: ex.id,
          severity: ex.severity,
          match: snippet(text, h.idx, h.len),
          detail: ex.detail,
        });
        if (findings.length >= MAX_FINDINGS) break;
      }
    }
    // proximity pairs
    for (const p of check.pairs || []) {
      if (findings.length >= MAX_FINDINGS) break;
      const hit = nearHit(text, p.a, p.b);
      if (hit) {
        findings.push({
          check: check.id,
          severity: check.severity,
          match: snippet(text, hit.lo, hit.hi - hit.lo),
          detail: p.label,
        });
      }
    }
  }
  return findings;
}

// Signature: airlock(content, source?)
// - content: string, required, max 50KB — the inbound text to scan
// - source:  string, optional, max 200 chars — caller-supplied label (echoed back)
async function airlock(content, source) {
  if (typeof content !== "string" || !content.trim()) {
    throw badRequest("missing required param: content (usage: GET /airlock?content=<text to scan>&source=<optional label>)");
  }
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) {
    throw badRequest("content exceeds 50KB — trim and retry");
  }

  let src = "";
  if (source !== undefined && source !== null && source !== "") {
    if (typeof source !== "string") throw badRequest("source must be a string");
    src = source.slice(0, MAX_SOURCE_CHARS);
  }

  const findings = runChecks(content);
  const score = Math.min(100, findings.reduce((s, f) => s + (SEVERITY_POINTS[f.severity] || 0), 0));
  const verdict = score === 0 ? "CLEAN" : score < 40 ? "REVIEW" : "CONTAMINATED";

  const out = {
    verdict,
    score,
    findings,
    scanned_chars: content.length,
    checks_run: CHECKS.length,
    note: "heuristic screen, not a security guarantee — a determined attacker can encode around any pattern list. Triage, not a verdict.",
  };
  if (src) out.source = src; // caller label only — scanned content is never echoed
  return out;
}

module.exports = { airlock };
