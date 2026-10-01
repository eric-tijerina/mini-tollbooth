// TrollBridge /tx-plain-english lane — data layer (the $0 edition).
// Decodes a raw SIGNED Ethereum-style transaction LOCALLY: a minimal RLP
// decoder plus a bundled 4-byte selector table. No network calls, no cache.
// The sender is NEVER recovered — ecrecover is deliberately skipped and the
// response labels it as not recovered.
//
// Wiring note: server.js mounts this at GET /tx-plain-english?tx=0x…&chain=base.
// Pricing ($0.02) is handled by the server's x402 layer, not here.

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- minimal RLP decoder (~40 lines) ----
function rlpReadLen(buf, off, llen) {
  if (off + llen > buf.length) throw new Error("rlp overrun");
  let n = 0n;
  for (let i = 0; i < llen; i++) n = (n << 8n) | BigInt(buf[off + i]);
  if (n > Number.MAX_SAFE_INTEGER) throw new Error("rlp length too big");
  return Number(n);
}
function rlpDecode(buf, off) {
  if (off >= buf.length) throw new Error("rlp overrun");
  const b = buf[off];
  if (b < 0x80) return { item: buf.subarray(off, off + 1), off: off + 1 };
  if (b < 0xb8) {
    const len = b - 0x80;
    return { item: buf.subarray(off + 1, off + 1 + len), off: off + 1 + len };
  }
  if (b < 0xc0) {
    const llen = b - 0xb7;
    const len = rlpReadLen(buf, off + 1, llen);
    return { item: buf.subarray(off + 1 + llen, off + 1 + llen + len), off: off + 1 + llen + len };
  }
  const decodeList = (start, len) => {
    const items = [];
    let p = start;
    const end = start + len;
    if (end > buf.length) throw new Error("rlp overrun");
    while (p < end) {
      const r = rlpDecode(buf, p);
      items.push(r.item);
      p = r.off;
    }
    if (p !== end) throw new Error("bad rlp list");
    return items;
  };
  if (b < 0xf8) return { item: decodeList(off + 1, b - 0xc0), off: off + 1 + (b - 0xc0) };
  const llen = b - 0xf7;
  const len = rlpReadLen(buf, off + 1, llen);
  return { item: decodeList(off + 1 + llen, len), off: off + 1 + llen + len };
}

// ---- small helpers ----
function big(buf) {
  if (!buf || buf.length === 0) return 0n;
  return BigInt("0x" + Buffer.from(buf).toString("hex"));
}
function addrOf(word) {
  return "0x" + Buffer.from(word).subarray(-20).toString("hex");
}
function uintOf(word) {
  return big(word).toString(); // decimal string
}
function fmtUnits(wei, decimals) {
  const neg = wei < 0n;
  const d = (neg ? -wei : wei).toString().padStart(decimals + 1, "0");
  const i = d.slice(0, d.length - decimals);
  const frac = d.slice(d.length - decimals).replace(/0+$/, "");
  return (neg ? "-" : "") + i + (frac ? "." + frac : "");
}
function shortAddr(a) {
  return a ? a.slice(0, 6) + "…" + a.slice(-4) : a;
}
const MAX_UINT256 = (1n << 256n) - 1n;

// Decode a dynamic address[] given its offset word (relative to calldata body).
function decodeAddressArray(body, offsetWord) {
  const start = Number(big(offsetWord));
  if (start < 0 || start + 32 > body.length) throw new Error("bad offset");
  const len = Number(big(body.subarray(start, start + 32)));
  if (len > 256) throw new Error("array too long");
  const out = [];
  for (let i = 0; i < len; i++) {
    const w = body.subarray(start + 32 + i * 32, start + 64 + i * 32);
    if (w.length < 32) throw new Error("bad array");
    out.push(addrOf(w));
  }
  return out;
}
// Decode dynamic bytes given its offset word (relative to calldata body).
function decodeBytes(body, offsetWord) {
  const start = Number(big(offsetWord));
  if (start < 0 || start + 32 > body.length) throw new Error("bad offset");
  const len = Number(big(body.subarray(start, start + 32)));
  const end = start + 32 + len;
  if (end > body.length) throw new Error("bad bytes");
  return Buffer.from(body.subarray(start + 32, end));
}
function word(body, i) {
  const w = body.subarray(i * 32, i * 32 + 32);
  if (w.length < 32) throw new Error("calldata too short");
  return w;
}

