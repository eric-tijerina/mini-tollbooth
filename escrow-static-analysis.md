# Static Analysis — TrollBridgeEscrow.sol

## ⚠️ NOT AN AUDIT

**This document is automated static analysis, not a security audit.**
It records the raw output of two automated tools (Slither and Aderyn) plus one
attempt at an external scanner. Automated tools find patterns, not vulnerabilities;
they produce false positives, and — more importantly — **absence of findings is not
absence of bugs**. Nothing here replaces a professional manual audit. Do not rely
on this document to claim the contract is safe.

- **Contract:** TrollBridgeEscrow.sol (92 lines, no imports, solc ^0.8.24)
- **On-chain:** `0x6b290f88b49eC73d954f05423a7F17020C5fDB70` (Base mainnet, Sourcify verified, full match)
- **What it does:** buyer deposits USDC → buyer calls `release()` (99% seller, 1% fee wallet)
  or buyer calls `refund()` anytime / anyone calls `refund()` after deadline. No admin keys, no upgrades.
- **Analyzed:** 2026-10-02 (CDT)

---

## Tooling

| Tool | Version | How run |
|---|---|---|
| Slither | **0.11.6** (`pip install slither-analyzer`, in `~/workspace/.venv`) | `slither TrollBridgeEscrow.sol --solc solc` |
| solc | **0.8.24** (commit `e11b9ed9.Linux.g++`, via `solc-select install 0.8.24` / `use 0.8.24`) | used by Slither for compilation |
| Aderyn | **0.6.8** (Cyfrin release `aderyn-v0.6.8`, `aderyn-x86_64-unknown-linux-gnu.tar.xz`; SHA256 `ffd6ca658962e211a3ac821c646f69c8e14bf1b1001cbfe091bcd4535a691e46` verified against release manifest) | `aderyn .` in `~/workspace/escrow` |

**Aderyn caveats (warts and all):**
- Aderyn compiled with its **bundled solc 0.8.33**, not 0.8.24. Severity/syntax findings are compiler-version-independent here, but the exact analysis target differed from the deployed build.
- Aderyn scanned the whole `~/workspace/escrow` directory — **2 files, nSLOC 100** — including `MockUSDC.sol`, a **test-only mock** (not deployed, not part of the escrow logic). MockUSDC-only findings (Missing Inheritance L-2, State-Variable-Could-Be-Constant L-4) are recorded below for completeness but are **irrelevant** to the production contract.
- Full Aderyn HTML/Markdown report saved at `~/workspace/escrow/report.md` (88 detectors ran).

---

## SLITHER — 8 findings (2 Medium, 6 Low)

### 1. `incorrect-equality` — Medium / High confidence
**Location:** `create()` line 55 — `require(escrows[jobId].state == State.NONE, "job exists")`
**What Slither thinks:** strict equality is dangerous (typically flagged because contract balance or similar values change unexpectedly).
**Plain read:** **False positive.** Comparing an enum field against its default `NONE` is the standard, correct uniqueness check here. The state can only become NON-NONE through this contract's own functions, and there is no path where an attacker flips the flag out from under the buyer. Does not matter.

### 2. `reentrancy-no-eth` — Medium / Medium confidence
**Location:** `create()` lines 54–70 — `usdc.transferFrom(...)` (line 60) happens **before** `escrows[jobId] = Escrow({...})` (lines 62–68).
**What Slither thinks:** external call before state write → reentrancy.
**Plain read:** **Matters as hygiene, not as a live hole.** Reentrancy would require the USDC token itself to call back into the contract during `transferFrom`. The deployed contract's `usdc` is immutable and points at real Base USDC, which does not do ERC777-style callbacks — no callback, no reentry. Worst-case with a malicious callback-ERC20 (e.g. if someone redeployed with a different token): a reentrant `create()` with the same `jobId` would overwrite the escrow record while pulling USDC twice — funds stuck in the contract, not stealable by the attacker. For THIS deployment: not exploitable. Still, the fix is trivial (write the escrow record before pulling USDC — proper checks-effects-interactions) and worth doing if the contract is ever redeployed.

### 3. `reentrancy-events` (×3) — Low / Medium confidence
**Locations:** `create()` (EscrowCreated emitted after `transferFrom`), `release()` (Released emitted after transfers), `refund()` (Refunded emitted after transfer).
**What Slither thinks:** events emitted after external calls can be observed in a "stale" state during reentry.
**Plain read:** **Informational noise.** Events don't move funds or change control flow. In `release()`/`refund()` the state is already `RELEASED`/`REFUNDED` before any transfer, so nothing a reentrant observer sees is actionable. Does not matter.

### 4. `timestamp` (×3) — Low / Medium confidence
**Locations:** `create()`, `release()`, `refund()` — flagged because the functions use `block.timestamp` (the deadline check) and contain `require` comparisons.
**What Slither thinks:** miners/validators can manipulate `block.timestamp`.
**Plain read:** **Does not matter.** Only `refund()`'s `block.timestamp >= e.deadline` gate is a real timestamp dependency, and the timeout window is 1 hour to 30 days — Base block times (~2s) can't be skewed by any amount that affects an hour-scale deadline. Textbook noise for this contract.

