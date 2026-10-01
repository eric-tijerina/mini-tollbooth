// TrollBridge /scam-scan lane — data layer.
// Heuristic scam smell-test for a money opportunity (bounty, arena, airdrop,
// paid gig, investment pitch): fetches the listing URL, runs a 10-flag
// checklist against the page text, extracts prize vs. cost amounts, does the
// prize-pool math, and returns a verdict: CLEAN, CAUTION, or LIKELY SCAM.
//
// HEURISTIC SCREEN, NOT A FRAUD INVESTIGATION: pattern matches against the
// page's visible text, not a professional review, and it cannot verify the
// sponsor's identity or track record. A clean screen does not mean safe.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const MAX_FETCH_BYTES = 500 * 1024;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

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
const scanCache = makeCache(60 * 60 * 1000);

function assertSafeUrl(url) {
  let u;
  try {
    u = new URL(url);
  } catch {
    throw badRequest("url must be a valid http(s):// address");
  }
  if (!/^https?:$/.test(u.protocol)) throw badRequest("url must be http(s)://");
  const host = u.hostname.toLowerCase();
  if (
    host === "localhost" || host.endsWith(".localhost") ||
    /^127\./.test(host) || host === "::1" ||
    /^(10|192\.168)\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
  ) {
    throw badRequest("url must be a public address");
  }
  return u.toString();
}

