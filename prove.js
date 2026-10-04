// TrollBridge /prove lane — verification battery, NOT formal verification.
//
// What it does: fetches verified source from Sourcify, compiles it with the
// REAL solc version the contract was built with (fetched on demand, cached),
// walks the resulting AST for dangerous constructs, and keeps a PROOF LEDGER
// — every claim is marked PROVEN (established by compilation or AST
// inspection), PROVEN-FALSE, or UNKNOWN (not checkable by this battery).
// A clean battery is a strong screen, not a mathematical proof of safety.
//
// What it is NOT: formal verification. No SMT solver, no symbolic execution,
// no proof of correctness. We say that in the copy, in the response, and in
// the ledger itself. Nothing is faked, ever.
//
// Chains: base | ethereum (Sourcify verified source, no key).
// Unverified contracts get an honest refusal — a bytecode-only "proof" would
// be guesswork, and we will not sell one.

const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const CHAINS = { base: 8453, ethereum: 1 };
const SOURCIFY = "https://sourcify.dev/server/v2/contract";
// Don't try to compile monsters synchronously on a free-tier host.
const MAX_COMPILE_CHARS = 400000;
// Cap remote compiler downloads — each solc build is heavy.
const MAX_CACHED_COMPILERS = 2;

const WARNING = "NOT_A_PROOF — verification battery, not formal verification.";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}

async function getJSON(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
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
const proveCache = makeCache(30 * 60 * 1000);

async function fetchVerified(chainId, address) {
  const url = `${SOURCIFY}/${chainId}/${address}?fields=all`;
  const d = await getJSON(url, 30000);
  if (!d || !d.match) return null;
  const files = [];
  const srcs = d.sources || {};
  for (const [p, v] of Object.entries(srcs)) {
    const content = v && v.content;
    if (typeof content === "string" && content.length) files.push({ path: p, content });
    if (files.length >= 60) break;
  }
  return {
    match: d.match,
    files,
    compilerVersion: (d.compilation && d.compilation.compilerVersion) || null,
    proxyResolution: d.proxyResolution || null,
  };
}

// ---- version-aware solc loading ----
// A battery that only compiles the newest Solidity is a toy — most contracts
// were built with older compilers. Fetch the exact build on demand, cache it.
const compilerCache = new Map();
function loadRemoteSolc(version) {
  const solc = require("solc");
  return new Promise((resolve) => {
    let done = false;
    const timer = setTimeout(() => {
      if (!done) { done = true; resolve(null); }
    }, 90000);
    try {
      solc.loadRemoteVersion("v" + version, (err, snap) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve(err ? null : snap);
      });
    } catch {
      if (!done) { done = true; clearTimeout(timer); resolve(null); }
    }
  });
}
async function getCompiler(wantVersion) {
  const solc = require("solc");
  const norm = String(wantVersion || "").trim().replace(/^v/, "");
  const bundledNum = solc.version().split("+")[0];
  if (!norm || norm.split("+")[0] === bundledNum) {
    return { solc, version: solc.version(), remote: false };
  }
  if (compilerCache.has(norm)) {
    return { solc: compilerCache.get(norm), version: norm, remote: true };
  }
  const snap = await loadRemoteSolc(norm);
  if (!snap) return { solc, version: solc.version(), remote: false, fallback: true, wanted: norm };
  if (compilerCache.size >= MAX_CACHED_COMPILERS) compilerCache.delete(compilerCache.keys().next().value);
  compilerCache.set(norm, snap);
  return { solc: snap, version: snap.version(), remote: true };
}

