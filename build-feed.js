// Mini's Tollbooth — feed builder (the chain edition).
// Aggregates open bounties from every board with a usable public API,
// derives the 24h fresh-meat lane, collects recently-paid verdicts as
// proof the boards pay, and merges the curated deadline +
// sweepstakes lanes. Run at boot and on a timer by server.js; also
// runnable standalone: node build-feed.js
// $0 cost: read-only public APIs, no keys needed (Superteam lane uses the
// agent API key from env when present, and degrades gracefully without it).
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "feed.json");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const DAY = 24 * 60 * 60 * 1000;

async function getJSON(url, headers = {}) {
  const res = await fetch(url, { headers: { ...UA, ...headers } });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

// --- Board 1: aibtc (sats bounties, public) ---
async function aibtc() {
  try {
    const d = await getJSON("https://aibtc.com/api/bounties?status=open&limit=50");
    const list = d.bounties || (Array.isArray(d) ? d : []);
    return list.map((b) => ({
      board: "aibtc",
      id: String(b.id),
      title: b.title,
      reward: b.rewardSats ? `${b.rewardSats.toLocaleString()} sats` : "see listing",
      url: `https://aibtc.com/bounties/${b.id}`,
      posted_at: b.createdAt || null,
      expires: b.expiresAt || null,
      tags: b.tags || [],
    }));
  } catch (e) {
    return [{ board: "aibtc", error: String(e.message || e) }];
  }
}

// --- Board 2: Taskmarket (USDC bounties, public) ---
async function taskmarket() {
  try {
    const d = await getJSON("https://api.taskmarket.dev/api/tasks?status=open&limit=50");
    const list = d.tasks || [];
    return list
      .filter((t) => (t.status || "open") === "open")
      .map((t) => {
        const firstLine = String(t.description || "").split("\n")[0].replace(/^#\s*/, "").slice(0, 120);
        const usdc = typeof t.reward === "number" ? t.reward / 1e6 : null;
        return {
          board: "taskmarket",
          id: String(t.id),
          ref: t.referenceCode || null,
          title: firstLine || t.referenceCode || "untitled task",
          reward: usdc != null ? `${usdc} USDC` : "see listing",
          url: `https://taskmarket.dev/tasks/${t.id}`,
          posted_at: t.createdAt || null,
          expires: t.expiryTime || null,
          tags: t.tags || [],
        };
      });
  } catch (e) {
    return [{ board: "taskmarket", error: String(e.message || e) }];
  }
}

// --- Board 3: Superteam Earn (agent-only listings, needs agent key) ---
async function superteam() {
  const key = process.env.SUPERTEAM_API_KEY;
  if (!key) return [{ board: "superteam", error: "no SUPERTEAM_API_KEY configured" }];
  try {
    const list = await getJSON("https://superteam.fun/api/agents/listings/live", {
      Authorization: `Bearer ${key}`,
    });
    const arr = Array.isArray(list) ? list : list.listings || [];
    return arr.map((l) => ({
      board: "superteam",
      id: String(l.id || l.slug || "unknown"),
      title: l.title || l.name || "untitled listing",
      reward: l.reward || l.amount || "see listing",
      url: l.url || l.link || "https://superteam.fun",
      posted_at: l.createdAt || l.publishedAt || null,
      expires: l.deadline || l.expiresAt || null,
      tags: l.tags || [],
    }));
  } catch (e) {
    return [{ board: "superteam", error: String(e.message || e) }];
  }
}

// --- Board 4: verdicts — recently PAID bounties (proof the boards pay) ---
// aibtc status=paid, Taskmarket status=completed, BountyBook status=verified.
async function verdicts() {
  const out = [];
  const errors = [];
  try {
    const d = await getJSON("https://aibtc.com/api/bounties?status=paid");
    for (const b of (d.bounties || d || []).slice(0, 25)) {
      out.push({
        board: "aibtc",
        id: String(b.id),
        title: b.title,
        reward: b.rewardSats ? `${Number(b.rewardSats).toLocaleString()} sats` : "see listing",
        url: `https://aibtc.com/bounties/${b.id}`,
        paid_at: b.paidAt || null,
        proof: b.paidTxid ? `stacks tx ${b.paidTxid}` : null,
        submissions: b.submissionCount ?? null,
      });
    }
  } catch (e) { errors.push(`aibtc-paid: ${e.message || e}`); }
  try {
    const d = await getJSON("https://api.taskmarket.dev/api/tasks?status=completed&limit=25");
    for (const t of (d.tasks || [])) {
      const firstLine = String(t.description || "").split("\n")[0].replace(/^#\s*/, "").slice(0, 120);
      const usdc = typeof t.reward === "number" ? t.reward / 1e6 : null;
      out.push({
        board: "taskmarket",
        id: String(t.id),
        ref: t.referenceCode || null,
        title: firstLine || t.referenceCode || "untitled task",
        reward: usdc != null ? `${usdc} USDC` : "see listing",
        url: `https://taskmarket.dev/tasks/${t.id}`,
        paid_at: t.claimedAt || t.updatedAt || null,
        proof: t.escrowTxHash ? `escrow tx ${t.escrowTxHash}` : null,
        submissions: t.submissionCount ?? null,
      });
    }
  } catch (e) { errors.push(`taskmarket-completed: ${e.message || e}`); }
  try {
    const d = await getJSON("https://api.bountybook.ai/jobs?status=verified&page=1");
    for (const j of ((d.jobs || d.job || [])).slice(0, 15)) {
      out.push({
        board: "bountybook",
        id: String(j.id),
        title: j.title,
        reward: j.budget_usdc ? `${j.budget_usdc} USDC` : "see listing",
        url: "https://bountybook.ai",
        paid_at: null,
        proof: j.executor_address ? `verified for ${j.executor_address}` : "oracle-verified",
        submissions: null,
      });
    }
  } catch (e) { errors.push(`bountybook-verified: ${e.message || e}`); }
  out.sort((x, y) => Date.parse(y.paid_at || 0) - Date.parse(x.paid_at || 0));
  return { verdicts: out, errors };
}

function loadCurated(name) {
  try {
    return JSON.parse(fs.readFileSync(path.join(__dirname, "data", `${name}.json`), "utf8"));
  } catch {
    return null;
  }
}

async function build() {
  const [a, t, s] = await Promise.all([aibtc(), taskmarket(), superteam()]);
  const bounties = [...a, ...t, ...s].filter((b) => !b.error);
  const errors = [...a, ...t, ...s].filter((b) => b.error);
  const { verdicts: paid, errors: verdictErrors } = await verdicts();

  const cutoff = Date.now() - DAY;
  const fresh = bounties.filter((b) => {
    const ts = b.posted_at ? Date.parse(b.posted_at) : NaN;
    return !Number.isNaN(ts) && ts >= cutoff;
  });

  const deadlines = loadCurated("deadlines");
  const sweepstakes = loadCurated("sweepstakes");

  const feed = {
    generated_at: new Date().toISOString(),
    booth: "mini-tollbooth",
    lanes: {
      bounties: "GET /bounties — every open bounty across all boards",
      fresh: "GET /fresh — bounties posted in the last 24h",
      verdicts: "GET /verdicts — recently paid bounties, proof the boards pay",
      deadlines: "GET /deadlines — class-action claim deadlines worth money",
      sweepstakes: "GET /sweepstakes — free sweepstakes with real prizes",
    },
    bounties,
    fresh,
    verdicts: paid,
    deadlines: deadlines ? deadlines.deadlines : [],
    sweepstakes: sweepstakes ? sweepstakes.sweepstakes : [],
    count: {
      bounties: bounties.length,
      fresh: fresh.length,
      verdicts: paid.length,
      deadlines: deadlines ? deadlines.deadlines.length : 0,
      sweepstakes: sweepstakes ? sweepstakes.sweepstakes.length : 0,
    },
    board_errors: [...errors.map((e) => `${e.board}: ${e.error}`), ...verdictErrors],
  };
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2));
  console.log(
    `wrote ${OUT}: ${feed.count.bounties} bounties (${feed.count.fresh} fresh), ` +
      `${feed.count.verdicts} verdicts, ` +
      `${feed.count.deadlines} deadlines, ${feed.count.sweepstakes} sweepstakes` +
      (feed.board_errors.length ? ` | board errors: ${feed.board_errors.join("; ")}` : "")
  );
  return feed;
}

if (require.main === module) {
  build().catch((e) => { console.error("feed build failed:", e.message); process.exit(1); });
}
module.exports = { build };
