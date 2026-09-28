#!/usr/bin/env node
/**
 * trollbridge-mcp — MCP wrapper for Mini's TrollBridge.
 *
 * TrollBridge (https://mini-tollbooth.onrender.com) is a pay-per-call
 * intel bridge for AI agents. Tolled lanes cost $0.02 or $0.05 USDC per
 * call on Base (eip155:8453) or Solana (solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp)
 * via the x402 protocol; the free endpoints (/tools, /traffic, /health)
 * cost nothing.
 *
 * This MCP server is a read-only client. It NEVER attempts payment:
 * when a tolled lane answers HTTP 402, the tool returns an honest
 * explanation of the payment challenge plus instructions for completing
 * the x402 v2 flow and retrying. It never claims a payment was made.
 */

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const BRIDGE_URL =
  process.env.TROLLBRIDGE_URL || "https://mini-tollbooth.onrender.com";

// Payment constants from the live 402 challenges (verified on mainnet).
// Both rails pay straight to the keeper's Coinbase: Base USDC to the
// eip155:8453 address, Solana USDC to the solana address below.
const TOLL_2C = {
  price: "$0.02 USDC per call",
  amountAtomic: "20000",
  rails: [
    {
      network: "eip155:8453",
      asset: "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913",
      payTo: "0x8BE8D056d5F0bEF850eC9ed5C4a8d647cBE896C0",
      label: "Base",
    },
    {
      network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp",
      asset: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
      payTo: "CDhLHtuj1HnPVDuZVtJxyw5aEpf6ZQxfBTrqAtFcWb2e",
      label: "Solana",
    },
  ],
  scheme: "exact",
};
const TOLL_5C = {
  ...TOLL_2C,
  price: "$0.05 USDC per call",
  amountAtomic: "50000",
};

const HONEST_PREAMBLE =
  "Mini's TrollBridge: a pay-per-call intel bridge kept by Mini, " +
  "a data-bounty hunter. Tolls go to the keeper's Coinbase on Base " +
  "and Solana. This MCP server only reads the bridge — it never pays " +
  "and never claims a payment was made.";

async function bridgeGet(path) {
  const url = `${BRIDGE_URL}${path}`;
  let res;
  try {
    res = await fetch(url, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(45000),
    });
  } catch (err) {
    return {
      ok: false,
      kind: "network",
      text:
        `Could not reach TrollBridge at ${url}: ${err.message}. ` +
        "The bridge runs on a free hosting tier and sleeps after 15 minutes " +
        "of idleness — it may just be waking up. Wait ~30 seconds and retry.",
    };
  }

  if (res.status === 402) {
    let bodyText = "";
    try {
      bodyText = await res.text();
    } catch {
      bodyText = "";
    }
    // Raw challenge body; the caller renders it with paywalled() so the
    // correct per-lane toll shows.
    return { ok: false, kind: "402", text: bodyText };
  }

  if (!res.ok) {
    return {
      ok: false,
      kind: "http",
      text: `TrollBridge returned HTTP ${res.status} for ${path}. Retry shortly.`,
    };
  }

  let data;
  try {
    data = await res.json();
  } catch (err) {
    return {
      ok: false,
      kind: "parse",
      text: `TrollBridge returned non-JSON for ${path}: ${err.message}.`,
    };
  }
  return { ok: true, data };
}

function paywalled(path, bodyText, toll) {
  const t = toll || TOLL_2C;
  const railLines = t.rails
    .map(
      (r) =>
        `  - ${r.label}: network ${r.network}, asset ${r.asset}, pay to ${r.payTo}`
    )
    .join("\n");
  const lines = [
    `${HONEST_PREAMBLE}`,
    "",
    `GET ${path} is a TOLLED lane. The bridge answered HTTP 402 Payment Required.`,
    "No payment was attempted and none was made.",
    "",
    "To cross, pay the toll with the x402 v2 flow:",
    `  - Price:    ${t.price} (${t.amountAtomic} atomic units)`,
    railLines,
    `  - Scheme:   ${t.scheme}`,
    "",
    "x402 v2 steps: read the 402 challenge (it carries payment requirements),",
    "sign a payment authorization for the exact amount with a funded wallet on",
    "either rail, then retry the request with the X-Payment header set",
    "(PAYMENT-SIGNATURE) — the bridge verifies via its facilitator and returns",
    "the data with an X-Payment-Response receipt. Any x402 v2 client library",
    "can do this.",
    "",
    "Until you pay, here is the raw 402 challenge body for reference:",
    bodyText ? bodyText.slice(0, 2000) : "(empty body)",
  ];
  return lines.join("\n");
}

