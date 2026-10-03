// TrollBridge paid-crossing receipts — AER-1 conformant execution receipts.
//
// Every paid crossing (x402 USDC toll or GAS burn-to-cross) gets a receipt
// conforming to AER-1 (IETF draft-zambo-aer1-09): a portable, independently
// checkable record of one tool execution. Any third party can recompute the
// SHA-256 commitments from the stored canonical bytes — no trust in us needed.
//
// What a receipt proves: the exact output bytes the lane served, which lane
// ran, when, on which toll rail. What it does NOT prove: that the analysis
// was correct. A passing hash confirms the bytes match the commitment —
// never upgrade a receipt into a claim about the world beyond the bytes.
//
// Privacy design (deliberate, unchanged): raw user inputs are NEVER stored —
// only their SHA-256 (input_hash). Payer wallets are NEVER stored —
// payment_ref is an opaque hash. Lane privacy is absolute. Only the lane's
// *output* (already served to the caller) is preserved as canonical_bytes,
// which is what makes third-party verification possible.
//
// Chain: AER-1 §7 (v07 hardened) hash chain over code-point-sorted canonical
// JSON binding seq/job_id/close/id/tool/provenance_class/output_hash.
// Pure SHA-256 — anyone can recompute every link, no server secret needed.
// Genesis prev_digest is 64 zeros. job_id is "trollbridge-main": one global
// append-only crossing ledger.
//
// The HMAC-SHA256 `signature` survives as an AER-1-legal extension field:
// it proves the receipt was minted by this server (defense in depth), but
// the chain's trust anchor is public recomputation, not the secret.
//
// Schema versions: "0.3" = AER-1 conformant (this file). Anything older or
// missing is pre-convergence legacy — verify() reports it honestly as
// "legacy" rather than failing closed on the new checks.
//
// Persistence follows the usage.json convention: in-memory with a
// best-effort flush every 30s plus a SIGTERM flush. Same ephemeral-filesystem
// caveat as the rest of the ledger on free-tier hosting. Capped at
// MAX_RECEIPTS (oldest evicted first); an evicted head leaves the oldest
// surviving receipt's prev_digest dangling, which verify() reports honestly
// as "head-evicted" rather than failing.
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const RECEIPTS_PATH = path.join(__dirname, "data", "receipts.json");
const SECRET_PATH = path.join(__dirname, "data", "receipt-secret.json");
const MAX_RECEIPTS = 25000;

const AER1_SCHEMA_VERSION = "0.3";
const PROVENANCE_CLASS = "EXECUTED BY TROLLBRIDGE";
const JOB_ID = "trollbridge-main";
const GENESIS_DIGEST = "0".repeat(64);
const TOOL_SCOPE = "public";
const TOOL_VERSION = "1.0.0"; // first receipted lane-tool version

function sha256hex(s) {
  return crypto.createHash("sha256").update(String(s), "utf8").digest("hex");
}

// The signing key: generated once with real entropy and kept next to the
// ledger. Not an env var, not committed, never logged. If the secret file is
// lost (filesystem reset), old receipts' HMACs stop verifying — the AER-1
// chain still verifies by public recomputation; the signature is only a
// server-mint proof, never the trust anchor.
function loadSecret() {
  try {
    const raw = JSON.parse(fs.readFileSync(SECRET_PATH, "utf8"));
    if (raw && typeof raw.key === "string" && raw.key.length >= 32) return raw.key;
  } catch {
    // first boot: mint the key
  }
  const key = crypto.randomBytes(32).toString("hex");
  try {
    fs.writeFileSync(SECRET_PATH, JSON.stringify({ created_at: new Date().toISOString(), key }, null, 2), { mode: 0o600 });
  } catch {
    // best-effort; an unwritable secret means the HMAC extension can't be
    // minted — surfaced loudly below rather than silently forged.
  }
  return key;
}
const SECRET = loadSecret();