async function fetchPageText(url, timeoutMs = 20000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: UA, signal: ctrl.signal });
    if (!res.ok) throw new Error(`GET ${url} -> HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    if (buf.length > MAX_FETCH_BYTES)
      throw badRequest(`page too large (${buf.length} bytes, cap ${MAX_FETCH_BYTES})`);
    let html = buf.toString("utf8");
    html = html.replace(/<script[\s\S]*?<\/script>/gi, " ");
    html = html.replace(/<style[\s\S]*?<\/style>/gi, " ");
    let text = html.replace(/<[^>]+>/g, " ");
    text = text.replace(/&nbsp;/gi, " ").replace(/&amp;/gi, "&")
      .replace(/&lt;/gi, "<").replace(/&gt;/gi, ">").replace(/&quot;/gi, '"');
    return text.replace(/\s+/g, " ").trim().slice(0, 60000);
  } finally {
    clearTimeout(t);
  }
}

function snippet(text, idx, len = 140) {
  const start = Math.max(0, idx - 50);
  return text.slice(start, idx + len).replace(/\s+/g, " ").trim().slice(0, 180);
}

// ---- amount extraction ----
const AMOUNT_RE = /\$[\d,]+(?:\.\d{1,2})?|(?:^|\s)(\d[\d,]*(?:\.\d{1,2})?)\s*(USDC|USDT|USD|SOL|ETH|BTC|sats)/gi;
const PRIZE_CTX = /priz|reward|payout|winnings|win\b|pool|bounty|grant/i;
const COST_CTX = /deposit|minimum|entry fee|fee|fund|stake|buy-?in|pay to|cost|requires? \$/i;

function extractAmounts(text) {
  const prize = [], cost = [];
  let m;
  AMOUNT_RE.lastIndex = 0;
  while ((m = AMOUNT_RE.exec(text)) !== null) {
    const raw = m[0].trim();
    const num = parseFloat(raw.replace(/[$,]/g, "").split(/\s/)[0]);
    if (!isFinite(num) || num <= 0) continue;
    const ctx = text.slice(Math.max(0, m.index - 120), m.index + raw.length + 60);
    const entry = { raw, usd_approx: /SOL/i.test(raw) ? null : num, context: ctx.replace(/\s+/g, " ").trim().slice(0, 140) };
    if (PRIZE_CTX.test(ctx)) prize.push(entry);
    else if (COST_CTX.test(ctx)) cost.push(entry);
  }
  const uniq = (arr) => {
    const seen = new Set();
    return arr.filter((e) => (seen.has(e.raw) ? false : (seen.add(e.raw), true)));
  };
  return { prize: uniq(prize).slice(0, 8), cost: uniq(cost).slice(0, 8) };
}

function maxUsd(entries) {
  let m = 0, known = false;
  for (const e of entries) {
    if (typeof e.usd_approx === "number") { if (e.usd_approx > m) m = e.usd_approx; known = true; }
  }
  return known ? m : null;
}

// ---- the 10-flag checklist ----
const FLAGS = [
  { id: "pay_to_play", name: "Pay-to-play economics",
    re: /deposit|entry fee|minimum (?:deposit|of|funding)|buy-?in|pay to (?:enter|join|participate)|fund (?:your|the) (?:wallet|account)|stake (?:\d|to)/i,
    why: "You must put money in before you can win anything." },
  { id: "custody", name: "Someone else holds your money",
    re: /connect (?:your )?wallet|deposit (?:to|into)|send (?:usdc|usdt|sol|eth|funds) to|funds? (?:are|will be) held|non-?custodial/i,
    why: "Deposits go to a wallet or account you do not control." },
  { id: "subjective_judging", name: "Subjective judging",
    re: /creativ\w+|at (?:our|their) discretion|judges? will|community (?:vote|choice)|subjective|editorial/i,
    why: "Winners are picked on vibes, not verifiable metrics." },
  { id: "urgency", name: "Urgency pressure",
    re: /deadline|ends? (?:tonight|soon|in \d)|limited spots|last chance|hurry|closing in|countdown|act (?:fast|now)/i,
    why: "Countdown pressure is engineered to stop you doing the math." },
  { id: "vague_terms", name: "Vague or shifting terms",
    re: /\btbd\b|to be (?:determined|announced)|terms (?:may|can) change|subject to change/i,
    why: "Prize, judging, or payout terms are fuzzy or movable." },
  { id: "no_payout_proof", name: "No proof of past payouts",
    re: null, why: "Prizes are promised but no past winners or payout transactions are shown.",
    custom: (text) => /priz|reward|payout|winner/i.test(text) && !/previous winners?|past winners?|txid|0x[0-9a-f]{8,}|paid out|winners announced/i.test(text) },
  { id: "reputation_laundering", name: "Reputation laundering (manual check)",
    re: null, why: "A legit platform does not vouch for the sponsor — vet the sponsor separately.",
    custom: (text) => /sponsor(?:ed)? by/i.test(text), manual: true },
  { id: "sunk_cost", name: "Sunk-cost hooks",
    re: /unlock|boost (?:your|entries)|additional (?:deposit|payment|fee)|to qualify|upgrade (?:to|for)/i,
    why: "Each step is small; the total is not. Designed to keep you topping up." },
  { id: "unverifiable_claims", name: "Unverifiable claims",
    re: /backed by \$[\d.,]+\s*[BM]|audited|millions of users|#1 \w+|trusted by thousands/i,
    why: "Big claims with no link, report, or number you can check." },
  { id: "credential_harvest", name: "Credential or access harvesting",
    re: /sign in with|connect (?:your )?(?:x|twitter|google|discord)|grant (?:access|permission)|approve the transaction|seed phrase/i,
    why: "The opportunity may be the excuse; your access may be the product." },
];

function runFlags(text) {
  return FLAGS.map((f) => {
    let hit = false, evidence = null;
    if (f.re) {
      const m = f.re.exec(text);
      if (m) { hit = true; evidence = snippet(text, m.index); }
    } else if (f.custom) {
      hit = f.custom(text);
      if (hit && f.id === "no_payout_proof") evidence = "prizes promised; no past-winner or payout-transaction evidence found in text";
      if (hit && f.id === "reputation_laundering") evidence = "sponsor named — verify their own track record independently";
    }
    return { id: f.id, name: f.name, hit, why: f.why, evidence, manual: !!f.manual };
  });
}

async function scamScan(rawUrl) {
  const url = assertSafeUrl(rawUrl);
  const cached = scanCache.get(url);
  if (cached && cached.fresh) return cached.fresh;

  const text = await fetchPageText(url);
  if (text.length < 200) throw badRequest("page returned almost no readable text — is the URL a listing page?");
  const amounts = extractAmounts(text);
  const flags = runFlags(text);
  const hits = flags.filter((f) => f.hit && !f.manual);
  const manualNotes = flags.filter((f) => f.hit && f.manual);

  const prizeTotal = maxUsd(amounts.prize);
  const costTotal = maxUsd(amounts.cost);

  let verdict, scoreNote;
  const n = hits.length;
  if (n >= 4) verdict = "LIKELY SCAM";
  else if (n >= 2) verdict = "CAUTION";
  else verdict = "CLEAN";

  // Economics override: costs exceeding prizes is never better than CAUTION.
  let math;
  if (prizeTotal !== null && costTotal !== null) {
    math = `~$${costTotal.toLocaleString()} to enter for a shot at up to ~$${prizeTotal.toLocaleString()} in advertised prizes.`;
    if (costTotal >= prizeTotal && verdict === "CLEAN") {
      verdict = "CAUTION";
      math += " Entry costs meet or exceed the top prize — negative expected value.";
    }
  } else if (prizeTotal !== null) {
    math = `Up to ~$${prizeTotal.toLocaleString()} in advertised prizes; no clear entry cost found in the text.`;
  } else if (costTotal !== null) {
    math = `~$${costTotal.toLocaleString()} in required deposits/fees found; no clear prize amount in the text.`;
  } else {
    math = "No clear prize or cost amounts found in the page text — treat missing numbers as a warning sign.";
  }

  let recommendation;
  if (verdict === "LIKELY SCAM") recommendation = "Walk away. The flags and the math both say no.";
  else if (verdict === "CAUTION") recommendation = "Only proceed if you can verify the sponsor's past payouts independently — and never deposit more than you can afford to lose.";
  else recommendation = "No red flags in the page text. Still verify the sponsor before sending anything.";

  const result = {
    lane: "/scam-scan",
    url,
    fetched_at: new Date().toISOString(),
    text_chars: text.length,
    prize_amounts: amounts.prize,
    cost_amounts: amounts.cost,
    prize_total_usd_approx: prizeTotal,
    cost_total_usd_approx: costTotal,
    flags,
    flags_hit: `${n} of ${FLAGS.length}`,
    manual_checks: manualNotes.map((f) => ({ id: f.id, name: f.name, why: f.why, evidence: f.evidence })),
    math,
    verdict,
    recommendation,
    limitation: "Heuristic screen of the page text — not a fraud investigation. It cannot verify the sponsor's identity, custody of funds, or payout history. Verify independently before sending money or connecting wallets.",
  };
  scanCache.set(url, result);
  return result;
}

module.exports = { scamScan };
