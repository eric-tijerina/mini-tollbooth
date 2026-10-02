// TrollBridge /egress-audit lane — data layer.
// Heuristic egress screen for an AI agent's outbound request logs: scans each
// logged request's body snippet for local workspace-path leaks and credential-like
// strings, checks the request's host against an optional declared-endpoint manifest,
// and flags known exfiltration-shaped endpoints (webhook.site, requestbin, etc.).
// Pure local pattern matching — NO network calls. Returns an
// EXFILTRATION_RISK / REVIEW / CLEAN verdict with per-request findings.
//
// HEURISTIC EGRESS SCREEN, NOT AN AUDIT: this only pattern-matches over the logs
// you submitted — it cannot see traffic you did not submit, decrypt TLS, or prove
// anything is safe. A CLEAN verdict means "no patterns matched", not "no exfiltration".

const MAX_LOG_BYTES = 50 * 1024;
const MAX_ENTRIES = 200;
const MAX_SNIPPET_BYTES = 5 * 1024;

// ---- request-shape heuristics ----
const PATH_LEAK_RES = [
  /\/home\//i,
  /\/workspace\//i,
  /\/root\//i,
  /\/Users\//,
  /C:\\Users/i,
  /\/etc\/passwd/i,
  /\/etc\/shadow/i,
  /~\/\.ssh/i,
  /\/.ssh\/id_/i,
];

