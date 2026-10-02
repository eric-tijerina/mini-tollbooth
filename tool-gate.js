// TrollBridge /tool-gate lane — data layer.
// Policy DECISION API for agent tool calls: given the tool name an agent wants
// to call, its args, and a caller-supplied policy, returns ALLOW / DENY /
// MODIFY (rewritten args) / ASK (human confirmation). Stateless pure function,
// NO network calls, NO dependencies.
//
// HEURISTIC POLICY DECISION, NOT A SECURITY GUARANTEE — the caller owns the
// policy quality. Deny patterns are substring/regex matches, secret stripping
// is pattern-based, and a determined caller can encode around any heuristic.
// This is a policy gate for honest agents, not a sandbox.

const MAX_TOOL_CHARS = 200;
const MAX_ARGS_BYTES = 20 * 1024;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function isPlainObject(v) {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

// Try a JSON parse of the value, falling back to parsing it raw — the lane
// layer may hand us a still-URL-encoded string or an already-decoded one.
function parseJsonField(name, s) {
  if (typeof s !== "string") throw badRequest(`${name} must be a URL-encoded-JSON string`);
  const candidates = [];
  try {
    candidates.push(decodeURIComponent(s));
  } catch (_) {
    // not percent-encoded — parse raw below
  }
  candidates.push(s);
  let lastErr = null;
  for (const c of candidates) {
    try {
      return JSON.parse(c);
    } catch (e) {
      lastErr = e;
    }
  }
  throw badRequest(`${name} must parse as JSON (${lastErr ? lastErr.message : "parse failed"})`);
}

// A policy pattern is either a regex (tried first, case-insensitive) or a
// case-insensitive substring when the regex fails to compile.
function matchesPattern(toolName, pattern) {
  const s = String(pattern);
  try {
    return new RegExp(s, "i").test(toolName);
  } catch (_) {
    return toolName.toLowerCase().includes(s.toLowerCase());
  }
}

function deepClone(v) {
  return JSON.parse(JSON.stringify(v));
}

// Walk an object/array tree; fn(key, value, parent, keyInParent) may return
// { replace: newValue } to mutate the container in place.
function walk(node, fn) {
  if (Array.isArray(node)) {
    for (let i = 0; i < node.length; i++) {
      const r = fn(null, node[i], node, i);
      if (r && r.replace !== undefined) node[i] = r.replace;
      walk(node[i], fn);
    }
    return;
  }
  if (isPlainObject(node)) {
    for (const k of Object.keys(node)) {
      const r = fn(k, node[k], node, k);
      if (r && r.replace !== undefined) node[k] = r.replace;
      walk(node[k], fn);
    }
  }
}

const AMOUNT_KEY_RE = /amount|value|quantity|sum|total|price/i;
const RECIPIENT_KEY_RE = /recipient/i;

const SECRET_VALUE_RES = [
  /\bsk-[A-Za-z0-9]{16,}/,
  /\bxox[bap]-[A-Za-z0-9-]{10,}/,
  /\bghp_[A-Za-z0-9]{20,}/,
  /\bAKIA[0-9A-Z]{16}/,
  /-----BEGIN[^-]*PRIVATE KEY-----/,
  /password\s*[:=]/i,
];

function looksLikeSecret(str) {
  return SECRET_VALUE_RES.some((re) => re.test(str));
}

// Signature: toolGate(tool, args, policy)
// - tool:   string, required, the tool/function name the agent wants to call
// - args:   URL-encoded-JSON STRING of the args object, required
// - policy: URL-encoded-JSON STRING, optional. Shape:
//   { allow: [...], deny: [...], arg_constraints: { max_amount_usd, max_recipients },
//     secret_strip: bool, unknown: "deny"|"allow"|"ask" }
async function toolGate(tool, args, policy) {
  // ---- validate ----
  if (typeof tool !== "string" || !tool.trim()) {
    throw badRequest("missing required param: tool (usage: GET /tool-gate?tool=...&args=...)");
  }
  if (tool.length > MAX_TOOL_CHARS) {
    throw badRequest("tool name exceeds 200 chars");
  }
  const toolName = tool.trim();

  if (typeof args !== "string" || !args) {
    throw badRequest("missing required param: args (URL-encoded-JSON string of the args object)");
  }
  if (Buffer.byteLength(args, "utf8") > MAX_ARGS_BYTES) {
    throw badRequest("args exceed 20KB — trim and retry");
  }
  const argsObj = parseJsonField("args", args);
  if (!isPlainObject(argsObj)) {
    throw badRequest("args must parse to a plain JSON object");
  }

  let policyObj = {};
  if (policy !== undefined && policy !== null && policy !== "") {
    policyObj = parseJsonField("policy", policy);
    if (!isPlainObject(policyObj)) {
      throw badRequest("policy must parse to a plain JSON object");
    }
  }
  const allow = Array.isArray(policyObj.allow) ? policyObj.allow : [];
  const deny = Array.isArray(policyObj.deny) ? policyObj.deny : [];
  const constraints = isPlainObject(policyObj.arg_constraints) ? policyObj.arg_constraints : {};
  const maxAmount = typeof constraints.max_amount_usd === "number" && constraints.max_amount_usd >= 0
    ? constraints.max_amount_usd
    : Infinity;
  const maxRecipients = typeof constraints.max_recipients === "number" && constraints.max_recipients >= 0
    ? constraints.max_recipients
    : Infinity;
  const secretStrip = policyObj.secret_strip === undefined ? true : policyObj.secret_strip === true;
  const unknown = policyObj.unknown === undefined ? "deny" : String(policyObj.unknown);
  if (!["deny", "allow", "ask"].includes(unknown)) {
    throw badRequest('policy.unknown must be one of "deny", "allow", "ask"');
  }

  const reasons = [];
  let rulesApplied = 0;
  const decidedAt = new Date().toISOString();

  const base = () => ({
    decision: null,
    tool: toolName,
    reasons,
    audit: {
      decided_at: decidedAt,
      policy_rules_applied: rulesApplied,
      args_keys: Object.keys(argsObj), // keys only — values never echoed
    },
    note: "heuristic policy decision, not a security guarantee — policy quality is the caller's responsibility",
  });

  // ---- 1. deny list wins over everything ----
  if (deny.length > 0) rulesApplied += 1;
  const denyHit = deny.find((p) => matchesPattern(toolName, p));
  if (denyHit !== undefined) {
    const out = base();
    out.decision = "DENY";
    out.reasons.push({ rule: "deny_list", detail: `tool matches deny pattern '${String(denyHit)}'` });
    out.audit.policy_rules_applied = rulesApplied;
    return out;
  }

  // ---- 2. allow list / unknown-tool policy ----
  if (allow.length > 0) rulesApplied += 1;
  const allowHit = allow.find((p) => matchesPattern(toolName, p));
  let allowMatched = allowHit !== undefined;
  if (!allowMatched) {
    rulesApplied += 1; // unknown-tool rule evaluated
    if (unknown === "deny") {
      const out = base();
      out.decision = "DENY";
      out.reasons.push({ rule: "unknown_tool", detail: "tool not on allowlist (unknown policy: deny)" });
      out.audit.policy_rules_applied = rulesApplied;
      return out;
    }
    if (unknown === "ask") {
      const out = base();
      out.decision = "ASK";
      out.reasons.push({ rule: "unknown_tool", detail: "tool not on allowlist — human confirmation required (unknown policy: ask)" });
      out.audit.policy_rules_applied = rulesApplied;
      return out;
    }
    // unknown === "allow": continue to constraint checks
  }

  // ---- 3+4. constraint checks on a working copy (MODIFY reasons stack) ----
  const rewritten = deepClone(argsObj);
  let modified = false;

  if (Number.isFinite(maxAmount)) rulesApplied += 1;
  if (Number.isFinite(maxRecipients)) rulesApplied += 1;
  if (secretStrip) rulesApplied += 1;

  if (Number.isFinite(maxAmount)) {
    walk(rewritten, (key, value) => {
      if (typeof key === "string" && AMOUNT_KEY_RE.test(key) && typeof value === "number" && value > maxAmount) {
        modified = true;
        return { replace: maxAmount };
      }
      return undefined;
    });
    if (modified) {
      reasons.push({
        rule: "amount_cap",
        detail: `amount capped to policy max (max_amount_usd=${maxAmount})`,
      });
    }
  }

  if (Number.isFinite(maxRecipients)) {
    let truncated = false;
    walk(rewritten, (key, value) => {
      if (typeof key === "string" && RECIPIENT_KEY_RE.test(key) && Array.isArray(value) && value.length > maxRecipients) {
        truncated = true;
        return { replace: value.slice(0, maxRecipients) };
      }
      return undefined;
    });
    if (truncated) {
      modified = true;
      reasons.push({
        rule: "recipient_cap",
        detail: `recipients truncated to max_recipients=${maxRecipients}`,
      });
    }
  }

  if (secretStrip) {
    let redacted = false;
    walk(rewritten, (key, value) => {
      if (typeof value === "string" && looksLikeSecret(value)) {
        redacted = true;
        return { replace: "[REDACTED]" }; // secret value NEVER echoed in reasons
      }
      return undefined;
    });
    if (redacted) {
      modified = true;
      reasons.push({
        rule: "secret_strip",
        detail: "credential-like value redacted from args",
      });
    }
  }

  // ---- 5. final verdict ----
  const out = base();
  out.audit.policy_rules_applied = rulesApplied;
  if (modified) {
    out.decision = "MODIFY";
    out.rewritten_args = rewritten;
  } else {
    out.decision = "ALLOW";
    if (allowMatched) {
      out.reasons.push({ rule: "allow_list", detail: `tool matches allow pattern '${String(allowHit)}'` });
    } else if (unknown === "allow") {
      out.reasons.push({ rule: "unknown_tool", detail: "tool not on allowlist, permitted by unknown policy: allow" });
    }
  }
  return out;
}

module.exports = { toolGate };