// ---- selector table (each entry: name, signature, decode(body)->{params, sentences}) ----
function tokenAmountNote() {
  return "token decimals unknown offline — amount shown in raw units and assuming 18 decimals";
}
const SELECTORS = {
  a9059cbb: {
    name: "transfer",
    signature: "transfer(address,uint256)",
    decode(body, ctx) {
      const to = addrOf(word(body, 0));
      const amount = uintOf(word(body, 1));
      return {
        params: { to, amount_raw: amount, amount_assuming_18dp: fmtUnits(BigInt(amount), 18), amount_note: tokenAmountNote() },
        sentences: [
          `Calls transfer() on the token contract at ${ctx.to}: sends ${fmtUnits(BigInt(amount), 18)} tokens (raw: ${amount}) to ${to}.`,
        ],
      };
    },
  },
  "095ea7b3": {
    name: "approve",
    signature: "approve(address,uint256)",
    decode(body, ctx) {
      const spender = addrOf(word(body, 0));
      const amount = BigInt(uintOf(word(body, 1)));
      const unlimited = amount === MAX_UINT256;
      return {
        params: { spender, amount_raw: amount.toString(), unlimited, amount_note: unlimited ? null : tokenAmountNote() },
        sentences: unlimited
          ? [`Approves ${spender} to spend UNLIMITED tokens from this contract on your behalf — a compromised spender can drain this token.`]
          : [`Approves ${spender} to spend up to ${fmtUnits(amount, 18)} tokens (raw: ${amount}) from this contract on your behalf.`],
        flags: unlimited ? ["unlimited-approval"] : [],
      };
    },
  },
  "23b872dd": {
    name: "transferFrom",
    signature: "transferFrom(address,address,uint256)",
    decode(body, ctx) {
      const from = addrOf(word(body, 0));
      const to = addrOf(word(body, 1));
      const amount = uintOf(word(body, 2));
      return {
        params: { from, to, amount_raw: amount, amount_assuming_18dp: fmtUnits(BigInt(amount), 18), amount_note: tokenAmountNote() },
        sentences: [
          `Calls transferFrom() on the token contract at ${ctx.to}: moves ${fmtUnits(BigInt(amount), 18)} tokens (raw: ${amount}) from ${from} to ${to}.`,
        ],
      };
    },
  },
  "38ed1739": {
    name: "swapExactTokensForTokens",
    signature: "swapExactTokensForTokens(uint256,uint256,address[],address,uint256)",
    decode(body, ctx) {
      const amountIn = uintOf(word(body, 0));
      const amountOutMin = uintOf(word(body, 1));
      const path = decodeAddressArray(body, word(body, 2));
      const to = addrOf(word(body, 3));
      return {
        params: { amount_in_raw: amountIn, amount_out_min_raw: amountOutMin, path, to, amount_note: tokenAmountNote() },
        sentences: [
          `Swaps exactly ${fmtUnits(BigInt(amountIn), 18)} input tokens (raw: ${amountIn}) for at least ${fmtUnits(BigInt(amountOutMin), 18)} output tokens (raw: ${amountOutMin}) via ${path.length ? shortAddr(path[0]) + " → " + shortAddr(path[path.length - 1]) : "unknown path"} on the DEX at ${ctx.to}, delivered to ${to}.`,
        ],
      };
    },
  },
  "7ff36ab5": {
    name: "swapExactETHForTokens",
    signature: "swapExactETHForTokens(uint256,address[],address,uint256)",
    decode(body, ctx) {
      const amountOutMin = uintOf(word(body, 0));
      const path = decodeAddressArray(body, word(body, 1));
      const to = addrOf(word(body, 2));
      return {
        params: { native_in_wei: ctx.valueWei, amount_out_min_raw: amountOutMin, path, to, amount_note: tokenAmountNote() },
        sentences: [
          `Swaps ${fmtUnits(BigInt(ctx.valueWei), 18)} ETH for at least ${fmtUnits(BigInt(amountOutMin), 18)} tokens (raw: ${amountOutMin}) via ${path.length ? shortAddr(path[0]) + " → " + shortAddr(path[path.length - 1]) : "unknown path"} on the DEX at ${ctx.to}, delivered to ${to}.`,
        ],
      };
    },
  },
  "18cbafe5": {
    name: "swapExactTokensForETH",
    signature: "swapExactTokensForETH(uint256,uint256,address[],address,uint256)",
    decode(body, ctx) {
      const amountIn = uintOf(word(body, 0));
      const amountOutMin = uintOf(word(body, 1));
      const path = decodeAddressArray(body, word(body, 2));
      const to = addrOf(word(body, 3));
      return {
        params: { amount_in_raw: amountIn, min_eth_out_wei: amountOutMin, path, to, amount_note: tokenAmountNote() },
        sentences: [
          `Swaps exactly ${fmtUnits(BigInt(amountIn), 18)} input tokens (raw: ${amountIn}) for at least ${fmtUnits(BigInt(amountOutMin), 18)} ETH (raw wei: ${amountOutMin}) via ${path.length ? shortAddr(path[0]) + " → " + shortAddr(path[path.length - 1]) : "unknown path"} on the DEX at ${ctx.to}, delivered to ${to}.`,
        ],
      };
    },
  },
  d0e30db0: {
    name: "deposit",
    signature: "deposit() [WETH-style wrap]",
    decode(body, ctx) {
      return {
        params: { wrapped_wei: ctx.valueWei },
        sentences: [`Wraps ${fmtUnits(BigInt(ctx.valueWei), 18)} ETH into WETH at ${ctx.to} (deposit() with native value).`],
      };
    },
  },
  "2e1a7d4d": {
    name: "withdraw",
    signature: "withdraw(uint256) [WETH-style unwrap]",
    decode(body, ctx) {
      const wad = uintOf(word(body, 0));
      return {
        params: { wad_raw: wad, wad_eth: fmtUnits(BigInt(wad), 18) },
        sentences: [`Unwraps ${fmtUnits(BigInt(wad), 18)} WETH back into ETH at ${ctx.to}.`],
      };
    },
  },
  "414bf389": {
    name: "exactInputSingle",
    signature: "exactInputSingle((address,address,uint24,address,uint256,uint256,uint160)) [Uniswap V3]",
    decode(body, ctx) {
      const tokenIn = addrOf(word(body, 0));
      const tokenOut = addrOf(word(body, 1));
      const fee = Number(big(word(body, 2)));
      const recipient = addrOf(word(body, 3));
      const amountIn = uintOf(word(body, 4));
      const amountOutMin = uintOf(word(body, 5));
      return {
        params: { token_in: tokenIn, token_out: tokenOut, fee_tier: fee, recipient, amount_in_raw: amountIn, amount_out_min_raw: amountOutMin, amount_note: tokenAmountNote() },
        sentences: [
          `Uniswap V3 single-hop swap: exactly ${fmtUnits(BigInt(amountIn), 18)} input tokens (raw: ${amountIn}) of ${shortAddr(tokenIn)} for at least ${fmtUnits(BigInt(amountOutMin), 18)} of ${shortAddr(tokenOut)} (raw: ${amountOutMin}), fee tier ${fee / 10000}%, to ${recipient}.`,
        ],
      };
    },
  },
  c04b8d59: {
    name: "exactInput",
    signature: "exactInput((bytes,address,uint256,uint256,uint256)) [Uniswap V3]",
    decode(body, ctx) {
      const structOff = Number(big(word(body, 0)));
      const base = structOff;
      const pathBytes = decodeBytes(body.subarray(base), body.subarray(base, base + 32));
      const recipient = addrOf(body.subarray(base + 32, base + 64));
      const amountIn = big(body.subarray(base + 64, base + 96)).toString();
      const amountOutMin = big(body.subarray(base + 96, base + 128)).toString();
      return {
        params: { path_hex: "0x" + pathBytes.toString("hex"), path_len_bytes: pathBytes.length, recipient, amount_in_raw: amountIn, amount_out_min_raw: amountOutMin, amount_note: tokenAmountNote() },
        sentences: [
          `Uniswap V3 multi-hop swap: exactly ${fmtUnits(BigInt(amountIn), 18)} input tokens (raw: ${amountIn}) for at least ${fmtUnits(BigInt(amountOutMin), 18)} output tokens (raw: ${amountOutMin}) along a ${pathBytes.length}-byte encoded path, to ${recipient}.`,
        ],
      };
    },
  },
  b3e26c0e: {
    name: "fulfillOrder",
    signature: "fulfillOrder(...) [Seaport NFT marketplace]",
    decode() {
      return {
        params: { note: "Seaport order struct — decoded best-effort (name only); full order fields not decoded offline" },
        sentences: ["Fulfills a Seaport marketplace order (NFT buy/sell/listing fill) — decoded by name only; inspect the raw calldata for order details."],
      };
    },
  },
  "3593564c": {
    name: "execute",
    signature: "execute(...) [Permit2 batch]",
    decode() {
      return {
        params: { note: "Permit2 batch execution — decoded by name only; individual approvals/transfers inside the batch are not decoded offline" },
        sentences: ["Executes a Permit2 batch (batched token approvals/transfers) — decoded by name only; the inner actions are not decoded offline."],
      };
    },
  },
  ac9650d8: {
    name: "multicall",
    signature: "multicall(bytes[]) [Uniswap V3]",
    decode(body) {
      let inner = [];
      try {
        const blob = decodeBytes(body, word(body, 0));
        const count = Number(big(blob.subarray(0, 32)));
        if (count > 32) throw new Error("too many");
        for (let i = 0; i < count; i++) {
          const off = Number(big(blob.subarray(32 + i * 32, 64 + i * 32)));
          const len = Number(big(blob.subarray(off, off + 32)));
          const call = blob.subarray(off + 32, off + 32 + len);
          const sel = call.length >= 4 ? call.subarray(0, 4).toString("hex") : null;
          inner.push({ selector: sel ? "0x" + sel : null, name: (sel && SELECTORS[sel] ? SELECTORS[sel].name : "unknown") });
        }
      } catch {
        inner = [{ selector: null, name: "undecodable" }];
      }
      return {
        params: { inner_calls: inner },
        sentences: [
          `Batches ${inner.length} inner call(s) via multicall(): ${inner.map((c) => c.name + (c.selector ? ` (${c.selector})` : "")).join(", ")}.`,
        ],
      };
    },
  },
};