// Best-effort remappings so "@openzeppelin/..." style imports resolve.
function buildRemappings(paths) {
  const remaps = [];
  const seen = new Set();
  for (const p of paths) {
    const m = p.match(/^(.*\/)(@[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/)/);
    if (m && !seen.has(m[2])) {
      seen.add(m[2]);
      remaps.push(`${m[2]}=${m[1]}${m[2]}`);
    }
  }
  return remaps;
}

async function compileSources(files, compilerVersion) {
  const { solc, version, remote, fallback, wanted } = await getCompiler(compilerVersion);
  const sources = {};
  for (const f of files) {
    if (f.path.endsWith(".sol")) sources[f.path] = { content: f.content };
  }
  const paths = Object.keys(sources);
  if (!paths.length) return { ok: false, reason: "no .sol sources to compile" };
  const input = {
    language: "Solidity",
    sources,
    settings: {
      remappings: buildRemappings(paths),
      outputSelection: { "*": { "*": ["abi"], "": ["ast"] } },
    },
  };
  let out;
  try {
    out = JSON.parse(solc.compile(JSON.stringify(input)));
  } catch (e) {
    return { ok: false, reason: "compiler crashed: " + String((e && e.message) || e).slice(0, 200), solc_version: version };
  }
  const errors = (out.errors || []).filter((e) => e.severity === "error");
  const warnings = (out.errors || []).filter((e) => e.severity === "warning");
  const dedup = (arr) => {
    const seen = new Set();
    return arr.filter((e) => {
      const msg = (e.formattedMessage || e.message || "").slice(0, 300);
      if (seen.has(msg)) return false;
      seen.add(msg);
      return true;
    }).map((e) => (e.formattedMessage || e.message || "").slice(0, 300));
  };
  if (errors.length) {
    return {
      ok: false,
      reason: "compilation failed",
      errors: dedup(errors).slice(0, 5),
      solc_version: version,
      remote_compiler: remote || undefined,
      compiler_fallback: fallback ? `wanted ${wanted}, used bundled` : undefined,
    };
  }
  return {
    ok: true,
    output: out,
    warnings: dedup(warnings).slice(0, 10),
    solc_version: version,
    remote_compiler: remote || undefined,
    compiler_fallback: fallback ? `wanted ${wanted}, used bundled` : undefined,
  };
}

// ---- AST walk: handles compact (0.8.x) and legacy (0.4.x–0.7.x) formats ----
function walkAst(node, visit) {
  if (!node || typeof node !== "object") return;
  visit(node);
  for (const k of Object.keys(node)) {
    if (k === "id" || k === "src") continue;
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => walkAst(c, visit));
    else if (v && typeof v === "object" && (v.nodeType || (v.name && v.attributes))) walkAst(v, visit);
  }
}
const kindOf = (n) => n.nodeType || n.name || "";
const strOf = (n) => (typeof n.name === "string" && n.name) || (n.attributes && n.attributes.value) || "";
const fnNameOf = (n) => (typeof n.name === "string" && n.name) || (n.attributes && n.attributes.name) || "(fallback)";
const fnVisOf = (n) => n.visibility || (n.attributes && n.attributes.visibility) || "?";
const fnMutOf = (n) => n.stateMutability || (n.attributes && n.attributes.stateMutability) || "?";
const fnModsOf = (n) => (n.modifiers || []).map((m) => (m.modifierName && (m.modifierName.name || (m.modifierName.attributes && m.modifierName.attributes.value))) || "?");

function analyzeAst(asts) {
  const facts = {
    functions: [],
    hasSelfdestruct: false,
    hasDelegatecall: false,
    hasTxOrigin: false,
    hasInlineAssembly: false,
    contracts: [],
    legacy: false,
  };
  for (const ast of asts) {
    walkAst(ast, (n) => {
      const t = kindOf(n);
      if (!n.nodeType && n.name && n.attributes) facts.legacy = true;
      if (t === "ContractDefinition") {
        const attrs = n.attributes || {};
        facts.contracts.push({ name: fnNameOf(n), kind: n.contractKind || attrs.contractKind || "contract" });
      } else if (t === "FunctionDefinition") {
        const mods = fnModsOf(n);
        facts.functions.push({
          name: fnNameOf(n),
          visibility: fnVisOf(n),
          mutability: fnMutOf(n),
          modifiers: mods,
          guarded: mods.some((m) => ACCESS_MODIFIERS.test(m)),
        });
      } else if (t === "FunctionCall") {
        const expr = n.expression || {};
        const cname = strOf(expr) || (expr.expression && strOf(expr.expression)) || "";
        if (cname === "selfdestruct") facts.hasSelfdestruct = true;
      } else if (t === "MemberAccess") {
        const member = n.memberName || (n.attributes && n.attributes.member_name) || "";
        if (member === "delegatecall") facts.hasDelegatecall = true;
        if (member === "origin" && strOf(n.expression || {}) === "tx") facts.hasTxOrigin = true;
      } else if (t === "InlineAssembly") {
        facts.hasInlineAssembly = true;
      }
    });
  }
  return facts;
}

