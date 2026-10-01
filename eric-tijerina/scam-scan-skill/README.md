# scam-scan

Smell-test any money opportunity — bounty, arena, airdrop, investment, paid gig —
for scam signals **before anyone spends a cent**. Scores red flags, does the
prize-vs-deposit math, returns a plain verdict: `CLEAN`, `CAUTION`, or `LIKELY SCAM`.

Built for AI agents with wallets: the opportunities coming at agents right now
(arenas, launchpads, "guaranteed" airdrops) are designed to separate an agent
from its funds. This is the checklist that keeps the wallet shut.

## Install

This is an [agent skill](https://github.com/anthropics/skills) — a `SKILL.md`
plus helpers any coding agent can follow. Copy the repo into your agent's skills
directory, e.g.:

```bash
git clone https://github.com/eric-tijerina/scam-scan-skill.git
chmod +x scam-scan-skill/bin/fetch-listing   # web upload can't set the exec bit
cp -r scam-scan-skill ~/.config/agent/skills/scam-scan   # path depends on your agent
```

`bin/fetch-listing` needs only `curl` and `python3` — no API keys, no dependencies.

## Usage

Ask your agent: *"Is this a scam?" / "Scan this opportunity" / "Smell test this bounty"*
and point it at the listing URL. The skill will:

1. **Gather the facts** — pull the listing page (`bin/fetch-listing <url>`),
   or read the announcement/terms directly. What does it promise? What must you
   put in (money, sign-ins, posts, time)? Who holds deposited funds? How are
   winners chosen? Is there proof of past payouts?
2. **Run the 10-flag checklist** (`references/red-flags.md`) — mark each flag
   HIT or CLEAR with the evidence quote.
3. **Do the math** — total cost to enter (deposits + fees + time) vs. your
   realistic share of the prize. If total player deposits dwarf the prizes, it
   says so with numbers.
4. **Check the sponsor separately** — a legit platform does not vouch for the
   sponsor. Vet them on their own track record.
5. **Return the verdict** — `CLEAN` (0–1 flags), `CAUTION` (2–3), or
   `LIKELY SCAM` (4+). One line recommendation: enter, enter-with-limits, or
   walk away — naming the single biggest reason.

Operating rules: the scan itself never spends money — no deposits, sign-ins, or
wallet connections to investigate. "Not an outright scam" is not a pass: bad
economics (pay-to-play with negative expected value) earns CAUTION or worse on
its own. When in doubt between CAUTION and LIKELY SCAM, pick LIKELY SCAM —
false alarms are free, lost deposits aren't.

## Worked example: Steve Agent Arena (2026-10-01)

- **Promise:** 500 USDC prize pool (250/150/100), "launch your AI agent."
- **Cost:** human sign-in with Google/X, a post from your X account, fund
  ~50 USDC + ~1 SOL (~$200+) into their arena wallet, minimum 5 qualifying trades.
- **Flags hit (5 of 10):** #1 pay-to-play economics (~60 players × ~$200 ≈
  $12,000 locked up chasing $500 in prizes), #2 someone else holds your money,
  #3 subjective judging ("creative use" 30%), #4 urgency pressure (deadline
  tonight), #7 reputation laundering (legit platform, separate unknown sponsor).
- **Verdict: LIKELY SCAM** — bad-economics variant, not an outright rug.
  Recommendation: walk away. The math doesn't work at any skill level.

Full checklist and scoring rules: [`references/red-flags.md`](references/red-flags.md).

## Don't want to run it yourself? Use the hosted lane

The same checklist runs as a hosted pay-per-call endpoint — no skill install needed:

- `GET https://mini-tollbooth.onrender.com/scam-scan?url=<listing-url>` — **$5.00 per scan**, paid in USDC on Base via x402
- `GET https://mini-tollbooth.onrender.com/scam-scan-subscribe` — **$30.00 for 30 days** of unlimited scans (your payment receipt is your pass; nothing auto-renews)

That's the honest pricing — $5 a scan or $30 a month, no subscription traps, no
upsells. The skill above is free and open source; the hosted lane is for agents
that would rather pay per scan than wire up the skill themselves.

## License

MIT. Use it, fork it, ship it in your own agent stack.
