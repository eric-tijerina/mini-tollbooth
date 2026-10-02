// TrollBridge /escrow lane — data layer.
// Agent-to-agent escrow coordination over x402, LIVE on Base mainnet. One
// agent (buyer) locks USDC in a minimal escrow contract; the other (seller)
// delivers off-chain; the buyer releases (1% fee to the toll wallet) or
// refunds after the timeout. Non-custodial: this lane never touches funds —
// it validates deal terms, mints job IDs, hands back the exact calldata the
// buyer's wallet signs, and reads escrow state on-chain.
//
// Honest framing: the contract is intentionally tiny (no admin keys, no
// upgradeability, no owner) and it is NOT audited — it is a minimal escrow,
// not a reviewed vault. It was lifecycle-tested 16/16 on a local EVM and
// verified with a live $0.01 mainnet deal (seller received $0.0099, the 1%
// fee landed in the toll wallet). Real USDC moves here — only escrow what
// you can afford to have locked until release or refund.
//
// No network calls except escrowStatus, which does one read-only eth_call
// to a public Base RPC. No dependencies.

const crypto = require("crypto");

// ---- chain constants: Base mainnet ----
const NETWORK = "base";
const CHAIN_ID = 8453;
const BASE_RPC = "https://mainnet.base.org";
const BASE_EXPLORER = "https://basescan.org";
// Live escrow contract, deployed 2026-10-02, verified with a real $0.01 deal.
const ESCROW_CONTRACT = "0x6b290f88b49eC73d954f05423a7F17020C5fDB70";
// USDC on Base (6 decimals).
const USDC = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913";
const FEE_WALLET = "0x8BE8D056d5F0bEF850eC9ed5C4a8d647cBE896C0";
const FEE_BPS = 100; // 1%
const USDC_DECIMALS = 6;

// Function selectors (precomputed; contract ABI is fixed).
const SEL_CREATE = "631325e9"; // create(bytes32,address,uint256,uint256)
const SEL_RELEASE = "67d42a8b"; // release(bytes32)
const SEL_REFUND = "7249fbb6"; // refund(bytes32)
const SEL_ESCROWS = "2d83549c"; // escrows(bytes32)
const SEL_APPROVE = "095ea7b3"; // approve(address,uint256)

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function isAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}
function isBytes32(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{64}$/.test(s);
}
function hexPad32(hex) {
  return hex.toLowerCase().replace(/^0x/, "").padStart(64, "0");
}
function uint256Hex(n) {
  return BigInt(n).toString(16).padStart(64, "0");
}

// ---- free: how it works ----
function escrowTerms() {
  return {
    live: true,
    network: NETWORK,
    chain_id: CHAIN_ID,
    contract_address: ESCROW_CONTRACT,
    contract_status: "deployed on Base mainnet — verified with a live $0.01 deal (seller received $0.0099, 1% fee to the toll wallet), 2026-10-02",
    explorer: BASE_EXPLORER + "/address/" + ESCROW_CONTRACT,
    usdc: USDC,
    usdc_decimals: USDC_DECIMALS,
    fee: "1% of the escrowed amount on release, paid to the TrollBridge toll wallet (" + FEE_WALLET + "). Refunds are fee-free.",
    fee_wallet: FEE_WALLET,
    how_it_works: [
      "1. Buyer calls GET /escrow?action=create&seller=0x…&amount_usd=…&timeout_hours=… — gets a job_id plus the exact approve + create calldata to sign.",
      "2. Buyer signs two transactions from their own wallet: approve(USDC, escrow contract, amount), then create(job_id, seller, amount, timeout) on the escrow contract. Real USDC locks in the contract.",
      "3. Seller delivers the work off-chain.",
      "4. Buyer signs release(job_id): 99% goes to the seller, 1% to the toll wallet.",
      "5. If the seller never delivers, the buyer can sign refund(job_id) at any time — or ANYONE can trigger the refund after the deadline passes.",
    ],
    trust_model: [
      "Non-custodial: this lane never holds funds and cannot move them. Only the contract moves USDC, only between buyer, seller, and the fixed fee wallet.",
      "No admin keys, no upgradeability, no owner, no pausing — the contract cannot be changed after deployment.",
      "release() is buyer-only. refund() is buyer-anytime, or anyone-after-deadline.",
      "NOT AUDITED — this is a minimal escrow contract, not a reviewed vault. It passed 16/16 lifecycle checks on a local EVM (create→release, create→refund, create→timeout→refund, all revert gates) plus one live mainnet deal with real funds. Treat it accordingly.",
    ],
    limits: [
      "REAL FUNDS on Base mainnet. Only escrow what you can afford to have locked until you release or refund.",
      "Timeouts: 1 hour minimum, 30 days maximum.",
      "Sanity cap: $10,000 per deal through this lane.",
      "This lane coordinates deals — it does not judge whether the seller delivered. Release means the buyer is satisfied.",
    ],
    actions: {
      create: "GET /escrow?action=create&seller=0x…&amount_usd=1.5&timeout_hours=48&job=<optional label> ($0.05)",
      status: "GET /escrow?action=status&job_id=0x… ($0.05, on-chain read)",
      terms: "GET /escrow/terms (free, this document)",
    },
  };
}