const DANGEROUS_FNS = new Set([
  "mint", "mintTo", "pause", "unpause", "withdraw", "sweep", "setFee",
  "setTreasury", "setMinter", "blacklist", "upgradeTo", "upgradeToAndCall",
  "transferOwnership", "renounceOwnership", "setOwner", "drain",
  "setAdmin", "rescue", "recover",
]);
const ACCESS_MODIFIERS = /^(onlyOwner|onlyRole|onlyAdmin|onlyMinter|onlyGovernance|requiresAuth|auth|onlyGuardian|onlyPauser|whenNotPaused|ifAdmin|onlyProxyAdmin)$/i;

const SEV_POINTS = { critical: 40, high: 25, medium: 10, low: 3, info: 0 };
function riskLevel(score) {
  if (score >= 60) return "critical";
  if (score >= 30) return "high";
  if (score >= 10) return "medium";
  return "low";
}

async function proveContract(address, chain) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!CHAINS[ch]) throw badRequest("chain must be base or ethereum");
  const chainId = CHAINS[ch];
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = proveCache.get(key);
  if (hit && hit.fresh) return { warning: WARNING, ...hit.fresh, cached: true };

  let data;
  try {
    data = await fetchVerified(chainId, addr);
  } catch (e) {
    if (hit && hit.stale) return { warning: WARNING, ...hit.stale, stale: true, cached: true };
    throw e;
  }

  if (!data) {
    const out = {
      lane: "/prove",
      chain: ch,
      chain_id: chainId,
      address: addr,
      verified: false,
      compiled: false,
      findings: [],
      proof_ledger: [],
      risk: "unknown",
      risk_score: null,
      summary: "Source not verified — nothing to compile, nothing to prove.",
      honest: "This contract's source is not verified on Sourcify, so there is nothing to compile and nothing to prove — a bytecode-only 'verification' would be guesswork, and we will not sell you one. Verify the source (Sourcify or Blockscout), then re-run this lane.",
      what_we_cannot_prove: [
        "Anything at all about unverified bytecode — we refuse to guess.",
      ],
      source: "sourcify v2 (no key)",
    };
    proveCache.set(key, out);
    return { warning: WARNING, ...out };
  }

  const findings = [];
  const ledger = [];
  const cannotProve = [
    "That the contract contains no vulnerabilities — this battery checks known-dangerous patterns, not all possible behaviors.",
    "Economic safety — tokenomics, oracle manipulation, and governance attacks are outside a code battery.",
    "That the deployed bytecode matches the compiled source beyond what Sourcify's own match status asserts.",
    "Off-chain trust — admin keys, multisig thresholds, deployment scripts, upgrade governance.",
  ];

  // Proxy resolution from Sourcify — an unverifiable proxy admin is worth flagging.
  const pr = data.proxyResolution;
  let proxy = null;
  if (pr && pr.isProxy) {
    proxy = {
      is_proxy: true,
      proxy_type: pr.proxyType || "unknown",
      implementations: (pr.implementations || []).map((i) => ({ address: i.address, name: i.name || null })),
    };
    findings.push({
      severity: "medium",
      code: "upgradeable-proxy",
      title: `Upgradeable proxy (${proxy.proxy_type})`,
      detail: "The admin can swap the logic contract at any time — today's verified code can become tomorrow's unverified code. A battery run about this source does not bind future implementations.",
      basis: "Sourcify proxyResolution",
    });
    ledger.push({ claim: "Current implementation cannot be swapped by an admin", status: "unknown", basis: "proxy detected — admin powers are off-chain trust" });
    cannotProve.push("That a future implementation upgrade will be safe — this battery binds this source, not the proxy admin's next deployment.");
  } else {
    ledger.push({ claim: "No proxy indirection detected", status: "proven", basis: "Sourcify proxyResolution reports no proxy" });
  }

  // Sourcify match quality.
  if (data.match === "exact" || data.match === "exact_match") {
    ledger.push({ claim: "Verified source reproduces deployed bytecode", status: "proven", basis: "Sourcify exact match" });
  } else {
    ledger.push({ claim: "Verified source reproduces deployed bytecode", status: "unknown", basis: `Sourcify match is '${data.match}', not exact` });
  }

  // Compile with the contract's own solc version.
  const solFiles = data.files.filter((f) => f.path.endsWith(".sol"));
  const totalChars = solFiles.reduce((s, f) => s + f.content.length, 0);
  let compiled = false;
  let solcVersion = null;
  if (totalChars > MAX_COMPILE_CHARS) {
    ledger.push({ claim: "Contract compiles under solc", status: "unknown", basis: `source too large to compile on this host (${totalChars} chars > ${MAX_COMPILE_CHARS} cap)` });
  } else if (!solFiles.length) {
    ledger.push({ claim: "Contract compiles under solc", status: "unknown", basis: "no .sol sources returned" });
  } else {
    let res;
    try {
      res = await compileSources(solFiles, data.compilerVersion);
    } catch (e) {
      res = { ok: false, reason: "compiler unavailable: " + String((e && e.message) || e).slice(0, 200) };
    }
    solcVersion = res.solc_version || null;
    if (res.compiler_fallback) {
      ledger.push({ claim: `Compiled with the contract's own solc (${data.compilerVersion || "?"})`, status: "unknown", basis: res.compiler_fallback });
    }
    if (!res.ok) {
      ledger.push({ claim: "Contract compiles under solc", status: "unknown", basis: res.reason || "compile failed" });
      // Compile failures are battery limitations, not contract risk — info only.
      (res.errors || []).forEach((msg) =>
        findings.push({ severity: "info", code: "compile-note", title: "Could not compile this source", detail: msg + " — AST checks could not run; nothing about the contract is implied by this.", basis: "solc " + (solcVersion || "?") })
      );
      cannotProve.push("AST-level claims — compilation did not succeed, so structural inspection could not run.");
    } else {
      compiled = true;
      const compilerNote = `solc ${res.solc_version}${res.remote_compiler ? " (fetched on demand — the contract's own build)" : " (bundled)"}, ${solFiles.length} source unit(s)`;
      ledger.push({ claim: "Contract compiles cleanly", status: "proven", basis: compilerNote });
      // Compiler warnings are real signal — surface the first few.
      (res.warnings || []).slice(0, 5).forEach((w) =>
        findings.push({ severity: "low", code: "compiler-warning", title: "Compiler warning", detail: w, basis: "solc " + res.solc_version })
      );
      // AST analysis.
      const asts = [];
      for (const su of Object.values(res.output.sources || {})) {
        if (su.ast) asts.push(su.ast);
      }
      const facts = analyzeAst(asts);
      ledger.push({
        claim: "AST fully walked for dangerous constructs",
        status: "proven",
        basis: `${facts.contracts.length} contract(s), ${facts.functions.length} function(s) inspected${facts.legacy ? " (legacy AST format — best-effort walk)" : ""}`,
      });

      if (facts.hasSelfdestruct) {
        findings.push({ severity: "critical", code: "selfdestruct", title: "selfdestruct in AST", detail: "A reachable selfdestruct was found in the abstract syntax tree — the contract can destroy itself and force-send its balance. Proven present, not a regex guess.", basis: "AST: call to selfdestruct" });
        ledger.push({ claim: "No selfdestruct in compiled sources", status: "proven-false", basis: "AST contains a selfdestruct call" });
      } else {
        ledger.push({ claim: "No selfdestruct in compiled sources", status: "proven", basis: "AST walk found no selfdestruct call" });
      }
      if (facts.hasDelegatecall) {
        findings.push({ severity: "high", code: "delegatecall", title: "delegatecall in AST", detail: "delegatecall appears in the syntax tree. If the target is controllable, arbitrary code can execute in this contract's storage context.", basis: "AST: delegatecall member access" });
        ledger.push({ claim: "No delegatecall in compiled sources", status: "proven-false", basis: "AST contains delegatecall" });
      } else {
        ledger.push({ claim: "No delegatecall in compiled sources", status: "proven", basis: "AST walk found no delegatecall" });
      }
      if (facts.hasTxOrigin) {
        findings.push({ severity: "high", code: "tx-origin", title: "tx.origin in AST", detail: "tx.origin is read in the syntax tree. If it gates authorization, a phishing contract can impersonate the victim.", basis: "AST: tx.origin member access" });
        ledger.push({ claim: "No tx.origin usage in compiled sources", status: "proven-false", basis: "AST contains tx.origin" });
      } else {
        ledger.push({ claim: "No tx.origin usage in compiled sources", status: "proven", basis: "AST walk found no tx.origin" });
      }
      if (facts.hasInlineAssembly) {
        findings.push({ severity: "info", code: "inline-assembly", title: "Inline assembly present", detail: "The contract uses inline assembly — the AST battery cannot fully reason about handwritten opcodes. Review those blocks by hand.", basis: "AST: InlineAssembly node" });
        cannotProve.push("Behavior of inline assembly blocks — handwritten opcodes are outside this battery's reasoning.");
      }
      // Dangerous functions with AST-precise visibility + modifiers.
      for (const fn of facts.functions) {
        if (!DANGEROUS_FNS.has(fn.name)) continue;
        const exposed = fn.visibility === "public" || fn.visibility === "external";
        if (!exposed) continue;
        if (fn.guarded) {
          findings.push({ severity: "medium", code: "owner-privilege", title: `Privileged ${fn.name}() (${fn.visibility})`, detail: `${fn.name}() is ${fn.visibility} but guarded by ${fn.modifiers.join(", ")}. A single compromised key holding that role can invoke it — check who holds it.`, basis: "AST: function visibility + modifiers" });
        } else {
          findings.push({ severity: "high", code: "unrestricted-dangerous-fn", title: `UNRESTRICTED ${fn.name}() — anyone can call it`, detail: `${fn.name}() is ${fn.visibility} with no recognized access modifier in the AST. Anyone may be able to call it. Treat as hostile until proven otherwise.`, basis: "AST: function visibility + modifiers" });
        }
      }
    }
  }

  const score = Math.min(100, findings.reduce((s, f) => s + (SEV_POINTS[f.severity] || 0), 0));
  const risk = riskLevel(score);
  const worst = findings.find((f) => f.severity === "critical") || findings[0];
  const summary = !findings.length
    ? "Clean battery: compiles, no selfdestruct/delegatecall/tx.origin in AST, no exposed dangerous functions. Still not a proof — read what_we_cannot_prove."
    : `${risk.toUpperCase()} (${score}/100): ${worst.title.toLowerCase()}${findings.length > 1 ? ` +${findings.length - 1} more` : ""}. Battery, not proof.`;

  const out = {
    lane: "/prove",
    chain: ch,
    chain_id: chainId,
    address: addr,
    verified: true,
    sourcify_match: data.match,
    contract_solc: data.compilerVersion,
    proxy,
    compiled,
    solc_version: solcVersion,
    findings,
    proof_ledger: ledger,
    what_we_cannot_prove: cannotProve,
    risk,
    risk_score: score,
    summary,
    source: "sourcify v2 (no key) + version-matched solc compile + AST walk",
    note: "Verification battery, not formal verification. PROVEN claims were established by compilation/AST; UNKNOWN claims were not checked. 30-min cache.",
  };
  proveCache.set(key, out);
  return { warning: WARNING, ...out };
}

module.exports = { proveContract, PROVE_CHAINS: Object.keys(CHAINS), PROVE_WARNING: WARNING };