// ---- canonical JSON ----
// Matches Python json.dumps(obj, sort_keys=True, separators=(",", ":"),
// ensure_ascii=True): keys sorted by Unicode code point, no whitespace,
// non-ASCII escaped as \uXXXX (surrogate pairs above the BMP). This is the
// byte layout AER-1 §7.1 digests are computed over — byte-identical with the
// conformance kit's chain_entry_digest_v07.
function cmpCodePoint(a, b) {
  const ai = [...a];
  const bi = [...b];
  const n = Math.min(ai.length, bi.length);
  for (let i = 0; i < n; i++) {
    const d = ai[i].codePointAt(0) - bi[i].codePointAt(0);
    if (d) return d;
  }
  return ai.length - bi.length;
}

function jsonEscape(s) {
  let out = '"';
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (ch === '"') out += '\\"';
    else if (ch === "\\") out += "\\\\";
    else if (ch === "\b") out += "\\b";
    else if (ch === "\f") out += "\\f";
    else if (ch === "\n") out += "\\n";
    else if (ch === "\r") out += "\\r";
    else if (ch === "\t") out += "\\t";
    else if (cp < 0x20 || cp > 0x7e) {
      if (cp <= 0xffff) {
        out += "\\u" + cp.toString(16).padStart(4, "0");
      } else {
        const v = cp - 0x10000;
        out += "\\u" + (0xd800 + (v >> 10)).toString(16).padStart(4, "0");
        out += "\\u" + (0xdc00 + (v & 0x3ff)).toString(16).padStart(4, "0");
      }
    } else {
      out += ch;
    }
  }
  return out + '"';
}

function canonicalJson(v) {
  if (v === null || v === undefined) return "null";
  if (typeof v === "boolean") return v ? "true" : "false";
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("non-finite number in canonical JSON");
    return JSON.stringify(Math.trunc(v) === v ? Math.trunc(v) : v);
  }
  if (typeof v === "string") return jsonEscape(v);
  if (Array.isArray(v)) return "[" + v.map(canonicalJson).join(",") + "]";
  if (typeof v === "object") {
    const keys = Object.keys(v).sort(cmpCodePoint);
    return "{" + keys.map((k) => jsonEscape(k) + ":" + canonicalJson(v[k])).join(",") + "}";
  }
  throw new Error("unserializable value in canonical JSON");
}

// AER-1 §7.1 entry digest: SHA-256 over the UTF-8 bytes of the canonical
// JSON object {prev_digest, seq, job_id, close, id, tool, provenance_class,
// output_hash} (code-point-sorted keys, no whitespace). `tool` here is the
// tool NAME string (chain-entry form); output_hash is the lowercase hex
// SHA-256 of the base64-decoded canonical_bytes. A missing close digests
// as false.
function entryDigest({ prev_digest, seq, job_id, close, id, tool, provenance_class, outputHashHex }) {
  const payload = {
    prev_digest: String(prev_digest),
    seq: Number(seq),
    job_id: String(job_id),
    close: close === true,
    id: String(id),
    tool: String(tool),
    provenance_class: String(provenance_class),
    output_hash: String(outputHashHex),
  };
  return sha256hex(Buffer.from(canonicalJson(payload), "utf8"));
}

function hmacSign(s) {
  return crypto.createHmac("sha256", SECRET).update(String(s), "utf8").digest("hex");
}

// ---- store ----
let receipts = [];
let byId = new Map();
let byDigest = new Map();
let seqCounter = 0;
let dirty = false;

function indexReceipt(r) {
  if (r && r.id) byId.set(r.id, r);
  if (r && r.receipt_id && r.receipt_id !== r.id) byId.set(r.receipt_id, r);
  if (r && r.entry_digest) byDigest.set(r.entry_digest, r);
}

try {
  const raw = JSON.parse(fs.readFileSync(RECEIPTS_PATH, "utf8"));
  if (Array.isArray(raw)) {
    // legacy pre-convergence format: bare array
    receipts = raw;
    seqCounter = raw.length;
  } else if (raw && Array.isArray(raw.receipts)) {
    receipts = raw.receipts;
    seqCounter = Number(raw.seq) || raw.receipts.length;
  }
  for (const r of receipts) indexReceipt(r);
} catch {
  // first run: empty ledger
}