---

## ADERYN — 7 findings (1 High, 6 Low)

Only findings in `TrollBridgeEscrow.sol` are analyzed below. `MockUSDC.sol` findings (L-2 Missing Inheritance, L-4 State Variable Could Be Constant) are test-mock trivia — not deployed, ignored.

### H-1. Reentrancy: State change after external call — High
**Location:** `create()` line 60 (`transferFrom` before state write).
**Plain read:** Same underlying pattern as Slither finding #2. The **"High" label is overstated for this contract** — it assumes a callback-capable token, and the immutable `usdc` here is real USDC on Base. In practice this is a Medium-at-best hygiene issue (see Slither #2). Honest severity for THIS deployment: Medium, unexploitable with the configured token.

### L-1. Large Numeric Literal — Low
**Location:** line 77 — `/ 10000`.
**Plain read:** Style nit ("use `1e4`"). Does not matter.

### L-3. PUSH0 Opcode — Low (2 instances, both files)
**Location:** `pragma solidity ^0.8.24` — solc ≥0.8.20 targets Shanghai by default, emitting PUSH0.
**Plain read:** **Moot.** The contract is already deployed and verified on Base, which supports PUSH0. Does not matter.

### L-5. Unsafe ERC20 Operation — Low (4 instances: lines 60, 79, 80, 89)
**Location:** raw `usdc.transferFrom` / `usdc.transfer` calls; Aderyn suggests OpenZeppelin SafeERC20.
**Plain read:** **Noise for this contract.** Each call is wrapped in `require(...)` on the boolean return value, which handles standard ERC20s (incl. Base USDC) correctly. The non-standard-ERC20 concern (tokens that revert instead of returning false) is handled fine too — a revert propagates. Does not matter.

### L-6. Unspecific Solidity Pragma — Low
**Location:** line 2 — `pragma solidity ^0.8.24` (caret, not pinned).
**Plain read:** Style nit. The deployed bytecode was compiled with 0.8.24 and Sourcify shows a full match; nothing to do post-deployment. Does not matter.

---

## Aggregate severity count (production contract only)

| Source | High | Medium | Low | Informational/Style |
|---|---|---|---|---|
| Slither 0.11.6 | 0 | 2 | 6 | (all 8 listed above) |
| Aderyn 0.6.8 | 1* | 0 | 5 | L-2/L-4 excluded (test mock) |
| de.fi Scanner | — | — | — | **not obtainable** (see below) |

\* Aderyn's single High is the `create()` reentrancy pattern — assessed above as
unexploitable against this deployment's immutable Base-USDC configuration. Honest
label: **Medium**.

**The one finding worth acting on:** the checks-effects-interactions ordering in
`create()` — write the escrow record *before* pulling USDC. It's not exploitable
today, but it's a one-line-hardening item for any redeploy, and it's exactly the
class of thing automated screens exist to catch.

**One reviewer note the tools missed (human read, not a tool finding):** fee
rounding — `fee = (amount * 100) / 10000` truncates, so for tiny escrows (<100 raw
units ≈ <0.0001 USDC) the fee rounds to zero and the seller gets the whole amount.
That is dust-level and benign (fee is a cost, not a lock), noted here only for the
honest ledger. No stuck-funds path exists: every terminal path pays out 100% of
`amount` (99%+1% on release, 100% on refund).

---

## de.fi Scanner — NOT OBTAINED

- **Target:** `0x6b290f88b49eC73d954f05423a7F17020C5fDB70` on Base.
- **Attempted:** web fetch of the scanner UI (form-based landing page confirmed the tool exists and supports Base); then fetch of the contract-scan page
  `https://de.fi/scanner/contract/0x6b290f88b49eC73d954f05423a7F17020C5fDB70?chainId=base`
  (URL pattern documented in multiple third-party sources).
- **Result:** the contract-scan page is JS-rendered and the text fetch returned
  "page had no extractable content" (fetch-level failure, not an auth wall). No
  score, no color, no link content could be recorded.
- **Not retried:** per operating rules, a blocked fetch is not retried through
  alternate endpoints. This needs a **live browser with JavaScript** (or a
  logged-in de.fi session) — flagged for the parent to delegate to a
  browser-capable agent. No account was created, $0 spent.

---

## ⚠️ FOOTER — NOT AN AUDIT (repeated on purpose)

Automated static analysis is a screen, not a security review. This report lists
pattern matches from Slither 0.11.6 and Aderyn 0.6.8, filtered through a
contract-specific read. It does **not** establish that the contract is safe, and it
does not constitute a professional audit. The de.fi Scanner check could not be
completed and remains an open item. Before any material funds flow through this
escrow, get a human auditor to look at it.