// ---- tolled: mint a deal ----
function escrowCreate(q) {
  const seller = String(q.seller || "").trim();
  if (!isAddress(seller)) {
    throw badRequest("missing/invalid param: seller must be a 0x Ethereum address (usage: GET /escrow?action=create&seller=0x…&amount_usd=1.5&timeout_hours=48&job=<label>)");
  }
  if (/^0x0{40}$/i.test(seller)) throw badRequest("seller cannot be the zero address");
  const amountUsd = Number(q.amount_usd);
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) {
    throw badRequest("missing/invalid param: amount_usd must be a positive number (USDC, 6 decimals)");
  }
  if (amountUsd > 10000) throw badRequest("amount_usd exceeds the $10,000 per-deal sanity cap");
  const timeoutHours = Number(q.timeout_hours);
  if (!Number.isFinite(timeoutHours) || timeoutHours < 1 || timeoutHours > 720) {
    throw badRequest("missing/invalid param: timeout_hours must be 1–720 (contract enforces 1h–30d)");
  }
  const jobLabel = String(q.job || "").slice(0, 120);

  // Amount math in raw USDC units (6 decimals), integer only.
  const amountRaw = BigInt(Math.round(amountUsd * 1e6));
  const feeRaw = (amountRaw * BigInt(FEE_BPS)) / 10000n;
  const sellerRaw = amountRaw - feeRaw;
  const fmt = (raw) => (Number(raw) / 1e6).toFixed(6).replace(/\.?0+$/, "") || "0";
  const timeoutSeconds = Math.round(timeoutHours * 3600);

  const jobId = "0x" + crypto.randomBytes(32).toString("hex");

  // Exact calldata the buyer's wallet signs (hand-encoded, no deps).
  // approve is called ON the USDC token, spender = the escrow contract.
  const approveCalldata =
    "0x" + SEL_APPROVE + hexPad32(ESCROW_CONTRACT) + uint256Hex(amountRaw);
  const createCalldata =
    "0x" + SEL_CREATE + hexPad32(jobId) + hexPad32(seller) + uint256Hex(amountRaw) + uint256Hex(timeoutSeconds);
  const releaseCalldata = "0x" + SEL_RELEASE + hexPad32(jobId);
  const refundCalldata = "0x" + SEL_REFUND + hexPad32(jobId);

  return {
    live: true,
    action: "create",
    job_id: jobId,
    job_label: jobLabel || null,
    network: NETWORK,
    chain_id: CHAIN_ID,
    contract_address: ESCROW_CONTRACT,
    contract_status: "deployed on Base mainnet — the calldata below is signable now",
    usdc: USDC,
    buyer: null, // whoever signs create() becomes the buyer on-chain
    seller: seller.toLowerCase(),
    amount_usdc: fmt(amountRaw),
    amount_raw: amountRaw.toString(),
    fee_bps: FEE_BPS,
    fee_usdc: fmt(feeRaw),
    seller_receives_usdc: fmt(sellerRaw),
    timeout_hours: timeoutHours,
    timeout_seconds: timeoutSeconds,
    real_funds: "REAL USDC on Base mainnet — signing locks actual funds in the escrow contract.",
    deposit_steps: [
      "1. From the BUYER wallet, send approve() to the USDC token (" + USDC + ") for the escrow contract, amount " + amountRaw.toString() + " — calldata below.",
      "2. From the BUYER wallet, send create(job_id, seller, amount, timeout) to the escrow contract " + ESCROW_CONTRACT + " — calldata below. This pulls the USDC in and starts the clock.",
      "3. Seller delivers off-chain. Buyer then sends release(job_id) — or refund(job_id) if the deal dies (anyone can refund after the deadline).",
    ],
    calldata: {
      note: "All values hex-encoded. job_id, seller, amounts, and timeout are already filled in — sign as-is from the buyer wallet. approve goes TO the USDC token; create/release/refund go TO the escrow contract.",
      approve_usdc: approveCalldata,
      create_escrow: createCalldata,
      release_to_seller: releaseCalldata,
      refund_to_buyer: refundCalldata,
    },
  };
}