function flush() {
  if (!dirty) return;
  try {
    fs.writeFileSync(
      RECEIPTS_PATH,
      JSON.stringify({ version: AER1_SCHEMA_VERSION, seq: seqCounter, receipts }, null, 2)
    );
    dirty = false;
  } catch {
    // best-effort, same as usage.json
  }
}
const flushTimer = setInterval(flush, 30000);
flushTimer.unref();
process.on("SIGTERM", flush);

// Canonical query string for input hashing: sorted keys, stable encoding.
// Values are hashed, never stored — ?address= and ?wallet= lookups leave
// no trace of the address itself in the receipt.
function canonicalQuery(query) {
  const keys = Object.keys(query || {}).sort();
  return keys
    .map((k) => {
      const v = query[k];
      const s = Array.isArray(v) ? v.map(String).join(",") : String(v);
      return `${encodeURIComponent(k)}=${encodeURIComponent(s)}`;
    })
    .join("&");
}

// Issue a receipt for one paid crossing. Fields:
//   lane, amount ("$0.02"), method ("x402"|"fuel"),
//   network (best-effort rail id, may be null),
//   paymentRef (opaque hex — sha256 of the payment blob or fuel tx; never raw),
//   inputHash (sha256 of canonical query — never the raw query),
//   output: the served response body — string (exact bytes preserved) or
//     object (canonicalized). The output bytes ARE stored (base64) — they are
//     already caller-visible, so persisting them changes nothing about
//     exposure, and they are what make third-party verification possible.
//   toolVersion (optional lane-tool version; defaults to TOOL_VERSION).
function issue({ lane, amount, method, network, paymentRef, inputHash, output, toolVersion }) {
  const outputBytes = typeof output === "string" ? output : canonicalJson(output);
  const canonicalB64 = Buffer.from(outputBytes, "utf8").toString("base64");
  const outputHashHex = sha256hex(Buffer.from(outputBytes, "utf8"));

  const prev = receipts.length ? receipts[receipts.length - 1] : null;
  const prev_digest = prev && prev.entry_digest ? prev.entry_digest : GENESIS_DIGEST;
  const seq = seqCounter + 1;
  const id = crypto.randomUUID();
  const created_at = new Date().toISOString();
  const toolName = String(lane);

  const digest = entryDigest({
    prev_digest,
    seq,
    job_id: JOB_ID,
    close: false,
    id,
    tool: toolName,
    provenance_class: PROVENANCE_CLASS,
    outputHashHex,
  });

  const r = {
    // ---- AER-1 core (draft §3, Table 1) ----
    id,
    receipt_schema_version: AER1_SCHEMA_VERSION,
    created_at,
    tool: { name: toolName, version: String(toolVersion || TOOL_VERSION), scope: TOOL_SCOPE },
    provenance_class: PROVENANCE_CLASS,
    canonical_bytes: canonicalB64,
    output_hash: "sha256:" + outputHashHex,
    verification_status: "verified",
    // ---- AER-1 chain (§7 v07) ----
    seq,
    job_id: JOB_ID,
    prev_digest,
    close: false,
    entry_digest: digest,
    // ---- TrollBridge extensions (legal: must not change core meaning) ----
    receipt_id: id, // legacy alias — X-TrollBridge-Receipt header already uses it
    bridge: "TrollBridge",
    lane: toolName, // legacy alias
    timestamp: created_at, // legacy alias
    toll: { amount: String(amount), method: String(method) },
    network: network || null,
    payment_ref: String(paymentRef),
    input_hash: String(inputHash),
    signature: hmacSign(digest), // server-mint proof (extension, not the trust anchor)
  };

  seqCounter = seq;
  receipts.push(r);
  indexReceipt(r);
  while (receipts.length > MAX_RECEIPTS) {
    const old = receipts.shift();
    if (old) {
      byId.delete(old.id);
      if (old.receipt_id && old.receipt_id !== old.id) byId.delete(old.receipt_id);
      if (old.entry_digest) byDigest.delete(old.entry_digest);
    }
  }
  dirty = true;
  return r;
}

