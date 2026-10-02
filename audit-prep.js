// TrollBridge /audit-prep lane — automated pre-audit review for EVM contracts.
//
// What it does: fetches verified source from Sourcify (free, no key), runs a
// deterministic battery of real static detectors (reentrancy patterns, access
// control, tx.origin, delegatecall, selfdestruct, initializer, pragma,
// proxy/upgradeability, OpenZeppelin drift, centralization), and ships three
// ready-to-run adversarial review prompts (the "swarm") the buyer's own agent
// runs through its own model — because this lane cannot call an LLM for $0.
//
// NOT_AN_AUDIT: every response leads with that warning. This makes a human
// audit faster and cheaper; it does not replace one. Unverified contracts get
// an honest refusal, not a faked review.
const WARNING =
  "NOT_AN_AUDIT — automated pre-audit review. Makes a human audit faster/cheaper; does not replace one.";

const CHAINS = { base: 8453, ethereum: 1 };
const UA = "TrollBridge/1.0 (+https://mini-tollbooth.onrender.com; AI agent market-intel feed)";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
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
const cache = makeCache(60 * 60 * 1000);

async function getJSON(url, timeoutMs = 25000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json" }, signal: ctrl.signal });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`upstream ${res.status} for ${url}`);
    return res.json();
  } finally {
    clearTimeout(t);
  }
}
async function getText(url, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { "User-Agent": UA }, signal: ctrl.signal });
    if (!res.ok) return null;
    return res.text();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// ---- source helpers ----
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, " ")
    .replace(/(^|[^:])\/\/[^\n]*/g, "$1");
}
function lineOf(src, idx) {
  return src.slice(0, idx).split("\n").length;
}
function snippet(src, idx, len = 120) {
  const start = Math.max(0, idx - 40);
  return src.slice(start, idx + len).replace(/\s+/g, " ").trim().slice(0, 160);
}
// Extract top-level functions with bodies via brace matching.
function extractFunctions(code) {
  const out = [];
  const re = /function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)\s*([^{;]*)\{/g;
  let m;
  while ((m = re.exec(code)) !== null) {
    const name = m[1];
    const params = m[2];
    const sigTail = m[3] || "";
    const bodyStart = m.index + m[0].length;
    let depth = 1;
    let i = bodyStart;
    while (i < code.length && depth > 0) {
      if (code[i] === "{") depth++;
      else if (code[i] === "}") depth--;
      i++;
    }
    out.push({
      name,
      params,
      modifiers: sigTail,
      sigStart: m.index,
      body: code.slice(bodyStart, i - 1),
      bodyStart,
    });
    re.lastIndex = i;
  }
  return out;
}
function localNames(fn) {
  const names = new Set();
  const pm = fn.params.match(/[A-Za-z0-9_]+(?=\s*(,|$))/g) || [];
  // params look like "address to" or "uint256 amount" — take the last token per param
  for (const p of fn.params.split(",")) {
    const toks = p.trim().split(/\s+/);
    const last = toks[toks.length - 1].replace(/[^A-Za-z0-9_]/g, "");
    if (last && !/^(memory|calldata|storage|payable)$/.test(last)) names.add(last);
  }
  const decl = /\b(?:uint\d*|int\d*|bool|address|string|bytes\d*)\s+(?:memory\s+|calldata\s+|storage\s+)?([A-Za-z0-9_]+)\s*(=|;|\[)/g;
  let m;
  while ((m = decl.exec(fn.body)) !== null) names.add(m[1]);
  return names;
}

const DANGEROUS_FNS = [
  "withdraw", "sweep", "drain", "mint", "setOwner", "transferOwnership",
  "renounceOwnership", "upgradeTo", "upgradeToAndCall", "setImplementation",
  "pause", "unpause", "setFee", "setTreasury", "setMinter", "blacklist",
  "setAdmin", "grantRole", "revokeRole", "kill", "destroy", "setGuardian",
];
const ACCESS_MODIFIERS =
  /\b(onlyOwner|onlyRole|onlyAdmin|onlyProxyAdmin|ifAdmin|onlyMinter|onlyMinters|onlyBlacklister|onlyMasterMinter|onlyRescuer|onlyGuardian|onlyGovernance|requiresAuth|auth|onlyPauser|onlyFeeSetter)\b/;
const PROXY_SCAFFOLD =
  /TransparentUpgradeableProxy|ERC1967Proxy|UUPSUpgradeable|BeaconProxy|AdminUpgradeabilityProxy|UpgradeabilityProxy|_IMPLEMENTATION_SLOT/;

// ---- the deterministic battery ----
// opts.proxyScaffold: whether the whole project matches a known proxy scaffold
// (checked against combined sources, so base proxy files aren't misflagged).
function runBattery(files, opts) {
  // files: [{path, content}]
  const findings = [];
  const push = (f) => findings.push(f);
  const combined = files.map((f) => f.content).join("\n");
  const code0 = stripComments(combined);
  const inScaffold = !!(opts && opts.proxyScaffold);

  const ozImports = new Set();
  const ozRe = /import\s+(?:[^"']*from\s+)?["'](@openzeppelin\/[^"']+)["']/g;
  let om;
  while ((om = ozRe.exec(code0)) !== null) ozImports.add(om[1]);

  for (const file of files) {
    const raw = file.content;
    const code = stripComments(raw);
    const loc = (idx) => ({ file: file.path, line: lineOf(raw, idx) });

    // 1. Reentrancy: external call before a state write in the same function.
    for (const fn of extractFunctions(code)) {
      const callRe = /\.(call\s*(\{|\( )|transfer\s*\(|send\s*\()/g;
      let cm;
      const callIdx = [];
      while ((cm = callRe.exec(fn.body)) !== null) callIdx.push(cm.index);
      if (!callIdx.length) continue;
      const locals = localNames(fn);
      const assignRe = /([A-Za-z0-9_]+)(\[[^\]]*\])?\s*(\+=|-=|\*=|\/=|=)(?![=>])/g;
      let am;
      let hit = null;
      while ((am = assignRe.exec(fn.body)) !== null) {
        const target = am[1];
        if (locals.has(target)) continue;
        if (/^(require|if|for|while|return|else)$/.test(target)) continue;
        if (am.index > callIdx[0]) { hit = am; break; }
      }
      if (hit) {
        const guarded = /nonReentrant|ReentrancyGuard/.test(fn.modifiers) || /nonReentrant|ReentrancyGuard/.test(code0);
        push({
          severity: guarded ? "low" : "high",
          code: "reentrancy-pattern",
          title: guarded
            ? `External call before state write in ${fn.name}() — guarded by reentrancy protection`
            : `Possible reentrancy in ${fn.name}(): external call before state write`,
          detail: guarded
            ? `In ${fn.name}(), an external call happens before a state variable is updated, but a reentrancy guard is present — verify the guard covers every entry point, including cross-function reentrancy.`
            : `In ${fn.name}(), an external call (.call/.transfer/.send) executes before "${hit[1]}" is updated. A malicious callee can re-enter and act on stale state. Apply checks-effects-interactions or a reentrancy guard.`,
          location: loc(fn.bodyStart + hit.index),
          pattern: snippet(raw, fn.bodyStart + hit.index),
        });
      }
    }

    // 2. Access control on sensitive functions.
    for (const fn of extractFunctions(code)) {
      if (!DANGEROUS_FNS.includes(fn.name)) continue;
      // internal/private functions are not externally reachable — skip.
      if (/\b(internal|private)\b/.test(fn.modifiers)) continue;
      const sigRegion = fn.modifiers;
      const guarded = ACCESS_MODIFIERS.test(sigRegion);
      const senderCheck = /require\s*\(\s*msg\.sender\s*==|if\s*\(\s*msg\.sender\s*!?=/.test(fn.body);
      if (!guarded && !senderCheck) {
        push({
          severity: "high",
          code: "unrestricted-dangerous-fn",
          title: `UNRESTRICTED ${fn.name}() — anyone can call it`,
          detail: `${fn.name}() is a sensitive function with no access modifier and no msg.sender check in its body. Anyone on chain may be able to invoke it. Treat as hostile until proven otherwise.`,
          location: loc(fn.sigStart),
          pattern: `function ${fn.name}(`,
        });
      } else if (guarded) {
        push({
          severity: "info",
          code: "owner-privilege",
          title: `${fn.name}() is owner/role-gated`,
          detail: `${fn.name}() is restricted to a privileged role. Centralization risk lives or dies on who holds that role — see the centralization finding.`,
          location: loc(fn.sigStart),
          pattern: `function ${fn.name}(`,
        });
      }
    }

    // 3. tx.origin.
    {
      const re = /\btx\.origin\b/g;
      let m2;
      let n = 0;
      while ((m2 = re.exec(code)) !== null && n < 3) {
        n++;
        push({
          severity: "high",
          code: "tx-origin",
          title: "tx.origin used",
          detail: "tx.origin is used in this file. If it gates authorization, a phishing contract can trick the real user into calling it and pass the check as them. Use msg.sender for auth.",
          location: loc(m2.index),
          pattern: snippet(raw, m2.index),
        });
      }
    }

    // 4. delegatecall.
    {
      const re = /\bdelegatecall\s*\(/g;
      let m2;
      while ((m2 = re.exec(code)) !== null) {
        const argRegion = code.slice(m2.index, m2.index + 120);
        const userControlled = /\b(msg\.data|_data|data\[|impl|target|addr)\b/.test(argRegion);
        push({
          severity: inScaffold ? "info" : userControlled ? "high" : "medium",
          code: "delegatecall",
          title: inScaffold
            ? "delegatecall inside recognized proxy scaffold (expected)"
            : userControlled
              ? "delegatecall to a potentially controllable target"
              : "delegatecall outside a recognized proxy scaffold",
          detail: inScaffold
            ? "delegatecall appears within a known proxy pattern — expected behavior, but whoever controls the implementation controls everything."
            : "delegatecall executes another contract's code in THIS contract's storage context. If the target address is attacker-influenced, they gain full control of storage and funds.",
          location: loc(m2.index),
          pattern: snippet(raw, m2.index),
        });
        break; // one finding per file is enough
      }
    }

    // 5. selfdestruct.
    {
      const m2 = /\bselfdestruct\s*\(/.exec(code);
      if (m2) {
        push({
          severity: "high",
          code: "selfdestruct",
          title: "selfdestruct present",
          detail: "The contract can destroy itself and force-send its balance somewhere. A compromised privileged key can vaporize the contract and redirect funds in one transaction.",
          location: loc(m2.index),
          pattern: snippet(raw, m2.index),
        });
      }
    }

    // 6. Unprotected initializer.
    for (const fn of extractFunctions(code)) {
      if (!/initializer|reinitializer/.test(fn.modifiers)) continue;
      if (/^initialize$/i.test(fn.name) || /initialize/i.test(fn.name)) {
        const guarded = ACCESS_MODIFIERS.test(fn.modifiers) || /msg\.sender/.test(fn.body.slice(0, 300));
        if (!guarded) {
          push({
            severity: "high",
            code: "unprotected-initializer",
            title: "Unprotected initializer()",
            detail: "The initializer has no access control — anyone can call initialize() on the implementation contract (or a fresh proxy) and become the owner/admin. This is a classic proxy-deployment footgun.",
            location: loc(fn.sigStart),
            pattern: `function ${fn.name}(`,
          });
        }
      }
    }

    // 7. Floating pragma (per file).
    {
      const m2 = /pragma\s+solidity\s+([^;]+);/.exec(code);
      if (m2 && /(\^|>=)/.test(m2[1])) {
        push({
          severity: "low",
          code: "floating-pragma",
          title: `Floating pragma (${m2[1].trim()})`,
          detail: "The pragma allows multiple compiler versions. Different versions can produce different bytecode — pin the exact version the project audited and deployed with.",
          location: loc(m2.index),
          pattern: m2[0],
        });
      }
    }
  }

  // 8. Proxy / upgradeability (cross-file).
  const proxyHints = /_IMPLEMENTATION_SLOT|function\s+_delegate\s*\(|fallback\s*\(\s*\)\s*external/.test(code0);
  // (proxyResolution from Sourcify is handled by the caller and merged in)

  // 9b. Custom reimplementation of OZ primitives.
  const definesOwnable = /modifier\s+onlyOwner\b/.test(code0) && /address\s+(private|public|internal)?\s*_owner|address\s+public\s+owner/.test(code0);
  if (definesOwnable && ozImports.size === 0) {
    push({
      severity: "medium",
      code: "custom-access-control",
      title: "Custom access control instead of audited OpenZeppelin Ownable",
      detail: "The project rolls its own owner/modifier logic instead of importing audited OpenZeppelin contracts. Bespoke access control is where subtle auth bugs hide — diff it line-by-line against OZ Ownable.",
      location: { file: "(project-wide)", line: null },
      pattern: "modifier onlyOwner (custom)",
    });
  }
  void proxyHints;

  return { findings, ozImports: [...ozImports] };
}

// ---- OpenZeppelin master drift check (best-effort, free GitHub raw) ----
function ozRawUrl(importPath) {
  // @openzeppelin/contracts/token/ERC20/ERC20.sol -> contracts/token/ERC20/ERC20.sol
  const rel = importPath.replace(/^@openzeppelin\/contracts\//, "contracts/");
  return `https://raw.githubusercontent.com/OpenZeppelin/openzeppelin-contracts/master/${rel}`;
}
function normalize(src) {
  return stripComments(src).replace(/\s+/g, " ").trim();
}
async function ozDrift(ozImports, sources) {
  const out = { imports_found: ozImports.length, checked: 0, matching_master: 0, drifted: [] };
  const byPath = new Map(sources.map((s) => [s.path, s.content]));
  let n = 0;
  for (const imp of ozImports) {
    if (n >= 4) break;
    // find the vendored file in sources (Sourcify usually includes deps)
    const hit = [...byPath.keys()].find((p) => p === imp || p.endsWith("/" + imp.split("/").slice(2).join("/")));
    if (!hit) continue;
    n++;
    out.checked++;
    const master = await getText(ozRawUrl(imp), 8000);
    if (!master) continue;
    if (normalize(byPath.get(hit)) === normalize(master)) out.matching_master++;
    else out.drifted.push(imp);
  }
  return out;
}

// ---- the swarm: three adversarial review prompts, part of the product ----
// The lane cannot call an LLM for $0, so the buyer runs these through their
// own model with the contract source pasted in.
const SWARM_PROMPTS = [
  {
    persona: "the_attacker",
    title: "The Attacker — steal the funds",
    prompt: `You are a blackhat smart-contract exploiter. Below is the full verified source of an EVM contract. Your job: find a concrete way to steal funds or brick the contract.

Rules:
- Think like an attacker, not an auditor. Follow the money: where does value enter, and where can it exit?
- For each attack path give: (1) the exact functions/lines involved, (2) prerequisites (capital, timing, roles needed), (3) a step-by-step exploit sketch with sample calls, (4) severity and why.
- Prioritize: reentrancy (including cross-function and read-only), access-control gaps, price/oracle manipulation, flash-loan-able logic, griefing that locks funds, proxy/upgrade abuse, signature replay, unprotected initializers.
- Ignore style nits and gas golfing. If a path needs an unrealistic assumption (e.g. owner key compromise), say so and deprioritize it.
- End with a ranked list: most practical attack first. If you find nothing practical, say so plainly instead of inventing one.

Contract source:
<<<PASTE VERIFIED SOURCE HERE>>>`,
  },
  {
    persona: "the_economist",
    title: "The Economist — break the incentives",
    prompt: `You are a DeFi economist reviewing an EVM contract for incentive and market-structure breaks. Code correctness is someone else's job — yours is: can the economics be gamed?

Rules:
- Examine: price oracles (spot vs TWAP vs manipulable sources), liquidation mechanics, fee/reward math (rounding direction, precision loss, division before multiplication), share-token inflation, MEV extraction surfaces, first-depositor / donation attacks, governance and incentive misalignment, and assumptions about external protocols that may not hold under stress.
- For each issue give: the economic mechanism that breaks, a numeric example where possible, who profits and who loses, and severity.
- Ignore code style, gas golfing, and naming. Focus on "the code does what it says, but what it says is exploitable."
- End with the single most dangerous economic assumption in the system, stated in one sentence.

Contract source:
<<<PASTE VERIFIED SOURCE HERE>>>`,
  },
  {
    persona: "the_pedant",
    title: "The Pedant — every Solidity footgun",
    prompt: `You are a Solidity pedant. Below is EVM contract source. Find every language-level footgun, even ones that are probably harmless — false positives are acceptable, missed bugs are not.

Checklist — verify each item explicitly:
- Storage layout: slot collisions in upgradeable contracts, struct packing waste, uninitialized storage pointers, delegatecall context confusion.
- Inheritance: C3 linearization surprises, shadowed state variables, missing overrides, constructor-vs-initializer misuse.
- Arithmetic: unchecked blocks, precision loss in division-before-multiplication, phantom overflow in older compiler versions, rounding direction on fees and shares.
- Calls: unchecked return values, transfer/send gas-stipend assumptions, reentrancy windows, cross-function reentrancy.
- Signatures & auth: ecrecover malleability, missing nonces or deadlines, tx.origin use, approve race conditions.
- Misc: block.timestamp dependence, transaction-ordering assumptions, selfdestruct / metamorphic patterns, floating pragmas, shadowed builtins.

For each finding: file, line, what is wrong, and a minimal fix. Rank by severity. If a checklist item is clean, say so in one line rather than skipping it.

Contract source:
<<<PASTE VERIFIED SOURCE HERE>>>`,
  },
];

const HUMAN_AUDIT_CHECKLIST = [
  "Economic invariants under adversarial market conditions — not just unit tests on happy paths.",
  "Full access-control matrix: every privileged function crossed with every role that can reach it.",
  "The upgrade path: who can upgrade, is there a timelock, and what could a malicious implementation do with existing storage and approvals.",
  "Oracle dependencies: manipulation cost vs. extractable profit, staleness handling, fallback behavior.",
  "Composability: how the behavior of every external protocol touched changes the security assumptions.",
  "Invariant fuzzing of core accounting (shares, balances, fees) — properties, not examples.",
  "Off-chain trust surface: admin keys, multisig signers and thresholds, deployment scripts, upgrade governance.",
];

const SEV_POINTS = { high: 25, medium: 10, low: 3, info: 0 };
function riskOf(score) {
  if (score >= 50) return "high";
  if (score >= 20) return "medium";
  return "low";
}

async function fetchVerified(chainId, address) {
  const url = `https://sourcify.dev/server/v2/contract/${chainId}/${address}?fields=all`;
  const d = await getJSON(url, 30000);
  if (!d || !d.match) return null; // 404 or match:null → not verified
  const files = [];
  const srcs = d.sources || {};
  for (const [p, v] of Object.entries(srcs)) {
    const content = v && v.content;
    if (typeof content === "string" && content.length) files.push({ path: p, content });
    if (files.length >= 60) break;
  }
  return { match: d.match, files, compilation: d.compilation || {}, proxyResolution: d.proxyResolution || null };
}

async function auditPrep({ address, chain }) {
  const addr = (address || "").trim();
  if (!isAddress(addr)) throw badRequest("address must be a 0x… Ethereum-style address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!CHAINS[ch]) throw badRequest("chain must be base or ethereum");
  const chainId = CHAINS[ch];
  const key = `${ch}:${addr.toLowerCase()}`;
  const hit = cache.get(key);
  if (hit && hit.fresh) return { warning: WARNING, ...hit.fresh, cached: true };

  let data;
  try {
    data = await fetchVerified(chainId, addr);
  } catch (e) {
    if (hit && hit.stale) return { warning: WARNING, ...hit.stale, stale: true, cached: true };
    throw e;
  }

  if (!data) {
    // Honest refusal: bytecode-only "audits" are guesswork.
    const out = {
      lane: "/audit-prep",
      chain: ch,
      chain_id: chainId,
      address: addr,
      verified: false,
      findings: [],
      risk: "unknown",
      risk_score: null,
      honest: "This contract's source is not verified on Sourcify, so there is nothing meaningful to review — a bytecode-only 'audit' would be guesswork, and we will not sell you one. Verify the source (Sourcify or Blockscout), then re-run this lane.",
      swarm_prompts: SWARM_PROMPTS,
      what_a_human_auditor_should_still_check: HUMAN_AUDIT_CHECKLIST,
      source: "sourcify v2 (no key)",
    };
    cache.set(key, out);
    return { warning: WARNING, ...out };
  }

  let files = data.files.filter((f) => f.path.endsWith(".sol"));
  if (!files.length) files = data.files;

  const { findings, ozImports } = runBattery(files, {
    proxyScaffold: PROXY_SCAFFOLD.test(stripComments(files.map((f) => f.content).join("\n"))),
  });

  // Merge Sourcify's own proxy resolution — an audit that misses upgradeability is worthless.
  const pr = data.proxyResolution;
  let proxy = null;
  if (pr && pr.isProxy) {
    proxy = {
      is_proxy: true,
      proxy_type: pr.proxyType || "unknown",
      implementations: (pr.implementations || []).map((i) => ({ address: i.address, name: i.name || null })),
    };
    findings.unshift({
      severity: "medium",
      code: "upgradeable-proxy",
      title: `Upgradeable proxy (${proxy.proxy_type}) — logic can be swapped`,
      detail: `Sourcify resolves this contract as an upgradeable proxy${proxy.implementations.length ? ` → implementation ${proxy.implementations[0].name || proxy.implementations[0].address}` : ""}. The admin can replace the logic contract at any time: today's reviewed code can become tomorrow's rug. Verify who the admin is and whether upgrades are timelocked.`,
      location: { file: "(proxy resolution, Sourcify)", line: null },
      pattern: `proxyType=${proxy.proxy_type}`,
    });
    // Pull the implementation's sources too (one level) so the battery sees real logic.
    try {
      const implAddr = proxy.implementations[0] && proxy.implementations[0].address;
      if (implAddr && files.length < 40) {
        const impl = await fetchVerified(chainId, implAddr);
        if (impl && impl.files) {
          const implFiles = impl.files
            .filter((f) => f.path.endsWith(".sol"))
            .slice(0, 40 - files.length)
            .map((f) => ({ path: `implementation/${f.path}`, content: f.content }));
          if (implFiles.length) {
            const r2 = runBattery(implFiles, {
              proxyScaffold: PROXY_SCAFFOLD.test(stripComments(files.map((f) => f.content).join("\n"))),
            });
            for (const f of r2.findings) findings.push(f);
            files = files.concat(implFiles);
          }
        }
      }
    } catch { /* implementation fetch is a bonus */ }
  }

  // OpenZeppelin drift: diff vendored OZ files against OZ master.
  let oz = { imports_found: ozImports.length, checked: 0, matching_master: 0, drifted: [] };
  try {
    oz = await ozDrift(ozImports, files);
  } catch { /* drift check is a bonus */ }
  for (const imp of oz.drifted) {
    findings.push({
      severity: "medium",
      code: "oz-drift",
      title: `Vendored ${imp.split("/").slice(-1)[0]} differs from current OpenZeppelin master`,
      detail: `The project's copy of this OpenZeppelin file does not match today's OZ master. It may pin an older reviewed release (fine — check which) or carry local edits (review the delta line by line — modified library code loses the upstream audit).`,
      location: { file: imp, line: null },
      pattern: "diff vs openzeppelin-contracts/master",
    });
  }

  // Centralization: owner-gated powers with no multisig/timelock evidence.
  const combined = files.map((f) => f.content).join("\n");
  const codeC = stripComments(combined);
  const hasOwnerPowers = /onlyOwner|onlyRole|onlyAdmin/.test(codeC) && DANGEROUS_FNS.some((fn) => new RegExp(`function\\s+${fn}\\s*\\(`).test(codeC));
  const hasDecentralizedAdmin = /TimelockController|GnosisSafe|Safe\.sol|multisig|MultiSig/i.test(codeC);
  if (hasOwnerPowers && !hasDecentralizedAdmin) {
    findings.push({
      severity: "medium",
      code: "single-admin",
      title: "Single-admin control with no timelock/multisig in evidence",
      detail: "Privileged functions are gated by a single owner/role and there is no timelock or multisig pattern in the source. One compromised key can exercise every privileged power immediately. Verify the owner is a multisig or timelock off-chain before trusting it.",
      location: { file: "(project-wide)", line: null },
      pattern: "onlyOwner/onlyRole without TimelockController|GnosisSafe",
    });
  }

  const score = Math.min(100, findings.reduce((s, f) => s + (SEV_POINTS[f.severity] || 0), 0));
  const risk = riskOf(score);
  const worst = findings.find((f) => f.severity === "high") || findings[0];
  const comp = data.compilation || {};
  const mainFile = files.find((f) => /contracts\//.test(f.path) && !/node_modules|@openzeppelin|lib\//.test(f.path)) || files[0];

  const out = {
    lane: "/audit-prep",
    chain: ch,
    chain_id: chainId,
    address: addr,
    verified: true,
    verification: data.match,
    contract_name: comp.name || null,
    compiler: comp.compilerVersion || null,
    language: comp.language || "Solidity",
    proxy,
    files_analyzed: files.length,
    openzeppelin: oz,
    risk,
    risk_score: score,
    findings,
    summary: !findings.length
      ? "No findings from the deterministic battery. That is not a clean bill of health — run the swarm prompts below and get a human audit before real money."
      : `${risk.toUpperCase()} (${score}/100): ${worst.title.toLowerCase()}${findings.length > 1 ? ` +${findings.length - 1} more finding${findings.length > 2 ? "s" : ""}` : ""}. Deterministic battery only — run the swarm prompts and get a human audit.`,
    main_file: mainFile ? mainFile.path : null,
    swarm_prompts: SWARM_PROMPTS,
    what_a_human_auditor_should_still_check: HUMAN_AUDIT_CHECKLIST,
    source: "sourcify v2 (no key)",
    generated_at: new Date().toISOString(),
    cached: false,
  };
  cache.set(key, out);
  return { warning: WARNING, ...out };
}

module.exports = { auditPrep, WARNING, AUDIT_PREP_CHAINS: Object.keys(CHAINS) };