// ---- main entry ----
const EXPLORERS = { base: "https://basescan.org/tx/", ethereum: "https://etherscan.io/tx/" };

function explainTx(rawTx, chain) {
  const ch = (chain || "base").toLowerCase();
  if (!EXPLORERS[ch]) throw badRequest("chain must be base or ethereum");

  let hex = String(rawTx || "").trim();
  if (!/^0x/i.test(hex)) hex = "0x" + hex;
  if (!/^0x[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0 || hex.length < 10) {
    throw badRequest("tx must be a 0x-prefixed hex string of a raw signed transaction");
  }
  const buf = Buffer.from(hex.slice(2), "hex");

  let type, fields;
  try {
    const typeByte = buf[0];
    if (typeByte === 0x01 || typeByte === 0x02) {
      const { item, off } = rlpDecode(buf, 1);
      if (off !== buf.length || !Array.isArray(item)) throw new Error("bad typed tx");
      type = typeByte === 0x01 ? "eip2930" : "eip1559";
      fields = item;
      // eip2930: chainId,nonce,gasPrice,gasLimit,to,value,data,accessList,v,r,s (11)
      // eip1559: chainId,nonce,maxPrio,maxFee,gasLimit,to,value,data,accessList,yParity,r,s (12)
      const want = typeByte === 0x01 ? 11 : 12;
      if (fields.length !== want) throw new Error("bad field count");
    } else {
      const { item, off } = rlpDecode(buf, 0);
      if (off !== buf.length || !Array.isArray(item) || item.length !== 9) throw new Error("bad legacy tx");
      type = "legacy";
      fields = item;
    }
  } catch {
    throw badRequest("not a decodable raw transaction — expected RLP-encoded legacy or EIP-2930/1559 signed tx bytes");
  }

  let chainId = null, nonce, gasPrice = null, maxFeePerGas = null, gasLimit, to, value, data;
  if (type === "legacy") {
    nonce = big(fields[0]).toString();
    gasPrice = big(fields[1]);
    gasLimit = big(fields[2]).toString();
    to = fields[3].length === 0 ? null : "0x" + Buffer.from(fields[3]).toString("hex");
    value = big(fields[4]);
    data = Buffer.from(fields[5]);
    const v = big(fields[6]);
    if (v >= 35n) chainId = ((v - 35n) / 2n).toString();
    else if (v === 27n || v === 28n) chainId = "1"; // pre-EIP-155 legacy
  } else if (type === "eip2930") {
    chainId = big(fields[0]).toString();
    nonce = big(fields[1]).toString();
    gasPrice = big(fields[2]);
    gasLimit = big(fields[3]).toString();
    to = fields[4].length === 0 ? null : "0x" + Buffer.from(fields[4]).toString("hex");
    value = big(fields[5]);
    data = Buffer.from(fields[6]);
  } else {
    chainId = big(fields[0]).toString();
    nonce = big(fields[1]).toString();
    maxFeePerGas = big(fields[3]);
    gasPrice = maxFeePerGas; // display fee as the max fee
    gasLimit = big(fields[4]).toString();
    to = fields[5].length === 0 ? null : "0x" + Buffer.from(fields[5]).toString("hex");
    value = big(fields[6]);
    data = Buffer.from(fields[7]);
  }

  const valueWei = value.toString();
  const dataLen = data.length;
  const explanation = [];
  const flags = [];
  const ctx = { to, valueWei };

  if (value > 0n && to) {
    explanation.push(`Sends ${fmtUnits(value, 18)} ETH to ${to}.`);
    flags.push("native-value-transfer");
  }
  if (to === null) {
    explanation.push("Deploys a new contract (contract creation) — the `to` field is empty and `data` carries the init bytecode.");
    flags.push("contract-creation");
  }

  let call;
  if (dataLen >= 4 && to !== null) {
    const selector = data.subarray(0, 4).toString("hex");
    const entry = SELECTORS[selector];
    const body = data.subarray(4);
    if (entry) {
      let decoded;
      try {
        decoded = entry.decode(body, ctx);
      } catch {
        decoded = null;
      }
      if (decoded) {
        call = { selector: "0x" + selector, name: entry.name, known: true, signature: entry.signature, params: decoded.params };
        explanation.push(...decoded.sentences);
        for (const f of decoded.flags || []) if (!flags.includes(f)) flags.push(f);
      } else {
        call = { selector: "0x" + selector, name: entry.name, known: true, signature: entry.signature, params: null, note: "calldata failed to decode against the known signature — showing raw bytes" };
        flags.push("unknown-selector");
      }
    } else {
      call = {
        selector: "0x" + selector,
        name: null,
        known: false,
        note: "unknown function, showing raw calldata",
        calldata_head: "0x" + data.subarray(0, Math.min(32, dataLen)).toString("hex"),
      };
      explanation.push(`Calls an unrecognized function (selector 0x${selector}) on ${to} — calldata shown raw.`);
      flags.push("unknown-selector");
    }
  } else if (dataLen > 0 && to === null) {
    call = { selector: null, name: "contract-deployment", known: true, params: { init_bytecode_len: dataLen } };
  } else {
    call = { selector: null, name: value > 0n ? "native-transfer" : "empty-call", known: true, params: {} };
    if (value > 0n && to) explanation.push("A plain native-currency transfer — no contract call involved.");
    else if (value === 0n && to) explanation.push(`A zero-value call to ${to} with no calldata.`);
  }

  const summary =
    to === null
      ? `Contract deployment on ${ch}: ${fmtUnits(value, 18)} ETH attached, ${dataLen} bytes of init code.`
      : value > 0n && dataLen === 0
        ? `Sends ${fmtUnits(value, 18)} ETH to ${to} on ${ch} (${type} tx, nonce ${nonce}).`
        : call.known && call.name
          ? `${call.name}() on ${to} (${ch}, ${type}, nonce ${nonce})${value > 0n ? ` + ${fmtUnits(value, 18)} ETH attached` : ""}.`
          : `Unrecognized call (0x${dataLen >= 4 ? data.subarray(0, 4).toString("hex") : "nodata"}) on ${to} (${ch}, ${type}, nonce ${nonce}).`;

  return {
    chain: ch,
    type,
    nonce,
    to,
    value_wei: valueWei,
    value_eth: fmtUnits(value, 18),
    gas_limit: gasLimit,
    max_fee_per_gas_gwei: fmtUnits(gasPrice || 0n, 9),
    data_len: dataLen,
    call,
    explanation,
    flags,
    explorer_url: EXPLORERS[ch] + hex.toLowerCase(),
    summary,
    source: "local RLP decode + bundled selector table (no network)",
    note: "decodes intent from calldata; does not simulate execution. sender: not recovered (sign locally to verify)",
    chain_id: chainId,
  };
}

module.exports = { explainTx, TX_PLAIN_ENGLISH_CHAINS: Object.keys(EXPLORERS) };