function asText(result) {
  if (result.ok) {
    return {
      content: [
        {
          type: "text",
          text: JSON.stringify(result.data, null, 2),
        },
      ],
    };
  }
  return { content: [{ type: "text", text: result.text }] };
}

const TOLL_NOTE =
  "If you cannot pay, this tool returns the 402 payment instructions instead of data.";

const LIMIT_SCHEMA = {
  type: "object",
  properties: {
    limit: {
      type: "integer",
      minimum: 1,
      maximum: 200,
      description: "Max items to return (1-200). Default 50.",
    },
  },
};

const TOLLED_LANES = {
  // ---- original bounty lanes ($0.02) ----
  bridge_bounties: {
    path: "/bounties",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — ALL open bounties worth an agent's time (aibtc, Taskmarket, Superteam), refreshed every 6 hours. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit 1-200.",
    schema: LIMIT_SCHEMA,
    query: (args) => queryOf({ limit: clampInt(args.limit, 1, 200, 50) }),
  },
  bridge_fresh: {
    path: "/fresh",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — bounties posted in the last 24 hours. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit 1-200.",
    schema: LIMIT_SCHEMA,
    query: (args) => queryOf({ limit: clampInt(args.limit, 1, 200, 50) }),
  },
  bridge_deadlines: {
    path: "/deadlines",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — upcoming class-action and claim deadlines (money with an expiry date). TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit 1-200.",
    schema: LIMIT_SCHEMA,
    query: (args) => queryOf({ limit: clampInt(args.limit, 1, 200, 50) }),
  },
  bridge_sweepstakes: {
    path: "/sweepstakes",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — free-to-enter sweepstakes with real prizes, curated by Mini. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit 1-200.",
    schema: LIMIT_SCHEMA,
    query: (args) => queryOf({ limit: clampInt(args.limit, 1, 200, 50) }),
  },
  bridge_verdicts: {
    path: "/verdicts",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — recently-paid bounties: which bounties actually paid out and how much. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit 1-200.",
    schema: LIMIT_SCHEMA,
    query: (args) => queryOf({ limit: clampInt(args.limit, 1, 200, 50) }),
  },
  // ---- market-intel lanes ----
  bridge_prices: {
    path: "/prices",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — live spot prices: BTC, ETH, SOL plus USDC, agent-ready JSON refreshed every 6 hours. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " No parameters.",
    schema: { type: "object", properties: {} },
  },
  bridge_enrich: {
    path: "/enrich",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — wallet intel: address type, native balance, USDC watchlist, risk flags, all from free public RPCs. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Required: address (wallet address), network (base or solana).",
    schema: {
      type: "object",
      properties: {
        address: { type: "string", description: "Wallet address to investigate." },
        network: {
          type: "string",
          enum: ["base", "solana"],
          description: "Which chain the address lives on.",
        },
      },
      required: ["address", "network"],
    },
    query: (args) =>
      queryOf({ address: args.address, network: args.network }),
  },
  bridge_token_check: {
    path: "/token-check",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — rug scan: liquidity, volume, buys/sells, holder concentration, a 0-100 safety score and a plain verdict before you ape in. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Required: mint (token contract or mint address), network (base or solana).",
    schema: {
      type: "object",
      properties: {
        mint: { type: "string", description: "Token contract (Base) or mint address (Solana)." },
        network: {
          type: "string",
          enum: ["base", "solana"],
          description: "Which chain the token lives on.",
        },
      },
      required: ["mint", "network"],
    },
    query: (args) => queryOf({ mint: args.mint, network: args.network }),
  },
  bridge_markets: {
    path: "/markets",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — live Polymarket odds, prices and volume, agent-ready JSON. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Required: q (search terms, e.g. bitcoin, election, fed). Optional limit 1-25.",
    schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "Search terms for prediction markets." },
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 25,
          description: "Max events to return (1-25). Default 10.",
        },
      },
      required: ["q"],
    },
    query: (args) =>
      queryOf({ q: args.q, limit: clampInt(args.limit, 1, 25, 10) }),
  },
  bridge_search: {
    path: "/search",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — web search for agents: title, URL and snippet per result as JSON. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Required: q (search query).",
    schema: {
      type: "object",
      properties: {
        q: { type: "string", description: "The search query." },
      },
      required: ["q"],
    },
    query: (args) => queryOf({ q: args.q }),
  },
  bridge_yields: {
    path: "/yields",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — the best DeFi yields right now (DeFiLlama): top stablecoin APYs, agent-ready. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit (1-50), stablecoinOnly (true/false).",
    schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max pools to return (1-50). Default 20.",
        },
        stablecoinOnly: {
          type: "boolean",
          description: "Only stablecoin pools. Default false.",
        },
      },
    },
    query: (args) =>
      queryOf({
        limit: clampInt(args.limit, 1, 50, 20),
        stablecoinOnly: args.stablecoinOnly === true ? "true" : undefined,
      }),
  },
  bridge_new_pairs: {
    path: "/new-pairs",
    toll: TOLL_5C,
    description:
      "Mini's TrollBridge — the newest token listings (DexScreener) with rug scores attached: spot the next runner before the crowd. TOLLED: $0.05 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " Optional limit (1-50), chain (e.g. solana, base).",
    schema: {
      type: "object",
      properties: {
        limit: {
          type: "integer",
          minimum: 1,
          maximum: 50,
          description: "Max pairs to return (1-50). Default 20.",
        },
        chain: {
          type: "string",
          description: "Chain filter, e.g. solana or base.",
        },
      },
    },
    query: (args) =>
      queryOf({ limit: clampInt(args.limit, 1, 50, 20), chain: args.chain }),
  },
  bridge_gas: {
    path: "/gas",
    toll: TOLL_2C,
    description:
      "Mini's TrollBridge — live gas prices per chain from free RPCs: know the fee before you move money. TOLLED: $0.02 USDC per call on Base or Solana via x402. " +
      TOLL_NOTE +
      " No parameters.",
    schema: { type: "object", properties: {} },
  },
};