// Secret patterns — we record only WHICH pattern matched, never the matched value.
const SECRET_PATTERNS = [
  { name: "OpenAI-style API key", re: /sk-[A-Za-z0-9]{16,}/ },
  { name: "Slack-style token", re: /xox[bap]-/ },
  { name: "GitHub-style personal access token", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "AWS-style access key ID", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: "api_key-like assignment", re: /api[_-]?key\s*[:=]\s*['"]?[\w\-\.~+/=]{8,}/i },
  { name: "private_key-like reference", re: /private[_-]?key/i },
  { name: "PEM private key header", re: /-----BEGIN (?:RSA |OPENSSH )?PRIVATE KEY-----/ },
  { name: "bearer token", re: /bearer\s+[A-Za-z0-9\-_.~+/=]{10,}/i },
  { name: "password-like assignment", re: /password\s*[:=]/i },
];

const EXFIL_HOSTS = [
  "webhook.site",
  "requestbin.com",
  "pipedream.net",
  "ngrok.io",
  "pastebin.com",
  "termbin.com",
  "transfer.sh",
  "file.io",
  "0x0.st",
  "beeceptor.com",
];

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function decodeAndParse(label, raw) {
  if (typeof raw !== "string" || !raw.trim()) {
    throw badRequest(`missing required param: ${label} (usage: GET /egress-audit?log=... — URL-encoded JSON array of {url, method, body_snippet})`);
  }
  let decoded = raw;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    throw badRequest(`${label} is not valid URL-encoded text`);
  }
  if (Buffer.byteLength(decoded, "utf8") > MAX_LOG_BYTES) {
    throw badRequest(`${label} exceeds 50KB — trim it and retry`);
  }
  try {
    return JSON.parse(decoded);
  } catch {
    throw badRequest(`${label} is not valid JSON`);
  }
}

function normalizeHost(host) {
  return String(host || "").trim().toLowerCase().replace(/\.$/, "");
}

// Manifest entries may be bare domains ("api.openai.com") or full URLs.
function normalizeManifestHost(entry) {
  const s = String(entry || "").trim();
  if (!s) return null;
  const candidates = s.includes("://") ? [s] : [`https://${s}`, s];
  for (const c of candidates) {
    try {
      const u = new URL(c);
      if (u.hostname) return normalizeHost(u.hostname);
    } catch {
      // try next
    }
  }
  // Bare domain without dots we could not parse — treat the literal as the host.
  return /^[a-z0-9][a-z0-9.\-]*[a-z0-9]$/i.test(s) ? normalizeHost(s) : null;
}

// Returns the request's host, or null when the URL cannot be parsed.
// NEVER returns the full URL — hostnames only.
function hostOf(url) {
  const s = String(url || "").trim();
  if (!s) return null;
  try {
    return normalizeHost(new URL(s).hostname);
  } catch {
    // Try to salvage a bare host:port/path without scheme.
    try {
      const h = normalizeHost(new URL(`https://${s}`).hostname);
      return h || null;
    } catch {
      return null;
    }
  }
}

function hostMatchesExfil(host) {
  return EXFIL_HOSTS.some((d) => host === d || host.endsWith(`.${d}`));
}

function isDiscordWebhook(url) {
  return /discord\.com\/api\/webhooks/i.test(String(url || ""));
}

async function egressAudit(log, manifest) {
  const entries = decodeAndParse("log", log);
  if (!Array.isArray(entries)) {
    throw badRequest("log must be a JSON array of {url, method, body_snippet} objects");
  }

  // Optional declared-endpoint manifest: { endpoints: ["api.openai.com", ...] }
  let declared = null;
  let manifestChecked = false;
  if (typeof manifest === "string" && manifest.trim()) {
    let parsed;
    try {
      parsed = JSON.parse(decodeURIComponent(manifest));
    } catch {
      throw badRequest("manifest is not valid JSON (expected {\"endpoints\": [...]} )");
    }
    if (!parsed || !Array.isArray(parsed.endpoints)) {
      throw badRequest("manifest must be a JSON object with an \"endpoints\" array");
    }
    declared = new Set(
      parsed.endpoints.map(normalizeManifestHost).filter((h) => h)
    );
    manifestChecked = true;
  }

  const capped = entries.slice(0, MAX_ENTRIES);
  const findings = [];
  const undeclaredSet = new Set();

  capped.forEach((entry, requestIndex) => {
    const e = entry && typeof entry === "object" ? entry : {};
    const host = hostOf(e.url);
    const urlHost = host || "(unparseable url)";
    let snippet = typeof e.body_snippet === "string" ? e.body_snippet : String(e.body_snippet ?? "");
    if (Buffer.byteLength(snippet, "utf8") > MAX_SNIPPET_BYTES) {
      snippet = Buffer.from(snippet, "utf8").subarray(0, MAX_SNIPPET_BYTES).toString("utf8");
    }

    // 1. Workspace-path leak
    if (PATH_LEAK_RES.some((re) => re.test(snippet))) {
      findings.push({
        type: "workspace-path-leak",
        request_index: requestIndex,
        url_host: urlHost,
        detail:
          "body snippet contains a local filesystem path pattern (e.g. /home/, /workspace/, ~/.ssh) — submitted egress logs should not carry host paths toward external endpoints",
      });
    }

    // 2. Secret pattern
    const secretHit = SECRET_PATTERNS.find(({ re }) => re.test(snippet));
    if (secretHit) {
      findings.push({
        type: "secret-exposure",
        request_index: requestIndex,
        url_host: urlHost,
        detail: `body snippet contains a credential-like string (${secretHit.name}) — value redacted; treat as leaked until proven otherwise`,
      });
    }

    // 3. Declared-vs-actual endpoint
    if (manifestChecked) {
      if (!host || !declared.has(host)) {
        findings.push({
          type: "undeclared-endpoint",
          request_index: requestIndex,
          url_host: urlHost,
          detail: host
            ? "request host is not in the declared-endpoint manifest"
            : "request URL could not be parsed, so its host could not be matched against the declared-endpoint manifest",
        });
        if (host) undeclaredSet.add(host);
      }
    }

    // 4. Exfiltration-shaped endpoint
    if ((host && hostMatchesExfil(host)) || isDiscordWebhook(e.url)) {
      findings.push({
        type: "exfil-shaped-endpoint",
        request_index: requestIndex,
        url_host: urlHost,
        detail:
          "request targets a service commonly used as an exfiltration drop (pastebin/paste-site, webhook catcher, or tunnel) — legitimate uses exist, but this pattern is worth a hard look",
      });
    }
  });

  const types = new Set(findings.map((f) => f.type));
  const verdict =
    types.has("secret-exposure") || types.has("exfil-shaped-endpoint")
      ? "EXFILTRATION_RISK"
      : types.has("workspace-path-leak") || types.has("undeclared-endpoint")
        ? "REVIEW"
        : "CLEAN";

  let note =
    "heuristic egress screen, NOT AN AUDIT — pattern matching over submitted logs; cannot see traffic you did not submit";
  if (!manifestChecked) {
    note += " — declared-endpoint check skipped (no manifest given)";
  }
  if (entries.length > MAX_ENTRIES) {
    note += ` — analyzed the first ${MAX_ENTRIES} of ${entries.length} entries`;
  }

  return {
    verdict,
    requests_analyzed: capped.length,
    findings,
    undeclared_endpoints: [...undeclaredSet],
    note,
  };
}

module.exports = { egressAudit };