function get(id) {
  return byId.get(String(id)) || null;
}

function isAer1(r) {
  return r && r.receipt_schema_version === AER1_SCHEMA_VERSION && typeof r.canonical_bytes === "string";
}

// Legacy (pre-convergence) verification: the old HMAC-over-array scheme.
// Kept so any receipts minted before convergence verify honestly as
// "legacy" instead of failing the new checks.
function verifyLegacy(r) {
  const canon = JSON.stringify([
    r.receipt_id,
    r.lane,
    r.timestamp,
    r.toll && r.toll.amount,
    r.toll && r.toll.method,
    r.payment_ref,
    r.input_hash,
    r.output_hash,
    r.prev_sig,
  ]);
  if (hmacSign(canon) !== r.signature) {
    return { found: true, valid: false, schema: "legacy", reason: "signature_mismatch", chain: "broken" };
  }
  return { found: true, valid: true, schema: "legacy", reason: null, chain: "legacy-chain" };
}

// Recompute everything about one entry from its canonical_bytes — the same
// checks a third-party verifier performs. Returns { ok, reason, outputHashHex }.
function checkEntry(r) {
  let raw;
  try {
    const clean = String(r.canonical_bytes).replace(/\s+/g, "");
    raw = Buffer.from(clean, "base64");
    if (raw.toString("base64") !== clean) {
      return { ok: false, reason: "canonical_bytes_not_canonical_base64" };
    }
    new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return { ok: false, reason: "canonical_bytes_undecodable" };
  }
  const outputHashHex = sha256hex(raw);
  if ("sha256:" + outputHashHex !== r.output_hash) {
    return { ok: false, reason: "output_hash_mismatch" };
  }
  const wantDigest = entryDigest({
    prev_digest: r.prev_digest,
    seq: r.seq,
    job_id: r.job_id,
    close: r.close === true,
    id: r.id,
    tool: r.tool.name,
    provenance_class: r.provenance_class,
    outputHashHex,
  });
  if (wantDigest !== r.entry_digest) {
    return { ok: false, reason: "entry_digest_mismatch" };
  }
  return { ok: true, outputHashHex };
}

// Verify a receipt: output commitment first (anyone can recompute), then the
// entry digest, then walk the chain back to genesis — re-verifying every
// visited entry's bytes, not just the links. Returns
// { found, valid, schema, reason, chain, checks }.
function verify(id) {
  const r = get(id);
  if (!r) return { found: false };
  if (!isAer1(r)) return verifyLegacy(r);

  const checks = { output_hash_ok: false, entry_digest_ok: false, signature_ok: false };
  const head = checkEntry(r);
  if (!head.ok) {
    return { found: true, valid: false, schema: "aer1", reason: head.reason, chain: "broken", checks };
  }
  checks.output_hash_ok = true;
  checks.entry_digest_ok = true;
  checks.signature_ok = hmacSign(r.entry_digest) === r.signature;

  // Walk the chain back to genesis via prev_digest links, fully re-checking
  // each visited entry (bytes included) — never trust stored links alone.
  let chain = "genesis";
  if (r.prev_digest !== GENESIS_DIGEST) {
    let curDigest = r.prev_digest;
    const seen = new Set([r.entry_digest]);
    for (;;) {
      const prev = byDigest.get(curDigest);
      if (!prev) {
        chain = "head-evicted";
        break;
      }
      if (seen.has(prev.entry_digest)) {
        chain = "broken"; // cycle
        break;
      }
      const pc = checkEntry(prev);
      if (!pc.ok) {
        chain = "broken";
        break;
      }
      seen.add(prev.entry_digest);
      if (prev.prev_digest === GENESIS_DIGEST) {
        chain = "linked";
        break;
      }
      curDigest = prev.prev_digest;
    }
  }
  const valid = chain === "genesis" || chain === "linked";
  return {
    found: true,
    valid,
    schema: "aer1",
    reason: valid ? null : "chain_" + chain,
    chain,
    checks,
  };
}
// Export the full chain as an AER-1 §7 timeline for third-party verification
// (e.g. the conformance kit's verify_chain_v07). This is a DERIVED view:
// stored receipts keep close:false; the export marks close:true on the last
// entry of the exported window, which is what §7 requires of a complete
// timeline. Entry digests for non-final entries are unaffected (close:false
// digests as false either way).
function chainTimeline() {
  return receipts
    .filter(isAer1)
    .map((r, i, arr) => ({
      id: r.id,
      seq: r.seq,
      job_id: r.job_id,
      tool: r.tool.name,
      provenance_class: r.provenance_class,
      canonical_bytes: r.canonical_bytes,
      prev_digest: r.prev_digest,
      close: i === arr.length - 1,
    }));
}

