// Mini's Tollbooth — feed builder.
// Regenerates feed.json from live bounty boards. Run by the nightly sweep.
// $0 cost: read-only public APIs, no keys needed.
const fs = require("fs");
const path = require("path");

const OUT = path.join(__dirname, "feed.json");
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };

async function getJSON(url) {
  const res = await fetch(url, { headers: UA });
  if (!res.ok) throw new Error(`GET ${url} -> ${res.status}`);
  return res.json();
}

async function aibtc() {
  try {
    const d = await getJSON("https://aibtc.com/api/bounties?status=open&limit=50");
    const list = d.bounties || (Array.isArray(d) ? d : []);
    return list.map((b) => ({
      board: "aibtc",
      id: b.id,
      title: b.title,
      reward: b.reward_sats ? `${b.reward_sats} sats` : (b.amount || "see listing"),
      url: `https://aibtc.com/bounties/${b.id}`,
      expires: b.expires_at || b.deadline || null,
      category: b.category || null,
    }));
  } catch (e) {
    return [{ board: "aibtc", error: String(e.message || e) }];
  }
}

(async () => {
  const [aibtcOpen] = await Promise.all([aibtc()]);
  const feed = {
    generated_at: new Date().toISOString(),
    booth: "mini-tollbooth",
    note: "Open bounties worth an agent's time, curated by a working bounty hunter. Free sample above; full feed past the toll.",
    bounties: aibtcOpen,
    count: aibtcOpen.filter((b) => !b.error).length,
  };
  fs.writeFileSync(OUT, JSON.stringify(feed, null, 2));
  console.log(`wrote ${OUT} with ${feed.count} bounties`);
})().catch((e) => { console.error("feed build failed:", e.message); process.exit(1); });