// ---- tolled: on-chain status ----
async function rpcCall(method, params, timeoutMs = 12000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(BASE_RPC, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error("base rpc " + res.status);
    const j = await res.json();
    if (j.error) throw new Error("base rpc: " + (j.error.message || "unknown"));
    return j.result;
  } finally {
    clearTimeout(t);
  }
}

async function escrowStatus(q) {
  const jobId = String(q.job_id || "").trim();
  if (!isBytes32(jobId)) {
    throw badRequest("missing/invalid param: job_id must be a 0x bytes32 id from a create call (usage: GET /escrow?action=status&job_id=0x…)");
  }
  const base = {
    live: true,
    action: "status",
    job_id: jobId.toLowerCase(),
    network: NETWORK,
    chain_id: CHAIN_ID,
    contract_address: ESCROW_CONTRACT,
    explorer: BASE_EXPLORER + "/address/" + ESCROW_CONTRACT,
  };
  let raw;
  try {
    raw = await rpcCall("eth_call", [{ to: ESCROW_CONTRACT, data: "0x" + SEL_ESCROWS + hexPad32(jobId) }, "latest"]);
  } catch (e) {
    const err = new Error("status read failed — Base RPC unreachable, try again shortly");
    err.statusCode = 502;
    throw err;
  }
  const words = (raw || "0x").replace(/^0x/, "");
  if (words.length < 320) {
    const err = new Error("status read failed — unexpected contract response");
    err.statusCode = 502;
    throw err;
  }
  const buyer = "0x" + words.slice(24, 64);
  const seller = "0x" + words.slice(64 + 24, 128);
  const amount = BigInt("0x" + words.slice(128, 192));
  const deadline = Number(BigInt("0x" + words.slice(192, 256)));
  const stateN = Number(BigInt("0x" + words.slice(256, 320)));
  const states = ["NONE", "FUNDED", "RELEASED", "REFUNDED"];
  const nowS = Math.floor(Date.now() / 1000);
  return {
    ...base,
    state: states[stateN] || "UNKNOWN",
    buyer: buyer.toLowerCase(),
    seller: seller.toLowerCase(),
    amount_usdc: (Number(amount) / 1e6).toString(),
    amount_raw: amount.toString(),
    deadline_unix: deadline || null,
    deadline_iso: deadline ? new Date(deadline * 1000).toISOString() : null,
    seconds_until_deadline: deadline ? Math.max(0, deadline - nowS) : null,
    refund_open_to_anyone: stateN === 1 && deadline ? nowS >= deadline : false,
    fee_usdc: stateN === 2 ? (Number((amount * BigInt(FEE_BPS)) / 10000n) / 1e6).toString() : null,
  };
}

module.exports = { escrowTerms, escrowCreate, escrowStatus };
