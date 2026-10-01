// TrollBridge /quant lane — pure-math quant finance calculators.
// NO network calls: Black-Scholes pricing + Greeks, parametric VaR,
// Sharpe ratio, and compound growth. Textbook closed-form math only —
// not financial advice, not a pricing oracle, no market data involved.

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

const DISCLAIMER = "textbook math, not financial advice";

function r6(x) {
  const v = Math.round(x * 1e6) / 1e6;
  return v === 0 ? 0 : v; // kill -0
}

function num(v, name) {
  const n = typeof v === "number" ? v : Number(String(v).trim());
  if (!Number.isFinite(n)) throw badRequest(`bad or missing numeric param: ${name}`);
  return n;
}

function optNum(v, name, def) {
  if (v === undefined || v === null || v === "") return def;
  return num(v, name);
}

// standard normal pdf and cdf (A&S 26.2.17, |error| < 7.5e-8)
function phi(x) {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}
function Phi(x) {
  const b1 = 0.31938153, b2 = -0.356563782, b3 = 1.781477937,
        b4 = -1.821255978, b5 = 1.330274429, p = 0.2316419;
  const ax = Math.abs(x);
  const t = 1 / (1 + p * ax);
  const tail = phi(ax) * (((((b5 * t + b4) * t + b3) * t + b2) * t + b1) * t);
  return x >= 0 ? 1 - tail : tail;
}

function blackScholes(p) {
  const S = num(p.S, "S");
  const K = num(p.K, "K");
  const T = num(p.T, "T");
  const r = num(p.r, "r");
  const sigma = num(p.sigma, "sigma");
  if (S <= 0) throw badRequest("bad param: S must be > 0");
  if (K <= 0) throw badRequest("bad param: K must be > 0");
  if (T < 0) throw badRequest("bad param: T must be >= 0 (years)");
  if (sigma < 0) throw badRequest("bad param: sigma must be >= 0");
  const side = String(p.side || "").trim().toLowerCase();
  if (side !== "call" && side !== "put") throw badRequest('bad param: side must be "call" or "put"');
  const isCall = side === "call";
  const disc = Math.exp(-r * T);
  let price, delta, gamma, theta, vega;
  if (T === 0 || sigma === 0) {
    // degenerate: intrinsic value, Greeks collapse
    price = isCall ? Math.max(S - K, 0) : Math.max(K - S, 0);
    delta = isCall ? (S > K ? 1 : 0) : (S < K ? -1 : 0);
    gamma = 0; theta = 0; vega = 0;
  } else {
    const sqrtT = Math.sqrt(T);
    const d1 = (Math.log(S / K) + (r + 0.5 * sigma * sigma) * T) / (sigma * sqrtT);
    const d2 = d1 - sigma * sqrtT;
    const nd1 = Phi(d1), nd2 = Phi(d2), pd1 = phi(d1);
    const carry = (S * pd1 * sigma) / (2 * sqrtT);
    if (isCall) {
      price = S * nd1 - K * disc * nd2;
      delta = nd1;
      theta = -carry - r * K * disc * nd2;
    } else {
      price = K * disc * Phi(-d2) - S * Phi(-d1);
      delta = nd1 - 1;
      theta = -carry + r * K * disc * Phi(-d2);
    }
    gamma = pd1 / (S * sigma * sqrtT);
    vega = S * pd1 * sqrtT; // per 1.00 of volatility
  }
  return {
    op: "black-scholes", side,
    price: r6(price), delta: r6(delta), gamma: r6(gamma),
    theta: r6(theta), vega: r6(vega),
    vega_note: "per 1.00 of volatility — divide by 100 for per-1pt",
    theta_note: "per year",
    disclaimer: DISCLAIMER,
  };
}

function parseReturns(v) {
  if (v === undefined || v === null || v === "") {
    throw badRequest("missing required param: returns (comma-separated string or array)");
  }
  const arr = Array.isArray(v) ? v : String(v).split(",");
  const xs = arr.map((x) => Number(String(x).trim()));
  if (xs.length === 0 || xs.some((x) => !Number.isFinite(x))) {
    throw badRequest("bad param: returns must contain only finite numbers");
  }
  return xs;
}

function meanSampleStd(xs) {
  const n = xs.length;
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  const sd = n > 1
    ? Math.sqrt(xs.reduce((a, b) => a + (b - mean) * (b - mean), 0) / (n - 1))
    : 0;
  return { mean, sd, n };
}

const Z_SCORES = { 95: 1.6448536269514729, 99: 2.3263478740408408 };

function valueAtRisk(p) {
  const confidence = optNum(p.confidence, "confidence", 95);
  if (confidence !== 95 && confidence !== 99) {
    throw badRequest("bad param: confidence must be 95 or 99");
  }
  let mean, sd, n = null;
  if (p.returns !== undefined && p.returns !== null && p.returns !== "") {
    const xs = parseReturns(p.returns);
    if (xs.length < 2) throw badRequest("bad param: returns needs at least 2 observations");
    ({ mean, sd, n } = meanSampleStd(xs));
  } else {
    mean = num(p.mean, "mean");
    sd = num(p.std, "std");
    if (sd < 0) throw badRequest("bad param: std must be >= 0");
    n = optNum(p.n, "n", null);
    if (n !== null && n <= 0) throw badRequest("bad param: n must be > 0");
  }
  const varPct = (Z_SCORES[confidence] * sd - mean) * 100;
  return {
    op: "var", confidence, method: "parametric",
    var_pct: r6(varPct),
    note: "one-period loss (percent) not exceeded at the given confidence; assumes normal returns, sample std",
    disclaimer: DISCLAIMER,
  };
}

function sharpeRatio(p) {
  const xs = parseReturns(p.returns);
  if (xs.length < 2) throw badRequest("bad param: returns needs at least 2 observations");
  const rf = optNum(p.rf, "rf", 0);
  const { mean, sd } = meanSampleStd(xs);
  if (!(sd > 1e-12)) throw badRequest("bad param: returns have zero volatility — Sharpe is undefined");
  return {
    op: "sharpe",
    sharpe: r6((mean - rf) / sd),
    note: "uses sample std; rf and returns must share the same period",
    disclaimer: DISCLAIMER,
  };
}

function compoundGrowth(p) {
  const principal = num(p.principal, "principal");
  const rate = num(p.rate, "rate");
  const periods = num(p.periods, "periods");
  const cpp = optNum(p.compounds_per_period, "compounds_per_period", 1);
  if (cpp <= 0) throw badRequest("bad param: compounds_per_period must be > 0");
  if (periods < 0) throw badRequest("bad param: periods must be >= 0");
  const final = principal * Math.pow(1 + rate / cpp, cpp * periods);
  return {
    op: "compound",
    final: r6(final), gained: r6(final - principal),
    disclaimer: DISCLAIMER,
  };
}

async function quantCalc(params = {}) {
  const op = String(params.op || "").trim().toLowerCase().replace(/_/g, "-");
  switch (op) {
    case "black-scholes":
    case "bs":
      return blackScholes(params);
    case "var":
      return valueAtRisk(params);
    case "sharpe":
      return sharpeRatio(params);
    case "compound":
      return compoundGrowth(params);
    default:
      throw badRequest("missing or unknown param: op (one of black-scholes, var, sharpe, compound)");
  }
}

module.exports = { quantCalc };
