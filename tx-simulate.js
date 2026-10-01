// TrollBridge /tx-simulate lane — data layer (the $0 edition).
// Transaction dry-run ($0.10 protection tier): eth_call the exact tx against
// the latest block on public RPCs, extract the revert reason when it fails,
// estimate gas, and price the gas in native currency (and USD when a price
// feed answers). The $0.02 /tx-dryrun lane explains what a tx DOES; this
// lane answers the narrower, harder question: WILL IT GO THROUGH, and what
// will it cost?
//
// SIMULATION, NOT A GUARANTEE: state changes between simulation and mining,
// and a malicious contract can behave differently for the simulator than for
// the real sender. Never treat a clean simulation as proof of safety.
const UA = { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" };
const EVM_RPCS = {
  base: ["https://mainnet.base.org", "https://base.llamarpc.com"],
  ethereum: [
    "https://ethereum.public.blockpi.network/v1/rpc/public",
    "https://eth.llamarpc.com",
    "https://rpc.ankr.com/eth",
  ],
};
const COINGECKO_SIMPLE = "https://api.coingecko.com/api/v3/simple/price?ids=ethereum&vs_currencies=usd";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function isAddress(a) {
  return /^0x[0-9a-fA-F]{40}$/.test(a || "");
}
function isHexData(d) {
  return /^0x[0-9a-fA-F]*$/.test(d || "") && (d || "").length >= 2;
}
function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

async function rpcCall(rpcs, method, params, timeoutMs = 15000) {
  let lastErr = null;
  let sawJsonRpcError = null;
  for (const rpc of rpcs) {
    try {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      const res = await fetch(rpc, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...UA },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (!res.ok) throw new Error(`RPC ${rpc} -> ${res.status}`);
      const j = await res.json();
      if (j.error) {
        const err = new Error(j.error.message || "rpc error");
        err.rpcData = j.error.data;
        err.rpcCode = j.error.code;
        err.jsonRpc = true; // the node answered: the CALL failed, not the transport
        sawJsonRpcError = sawJsonRpcError || err;
        throw err;
      }
      return { ok: true, result: j.result, rpc };
    } catch (e) {
      lastErr = e;
    }
  }
  // If any node gave a proper JSON-RPC error, the call itself failed
  // (revert / insufficient funds) — that is a simulation result, not an
  // upstream outage.
  if (sawJsonRpcError) throw sawJsonRpcError;
  const err = new Error(lastErr ? lastErr.message : "all RPCs failed");
  err.upstream = true;
  throw err;
}

// Decode a standard Error(string) revert payload (0x08c379a0…).
function decodeRevertReason(data) {
  try {
    if (typeof data !== "string" || !data.startsWith("0x08c379a0")) return null;
    const lenHex = data.slice(8 + 64, 8 + 128);
    const len = parseInt(lenHex, 16);
    if (!Number.isFinite(len) || len <= 0 || len > 10000) return null;
    const strHex = data.slice(8 + 128, 8 + 128 + len * 2);
    return Buffer.from(strHex, "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "");
  } catch {
    return null;
  }
}

function extractRevertReason(err) {
  if (!err) return null;
  const direct = decodeRevertReason(err.rpcData);
  if (direct) return direct;
  const msg = String(err.message || "");
  const m = msg.match(/[Rr]everted(?: with reason string)?\s*['"]?([^'"]{1,200})/);
  if (m) return m[1].trim();
  if (/revert/i.test(msg)) return msg.slice(0, 200);
  return null;
}

async function ethUsd() {
  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 10000);
    const res = await fetch(COINGECKO_SIMPLE, { headers: UA, signal: ctrl.signal });
    clearTimeout(t);
    if (!res.ok) return null;
    const j = await res.json();
    return num(j && j.ethereum && j.ethereum.usd);
  } catch {
    return null;
  }
}

function parseValue(v) {
  if (v === undefined || v === null || v === "") return "0x0";
  const s = String(v).trim();
  if (/^0x[0-9a-fA-F]+$/.test(s)) return s;
  if (/^\d+$/.test(s)) return "0x" + BigInt(s).toString(16);
  throw badRequest("value must be wei as a decimal string or 0x… hex (default 0)");
}

async function simulateTx(to, data, from, value, chain) {
  const t = (to || "").trim();
  const d = (data || "").trim();
  const f = (from || "").trim();
  if (!isAddress(t)) throw badRequest("to must be a 0x… contract address (40 hex chars)");
  if (!isHexData(d)) throw badRequest("data must be 0x… hex calldata");
  if (!isAddress(f)) throw badRequest("from must be a 0x… wallet address (40 hex chars)");
  const ch = (chain || "base").toLowerCase();
  if (!EVM_RPCS[ch]) throw badRequest("chain must be base or ethereum");
  const v = parseValue(value);
  const rpcs = EVM_RPCS[ch];
  const txObj = { from: f, to: t, data: d, value: v };

  // 1. eth_call: will it go through?
  let callReverted = null;
  let revertReason = null;
  let callRpc = null;
  try {
    const r = await rpcCall(rpcs, "eth_call", [txObj, "latest"]);
    callRpc = r.rpc;
    callReverted = false;
  } catch (e) {
    if (e.upstream) throw new Error("upstream RPCs unreachable — try again shortly");
    callReverted = true;
    revertReason = extractRevertReason(e);
  }

  // 2. eth_estimateGas: what will it cost in gas units?
  let gasUnits = null;
  try {
    const r = await rpcCall(rpcs, "eth_estimateGas", [txObj]);
    gasUnits = num(r.result);
  } catch {
    // estimateGas fails on reverts too — already captured above; bonus only
  }

  // 3. eth_gasPrice → native cost.
  let gasPriceWei = null;
  try {
    const r = await rpcCall(rpcs, "eth_gasPrice", []);
    gasPriceWei = num(r.result);
  } catch {
    // bonus
  }

  let gasCost = null;
  if (gasUnits !== null && gasPriceWei !== null) {
    try {
      const costWei = BigInt(gasUnits) * BigInt(Math.round(gasPriceWei));
      const costEth = Number(costWei) / 1e18;
      gasCost = {
        gas_units: gasUnits,
        gas_price_gwei: +(gasPriceWei / 1e9).toFixed(4),
        cost_native: +costEth.toFixed(8),
        native_symbol: "ETH",
      };
      const usd = await ethUsd();
      if (usd) gasCost.cost_usd_approx = +((costEth * usd).toFixed(4));
    } catch {
      // arithmetic on weird values: leave gasCost null
    }
  }

  const verdict = callReverted === null ? "unknown" : callReverted ? "would-revert" : "would-succeed";
  const summary =
    verdict === "would-revert"
      ? `This transaction would REVERT${revertReason ? `: "${revertReason}"` : ""} — do not send it as-is. Simulation, not a guarantee.`
      : verdict === "would-succeed"
      ? `Simulation succeeded at the latest block${gasCost ? ` — estimated cost ${gasCost.cost_native} ETH${gasCost.cost_usd_approx !== undefined ? ` (~$${gasCost.cost_usd_approx})` : ""}` : ""}. State can change before mining — simulation, not a guarantee.`
      : "Simulation inconclusive — upstream RPCs did not return a usable result. Try again shortly.";

  return {
    lane: "/tx-simulate",
    chain,
    from: f,
    to: t,
    value_wei: v.startsWith("0x") ? BigInt(v).toString() : v,
    verdict,
    reverted: callReverted,
    revert_reason: revertReason,
    gas_estimate: gasCost,
    sources: ["public keyless RPCs (no key)", "coingecko keyless price (no key, usd estimate only)"],
    disclaimer: "Simulation, not a guarantee: mined state can differ from the simulated block, and hostile contracts can behave differently under simulation. A clean simulation is not proof of safety.",
    note: "Simulated against the latest block via eth_call. RPC used: " + (callRpc ? callRpc.replace(/^https?:\/\//, "").split("/")[0] : "n/a"),
  };
}

module.exports = { simulateTx, TX_SIMULATE_CHAINS: Object.keys(EVM_RPCS) };
