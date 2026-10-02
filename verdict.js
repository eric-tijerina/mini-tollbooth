// TrollBridge /verdict lane — the one-verdict flagship (data layer).
// One question, one machine-readable answer: is it safe for this wallet to
// touch this contract? Runs the full pre-transaction screen battery
// (honeypot + rug-score + contract-check, plus approval-risk when a wallet
// is given — same battery as /preflight) and compresses it into a single
// enum an agent can branch on:
//
//   PROCEED        — every screen came back clean.
//   CAUTION        — something needs eyes before money moves.
//   DO_NOT_PROCEED — a critical finding. Do not touch.
//
// NOT AN AUDIT: heuristic screens over public on-chain data. A PROCEED
// verdict means no screen fired — never a guarantee of safety. Verify
// independently before money moves.
const verdicts = require("./verdicts");

const VERDICT_MAP = {
  "cleared for takeoff": "PROCEED",
  "proceed with caution": "CAUTION",
  "do not touch": "DO_NOT_PROCEED",
};

async function verdict(address, chain, wallet) {
  const out = await verdicts.preflight(address, chain, wallet);
  const v = VERDICT_MAP[out.overall_verdict] || "CAUTION";
  const rf = out.riskiest_finding;
  const reason = v === "PROCEED"
    ? "Battery clean — no screen fired. Heuristic screens only, not an audit; never a guarantee of safety."
    : v === "DO_NOT_PROCEED"
    ? `DO NOT PROCEED: ${rf ? rf.title.toLowerCase() : "a critical finding"} (${rf ? rf.check : "battery"}). Heuristic screens, not an audit.`
    : `CAUTION: ${rf ? `${rf.title.toLowerCase()} (${rf.check})` : "a check needs eyes"} before money moves. Heuristic screens, not an audit.`;
  return {
    verdict: v,
    reason,
    address: out.address,
    chain: out.chain,
    wallet: out.wallet,
    riskiest_finding: rf,
    checks: out.checks,
    summary: out.summary,
    disclaimer: out.disclaimer,
    note: "Heuristic screens, not an audit. A PROCEED verdict means no screen fired — never a guarantee of safety. Verify independently before money moves.",
  };
}

module.exports = { verdict };