const FREE_ENDPOINTS = {
  bridge_tools: {
    path: "/tools",
    description:
      "Mini's TrollBridge — FREE directory of third-party AI tools listed on the TrollBridge marketplace (developers list tools, agents pay per use). No toll.",
  },
  bridge_traffic: {
    path: "/traffic",
    description:
      "Mini's TrollBridge — FREE bridge statistics: per-lane toll challenges (lookers) vs paid crossings (agents through), unique payer wallets, first/last seen. Honest day-one ledger: traffic is small and growing; this tool reports exactly what the bridge has seen, nothing more.",
  },
  bridge_health: {
    path: "/health",
    description:
      "Mini's TrollBridge — FREE health check: is the bridge awake, how many lanes, marketplace status. No toll.",
  },
};

function clampInt(v, min, max, dflt) {
  if (v == null) return dflt;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return dflt;
  return Math.max(min, Math.min(max, n));
}

function queryOf(params) {
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== "") qs.set(k, String(v));
  }
  const s = qs.toString();
  return s ? `?${s}` : "";
}

const server = new Server(
  { name: "trollbridge-mcp", version: "1.1.0" },
  { capabilities: { tools: {} } }
);

const ALL_TOOLS = { ...TOLLED_LANES, ...FREE_ENDPOINTS };

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: Object.entries(ALL_TOOLS).map(([name, def]) => ({
    name,
    description: def.description,
    inputSchema:
      def.schema || (TOLLED_LANES[name] ? LIMIT_SCHEMA : { type: "object", properties: {} }),
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  const def = ALL_TOOLS[name];
  if (!def) throw new Error(`Unknown tool: ${name}`);

  let path = def.path;
  if (TOLLED_LANES[name]) {
    const required = (def.schema && def.schema.required) || [];
    const missing = required.filter(
      (p) => !args || args[p] === undefined || args[p] === null || args[p] === ""
    );
    if (missing.length) {
      return {
        content: [
          {
            type: "text",
            text:
              `Missing required parameter(s): ${missing.join(", ")}. ` +
              "No request was sent and no toll is due. Provide them and retry.",
          },
        ],
      };
    }
    if (def.query) path += def.query(args || {});
    const result = await bridgeGet(path);
    if (!result.ok && result.kind === "402") {
      return {
        content: [{ type: "text", text: paywalled(path, result.text, def.toll) }],
      };
    }
    return asText(result);
  }

  const result = await bridgeGet(path);
  return asText(result);
});

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error("trollbridge-mcp fatal:", err);
  process.exit(1);
});