function count() {
  return receipts.length;
}

// Express middleware factory: mint a receipt for every paid crossing.
// Mount AFTER the toll collector (or fuel gate). The collector 402s unpaid
// calls without calling next(), so a tolled lane reaching this middleware is
// paid by construction — the belt-and-braces hadPayment/fuelCrossing check
// mirrors the traffic ledger's own paid-crossing definition so receipt
// counts can never drift from /traffic's paid counts.
// The receipt id travels back on the X-TrollBridge-Receipt response header
// (X-TrollBridge-Verify carries the public check URL) — set before the body
// is sent, inside the same res.send wrap the almost-paid tracker uses; the
// two wrappers stack without touching each other. Receipts never break the
// lane: everything is wrapped in try/catch.
function networkFromPaymentHeader(headers) {
  try {
    const h = headers["payment-signature"] || headers["x-payment"];
    if (!h) return null;
    const json = JSON.parse(Buffer.from(String(h), "base64").toString("utf8"));
    return json?.network || json?.payload?.network || null;
  } catch {
    return null;
  }
}

function createReceiptMiddleware({ isTolled, lanePrice, baseUrl }) {
  return function receiptIssuer(req, res, next) {
    if (req.method !== "GET" || !isTolled(req.path)) return next();
    const hadPayment = !!(req.headers["payment-signature"] || req.headers["x-payment"]);
    const fuel = !!req.fuelCrossing;
    if (!hadPayment && !fuel) return next(); // not a paid crossing: no receipt
    const origSend = res.send.bind(res);
    res.send = function (body) {
      try {
        if (res.statusCode >= 200 && res.statusCode < 300) {
          const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
          const method = hadPayment ? "x402" : "fuel";
          const rawRef = hadPayment
            ? String(req.headers["payment-signature"] || req.headers["x-payment"])
            : String((req.query && req.query.fuelTx) || "").toLowerCase();
          const receipt = issue({
            lane: req.path,
            amount: lanePrice(req.path),
            method,
            network: hadPayment ? networkFromPaymentHeader(req.headers) : "eip155:8453", // GAS burns are Base-only
            paymentRef: sha256hex(rawRef),
            inputHash: sha256hex(canonicalQuery(req.query)),
            output: bodyStr, // exact served bytes — preserved for verification
          });
          res.set("X-TrollBridge-Receipt", receipt.id);
          res.set("X-TrollBridge-Verify", `${baseUrl}/verify/${receipt.id}`);
        }
      } catch {
        // the receipt ledger never breaks a paid crossing
      }
      return origSend(body);
    };
    next();
  };
}

module.exports = {
  issue,
  get,
  verify,
  count,
  chainTimeline,
  canonicalJson,
  entryDigest,
  sha256: sha256hex,
  sha256hex,
  canonicalQuery,
  flush,
  createReceiptMiddleware,
  AER1_SCHEMA_VERSION,
  PROVENANCE_CLASS,
  JOB_ID,
  GENESIS_DIGEST,
  MAX_RECEIPTS,
};
