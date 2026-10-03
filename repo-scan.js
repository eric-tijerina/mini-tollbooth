// TrollBridge /repo-scan lane — data layer.
// Repo-identity + bundled-.git supply-chain scan: an agent about to ingest a
// supplier-provided repo (git bundle, .git directory dump, or repo URL +
// claimed commit) gets (1) hook/binary heuristics — executable git hooks that
// fetch or execute, embedded binaries — and (2) commit-vs-repo binding —
// "does this hash belong to the claimed repo?"
//
// HEURISTIC SCREEN, NOT A SECURITY GUARANTEE — pattern lists miss novel
// tricks, and a binding check only proves the hash exists in the repo, not
// that the repo is trustworthy. Triage, not a verdict. The module never
// echoes the scanned bundle back; match snippets are truncated to 120 chars.

const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent market-intel feed)";

const MAX_BUNDLE_BYTES = 200 * 1024;
const MAX_URL_CHARS = 500;
const SNIPPET_MAX = 120;

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

// ---- tiny TTL cache (binding checks) ----
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
const bindCache = makeCache(5 * 60 * 1000);

async function getJSON(url, timeoutMs = 10000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": UA, Accept: "application/vnd.github+json" },
      signal: ctrl.signal,
    });
    return { status: res.status, body: res.status === 404 ? null : await res.json().catch(() => null) };
  } finally {
    clearTimeout(t);
  }
}

// Known git hook names — a hook file that EXISTS (non-.sample) runs on clone/checkout.
const HOOK_NAMES = [
  "applypatch-msg", "pre-applypatch", "post-applypatch", "pre-commit",
  "pre-merge-commit", "prepare-commit-msg", "commit-msg", "post-commit",
  "pre-rebase", "post-checkout", "post-merge", "pre-push", "pre-receive",
  "update", "proc-receive", "post-receive", "post-update", "reference-transaction",
  "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate",
  "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist",
  "p4-post-changelist", "p4-pre-submit",
];

// A hook path counts as LIVE only if it is not a .sample stub.
function liveHookPaths(text) {
  const out = [];
  const re = /(?:\.git\/)?hooks\/([A-Za-z0-9][\w.-]*)/gi;
  let m;
  while ((m = re.exec(text)) !== null) {
    const name = m[1];
    if (/\.sample$/i.test(name)) continue;
    if (!HOOK_NAMES.includes(name.toLowerCase())) continue;
    out.push({ name, idx: m.index, len: m[0].length });
    if (out.length > 20) break;
  }
  return out;
}

