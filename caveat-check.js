// TrollBridge /caveat-check lane — data layer.
// Heuristic "did the summary drop the caveats?" screen: compares an agent's
// finding/summary text against its original source text and flags claim
// sentences that keep the headline number but lost the baseline, the
// measurer, the conditions, or gained an absolute that the source never made.
// Pure local text analysis — NO network calls, NO URL fetching. Reads only
// the two strings handed to it.
//
// HEURISTIC TEXT ANALYSIS, NOT AN AUDIT: a clean result means no
// dropped-caveat patterns fired, not that the summary is faithful. Real
// faithfulness review needs a human reading both documents.

const MAX_INPUT_BYTES = 30 * 1024;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- sentence splitter ----
function splitClaims(text) {
  return text
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// ---- pattern banks ----
const COMPARATIVE_RE =
  /\b(faster|slower|better|worse|higher|lower|greater|smaller|larger|cheaper|improvement|boost|reduction|increase|decrease|outperforms?|beats?|beat|exceeds?|surpasses?|reduces?|cuts?)\b/i;
const NUMBER_RE = /\d+\s?x|\d+(\.\d+)?\s?%/i;
const ANY_NUMBER_RE = /\d+/;

const BASELINE_RE =
  /\b(compared\s+to|comparison\s+with|baseline|versus|\bvs\.?\b|relative\s+to|over\s+(the\s+)?(baseline|previous|prior|old|earlier)|from\s+\d[\d,.]*\s+to\s+\d)/i;

const MEASURER_RE =
  /\b(measured\s+by|according\s+to|the\s+authors?|benchmark|study|studies|evaluation|evaluated|tested\s+on|researchers?|reported\s+by|measured\s+on)\b/i;

const MODEL_NAME_RE =
  /\b(gpt|claude|llama|mistral|gemini|bert|resnet|vit|whisper|falcon|bloom|t5|mpt)[-\s]?\d?[a-z]*\b/i;
const CONDITIONS_RE =
  /\b(version|\bv\d+(\.\d+)+|\bdataset\b|dataset\s*[:\-]|config|configuration|setting|environment|hardware|gpu|cpu|tpu|batch\s+size|seed|model\s+name|on\s+the\s+\w+\s+(dataset|benchmark))/i;

const ABSOLUTE_RE =
  /\b(best|fastest|slowest|cheapest|most\s+\w+|state[-\s]?of[-\s]?the[-\s]?art|\bSOTA\b|guarantees?|always|never|100\s?%|zero[-\s]?risk|perfect|flawless|impossible\s+to\s+(fail|lose|break)|can'?t\s+(fail|lose|be))\b/i;
const QUALIFIER_RE =
  /\b(may|might|can|could|often|typically|generally|usually|suggests?|indicates?|appears?|seems?|likely|possibly|in\s+(some|certain)\s+cases|under\s+(certain|specific)\s+conditions|preliminary|limited)\b/i;

// ---- per-claim checks ----
function checkClaim(claim) {
  const out = [];
  const hasNumber = ANY_NUMBER_RE.test(claim);
  const hasComparative = COMPARATIVE_RE.test(claim) || NUMBER_RE.test(claim);
  const hasAbsolute = ABSOLUTE_RE.test(claim);

  if (hasComparative && !BASELINE_RE.test(claim)) {
    out.push({
      type: "missing-baseline",
      what_to_ask: "Ask: compared to what baseline?",
    });
  }

  if ((hasNumber || COMPARATIVE_RE.test(claim)) && !MEASURER_RE.test(claim)) {
    out.push({
      type: "missing-measurer",
      what_to_ask: "Ask: who measured this, and how?",
    });
  }

  if (hasNumber && !CONDITIONS_RE.test(claim) && !MODEL_NAME_RE.test(claim)) {
    out.push({
      type: "missing-conditions",
      what_to_ask: "Ask: under what conditions — version, dataset, config, hardware?",
    });
  }

  if (hasAbsolute && !QUALIFIER_RE.test(claim)) {
    out.push({
      type: "absolute-claim",
      what_to_ask: "Ask: what qualifies this absolute claim?",
    });
  }

  return out;
}

// ---- source qualifier extraction (dropped-from-source) ----
const QUALIFIER_PATTERNS = [
  /\bv\d+(\.\d+)*(\s*(alpha|beta|rc\d*))?/i, // v1.2.3
  /\b\d{4}-\d{2}-\d{2}\b/, // 2026-03-14
  /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(,\s+\d{4})?/i,
  /on\s+the\s+([A-Za-z0-9][\w\- ]{1,40})\s+(dataset|benchmark)/i,
  /\b([A-Za-z][\w\-]{2,30})\s+dataset\b/i,
];

function extractQualifiers(source) {
  const found = [];
  for (const re of QUALIFIER_PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : re.flags + "g");
    let m;
    while ((m = global.exec(source)) !== null) {
      const s = m[0].trim();
      if (!s) continue;
      const low = s.toLowerCase();
      // skip exact duplicates and qualifiers already covered by a longer one
      if (found.some((f) => f.toLowerCase() === low || f.toLowerCase().includes(low))) continue;
      // remove shorter entries this one subsumes
      for (let i = found.length - 1; i >= 0; i--) {
        if (low.includes(found[i].toLowerCase())) found.splice(i, 1);
      }
      found.push(s);
    }
  }
  return found;
}

function snippetAround(source, match, radius = 60) {
  const i = source.toLowerCase().indexOf(match.toLowerCase());
  if (i === -1) return match;
  const start = Math.max(0, i - radius);
  const end = Math.min(source.length, i + match.length + radius);
  let s = source.slice(start, end).trim();
  if (s.length > 120) s = s.slice(0, 117) + "...";
  return s;
}

async function caveatCheck(finding, source) {
  if (typeof finding !== "string" || !finding.trim()) {
    throw badRequest(
      "missing required param: finding (usage: GET /caveat-check?finding=...&source=... — the agent's summary/claim text and the original source text)"
    );
  }
  if (typeof source !== "string" || !source.trim()) {
    throw badRequest(
      "missing required param: source (usage: GET /caveat-check?finding=...&source=... — the agent's summary/claim text and the original source text)"
    );
  }
  if (Buffer.byteLength(finding, "utf8") > MAX_INPUT_BYTES) {
    throw badRequest("finding exceeds 30KB — trim it and retry");
  }
  if (Buffer.byteLength(source, "utf8") > MAX_INPUT_BYTES) {
    throw badRequest("source exceeds 30KB — trim it and retry");
  }

  const claims = splitClaims(finding);
  const missing_caveats = [];

  for (const claim of claims) {
    const claimShort = claim.length > 200 ? claim.slice(0, 197) + "..." : claim;
    for (const hit of checkClaim(claim)) {
      missing_caveats.push({ claim: claimShort, type: hit.type, what_to_ask: hit.what_to_ask });
    }
  }

  // Cross-check: qualifiers in the source that never made it into the finding.
  const findingLower = finding.toLowerCase();
  let sourceLevel = 0;
  for (const q of extractQualifiers(source)) {
    if (!findingLower.includes(q.toLowerCase())) {
      sourceLevel++;
      missing_caveats.push({
        claim: "(source-level qualifier, absent from finding)",
        type: "dropped-from-source",
        what_to_ask:
          "Ask: why was this source detail dropped? — " + snippetAround(source, q),
      });
    }
  }

  const claims_analyzed = claims.length;
  const caveats_dropped = missing_caveats.length;
  // verdict grades per-claim findings only; source-level drops are bonus, not claims
  const claimLevel = caveats_dropped - sourceLevel;
  const avg = claims_analyzed > 0 ? claimLevel / claims_analyzed : 0;

  const verdict =
    avg === 0 ? "caveats-intact" : avg < 3 ? "caveats-dropped" : "heavily-stripped";

  return {
    claims_analyzed,
    caveats_dropped,
    missing_caveats,
    verdict,
    note: "NOT AN AUDIT — heuristic text analysis; a clean result means no dropped-caveat patterns fired, not that the summary is faithful",
  };
}

module.exports = { caveatCheck };