// Malicious-hook behavior patterns: fetch + execute, privilege moves, stealth.
const HOOK_MALICE = [
  { re: /\bcurl\b[^|\n]*\|\s*(sh|bash)\b/i, detail: "curl piped straight into a shell — classic remote-code-execution shape" },
  { re: /\bwget\b[^|\n]*\|\s*(sh|bash)\b/i, detail: "wget piped straight into a shell — classic remote-code-execution shape" },
  { re: /\bcurl\b[^\n]*(-o|--output)\s+[^\n]*\.(sh|ps1|bat|exe)/i, detail: "curl downloading a script/binary payload" },
  { re: /\bwget\b[^\n]*-O\s+[^\n]*\.(sh|ps1|bat|exe)/i, detail: "wget downloading a script/binary payload" },
  { re: /\bInvoke-(Expression|Mimikatz|WebRequest)\b/i, detail: "PowerShell invocation primitive in a hook" },
  { re: /powershell[^;\n]*-e(nc|ncodedcommand)\b/i, detail: "base64-encoded PowerShell command — hiding the payload" },
  { re: /\bcertutil\b[^\n]*-urlcache/i, detail: "certutil used as a downloader (living-off-the-land)" },
  { re: /\bbitsadmin\b[^\n]*\/transfer/i, detail: "bitsadmin used as a downloader (living-off-the-land)" },
  { re: /\beval\b\s*\(\s*\$\(/, detail: "eval of command substitution — executes generated code" },
  { re: /base64\s+(-d|--decode)[^|\n]*\|\s*(sh|bash)/i, detail: "base64-decoded blob piped into a shell — obfuscated payload" },
  { re: /\bchmod\s+\+x\b[^\n]*\/tmp\//i, detail: "making a /tmp payload executable" },
  { re: /\/tmp\/[^\s"']+\s*&&\s*chmod|chmod[^;\n]*&&\s*\/tmp\//i, detail: "/tmp payload armed for execution" },
  { re: /\brm\s+-rf?\s+[^\n]*\$\(0\)|\bshred\b|\bhistory\s+-c/i, detail: "self-deletion or history wiping — covering tracks" },
  { re: /\bexec\s*\(/i, detail: "exec() call in hook — process replacement" },
];

const BINARY_MAGIC = [
  { magic: Buffer.from([0x7f, 0x45, 0x4c, 0x46]), label: "ELF executable" },
  { magic: Buffer.from("MZ", "ascii"), label: "Windows PE executable (MZ header)", atZero: true },
  { magic: Buffer.from([0xcf, 0xfa, 0xed, 0xfe]), label: "Mach-O 64-bit executable" },
  { magic: Buffer.from([0xfe, 0xed, 0xfa, 0xce]), label: "Mach-O 32-bit executable" },
  { magic: Buffer.from([0xca, 0xfe, 0xba, 0xbe]), label: "Mach-O universal binary" },
];

const SUSPICIOUS_FILENAMES = /\.(exe|dll|so|dylib|ps1|bat|cmd|scr|msi|apk|dex|ko|sys)(["'\s]|$)/i;

const SEVERITY_POINTS = { high: 40, medium: 15, low: 5 };
const MAX_FINDINGS = 25;

function pushFinding(findings, check, severity, match, detail) {
  if (findings.length >= MAX_FINDINGS) return;
  findings.push({ check, severity, match: String(match).slice(0, SNIPPET_MAX), detail });
}

// Check 1: hook + binary heuristics over the bundle text/bytes.
function scanBundle(text, raw) {
  const findings = [];

  // 1a. live (non-.sample) hook paths
  for (const h of liveHookPaths(text)) {
    pushFinding(findings, "live-git-hook", "medium",
      snippet(text, h.idx, h.len),
      `executable git hook present: ${h.name} — runs automatically on clone/checkout; inspect its body`);
  }

  // 1b. malicious behavior inside hook-looking regions (scan whole text;
  // proximity to a hook path is nice-to-have, the pattern itself is the signal)
  for (const p of HOOK_MALICE) {
    for (const hit of allPositions(text, p.re).slice(0, 3)) {
      pushFinding(findings, "hook-malice", "high", snippet(text, hit.idx, hit.len), p.detail);
    }
  }

  // 1c. embedded executables by magic bytes
  for (const b of BINARY_MAGIC) {
    let idx = -1;
    let count = 0;
    while (count < 5 && (idx = raw.indexOf(b.magic, idx + 1)) !== -1) {
      if (b.atZero && idx !== 0) continue; // MZ matches everywhere; only flag at offset 0
      count++;
      pushFinding(findings, "embedded-binary", "high",
        `${b.label} at byte offset ${idx}`,
        "executable binary embedded in the bundle — inspect before trusting");
    }
  }

  // 1d. suspicious executable filenames
  for (const hit of allPositions(text, SUSPICIOUS_FILENAMES).slice(0, 5)) {
    pushFinding(findings, "suspicious-filename", "medium",
      snippet(text, hit.idx, hit.len),
      "executable-type filename inside the bundle — verify it is expected");
  }

  return findings;
}

// Check 2: does the claimed commit exist in the claimed repo?
// v1: github.com only, via the unauthenticated commits API (free, no key).
// Other hosts: honest null — we do not fake a binding we cannot check.
function parseGitHubRepo(repoUrl) {
  const m = String(repoUrl).trim().match(/^https?:\/\/(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?(?:\/.*)?$/i);
  if (!m) return null;
  return { owner: m[1], repo: m[2] };
}

async function checkBinding(repoUrl, commit) {
  const gh = parseGitHubRepo(repoUrl);
  if (!gh) {
    return {
      repo: repoUrl, commit, belongs: null,
      note: "binding check supports github.com in v1 — could not verify this host",
    };
  }
  const key = `${gh.owner}/${gh.repo}@${commit}`;
  const hit = bindCache.get(key);
  if (hit && hit.fresh) return hit.fresh;

  let out;
  try {
    const { status } = await getJSON(
      `https://api.github.com/repos/${gh.owner}/${gh.repo}/commits/${commit}`, 10000);
    if (status === 200) {
      out = { repo: repoUrl, commit, belongs: true, note: "commit exists in the claimed repo" };
    } else if (status === 404) {
      out = { repo: repoUrl, commit, belongs: false, note: "commit NOT found in the claimed repo — hash does not belong to this repo (or repo is private/nonexistent)" };
    } else if (status === 403 || status === 429) {
      out = { repo: repoUrl, commit, belongs: null, note: "GitHub rate limit hit — binding unverifiable right now, retry shortly" };
    } else {
      out = { repo: repoUrl, commit, belongs: null, note: `GitHub API returned ${status} — binding unverifiable` };
    }
  } catch (e) {
    out = { repo: repoUrl, commit, belongs: null, note: "binding lookup failed (network/timeout) — unverifiable, not a pass" };
  }
  bindCache.set(key, out);
  return out;
}

// Signature: repoScan({ bundle, bundle_b64, repo, commit })
// - bundle: string, pasted bundle / .git listing text (max 200KB)
// - bundle_b64: base64 of the above (for binary bundles)
// - repo: https repo URL; commit: 40/64-hex hash — binding check pair
// At least one scan input is required.
async function repoScan(params) {
  const { bundle, bundle_b64, repo, commit } = params || {};
  const findings = [];

  const hasBundle = typeof bundle === "string" && bundle.length > 0;
  const hasB64 = typeof bundle_b64 === "string" && bundle_b64.length > 0;
  const hasRepo = typeof repo === "string" && repo.trim().length > 0;
  const hasCommit = typeof commit === "string" && commit.trim().length > 0;

  if (!hasBundle && !hasB64 && !(hasRepo && hasCommit)) {
    throw badRequest("missing input: pass ?bundle=<pasted bundle text> or ?bundle_b64=<base64 bundle> for the hook/binary scan, and/or ?repo=<https url>&commit=<hash> for the commit-vs-repo binding check");
  }
  if ((hasRepo && !hasCommit) || (!hasRepo && hasCommit)) {
    throw badRequest("repo and commit must be passed together (?repo=<https url>&commit=<40-hex hash>)");
  }

  let scannedBytes = 0;
  let binding = null;

  if (hasBundle || hasB64) {
    let raw;
    if (hasB64) {
      let clean;
      try {
        clean = bundle_b64.replace(/\s+/g, "");
        raw = Buffer.from(clean, "base64");
      } catch {
        throw badRequest("bundle_b64 is not valid base64");
      }
      if (raw.length === 0) throw badRequest("bundle_b64 decoded to empty");
    } else {
      raw = Buffer.from(bundle, "utf8");
    }
    if (raw.length > MAX_BUNDLE_BYTES) {
      throw badRequest("bundle exceeds 200KB — trim and retry");
    }
    scannedBytes = raw.length;
    const text = raw.toString("utf8");
    findings.push(...scanBundle(text, raw));
  }

  if (hasRepo && hasCommit) {
    const repoUrl = repo.trim();
    const hash = commit.trim().toLowerCase();
    if (repoUrl.length > MAX_URL_CHARS) throw badRequest("repo URL too long");
    if (!/^https?:\/\//i.test(repoUrl)) throw badRequest("repo must be an https:// URL");
    if (!/^[0-9a-f]{40}$/.test(hash) && !/^[0-9a-f]{64}$/.test(hash)) {
      throw badRequest("commit must be a 40- or 64-char hex hash");
    }
    binding = await checkBinding(repoUrl, hash);
    if (binding.belongs === false) {
      pushFinding(findings, "binding-mismatch", "high",
        `${hash.slice(0, 12)}… not in claimed repo`,
        "claimed commit hash does NOT exist in the claimed repo — a valid hash can launder the wrong repository; treat the provenance claim as broken");
    }
  }

  const score = Math.min(100, findings.reduce((s, f) => s + (SEVERITY_POINTS[f.severity] || 0), 0));
  const verdict = score === 0 ? "CLEAN" : score < 40 ? "REVIEW" : "CONTAMINATED";

  const out = {
    verdict,
    score,
    findings,
    scanned_bytes: scannedBytes,
    checks_run: 4, // live hooks, hook malice, embedded binaries, binding
    note: "heuristic screen, not a security guarantee — pattern lists miss novel tricks, and a binding check only proves a hash exists in a repo, not that the repo is trustworthy. Triage, not a verdict.",
  };
  if (binding) out.binding = binding;
  return out;
}

module.exports = { repoScan };
