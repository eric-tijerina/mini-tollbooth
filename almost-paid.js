// "Almost paid" instrumentation for the TrollBridge tollbooth.
//
// The ledger used to see only knocks (402s) and paid crossings. This module
// adds the in-between: which agents keep knocking, which ones sent a payment
// payload that got rejected (wallet out, money almost moved), and how far
// each visitor got down the funnel:
//
//   discovery_only -> challenged -> tried_and_failed -> paid
//
// Privacy: visitors are keyed by SHA-256(IP + user-agent), truncated to 16
// hex chars. Raw IPs and user-agents are NEVER persisted.
//
// The failed-payment hook: x402 v2 clients answer a 402 by retrying with the
// payment in the `payment-signature` header (v1: `x-payment`) — header names
// verified against the installed @x402/express server source. When a request
// to a tolled lane carries one of those headers and the response is STILL a
// 402, the payment was rejected. The 402 JSON body carries an `error` field
// (verified against @x402/core's createPaymentRequiredResponse) that
// classifies the failure best-effort.
const crypto = require("crypto");

const MAX_VISITORS = 2000; // cap persisted visitor records; oldest evicted first
const MAX_FAILED_LOG = 200; // ring buffer of recent failed attempts

function visitorKey(ip, userAgent) {
  return crypto
    .createHash("sha256")
    .update((ip || "") + "|" + (userAgent || ""))
    .digest("hex")
    .slice(0, 16);
}

function paymentHeaderPresent(headers) {
  return !!(headers["payment-signature"] || headers["x-payment"]);
}

// Best-effort failure classification from the 402 body's `error` field.
// Never throws, never blocks the request path.
function classifyFailure(body) {
  try {
    const err = body && typeof body === "object" ? body.error : null;
    if (typeof err !== "string" || !err) return "unknown";
    if (/no matching payment requirements/i.test(err)) return "no_matching_requirements";
    if (/signature/i.test(err)) return "invalid_signature";
    if (/verif/i.test(err)) return "verification_failed";
    if (/payment required/i.test(err)) return "unpaid";
    return "payment_rejected";
  } catch {
    return "unknown";
  }
}

function ensureVisitor(u, key) {
  u.visitors = u.visitors || {};
  if (!u.visitors[key]) {
    u.visitors[key] = {
      first_seen: null,
      last_seen: null,
      discovery: 0,
      challenges: 0,
      lanes: {},
      failed: 0,
      paid: false,
    };
  }
  return u.visitors[key];
}

function evictVisitors(u) {
  const keys = Object.keys(u.visitors || {});
  if (keys.length <= MAX_VISITORS) return;
  keys
    .sort((a, b) => new Date(u.visitors[a].last_seen || 0) - new Date(u.visitors[b].last_seen || 0))
    .slice(0, keys.length - MAX_VISITORS)
    .forEach((k) => delete u.visitors[k]);
}

function funnelStage(v) {
  if (v.paid) return "paid";
  if ((v.failed || 0) > 0) return "tried_and_failed";
  if ((v.challenges || 0) > 0) return "challenged";
  return "discovery_only";
}

// Express middleware factory. Must be mounted BEFORE the x402 payment
// middleware so the res.send wrapper is in place for every outcome.
// Only records an event (and only creates the visitor record) when the
// request actually resolved to something meaningful: a 402 on a tolled
// lane, or a 2xx. Server errors and untracked routes leave no trace.
function createTracker({ usage, isTracked, isTolled, isDiscovery, laneStats, payerFromHeader, onEvent }) {
  return function almostPaidTracker(req, res, next) {
    if (!isTracked(req.path)) return next();
    const vk = visitorKey(req.ip, req.headers["user-agent"]);
    const hadPayment = paymentHeaderPresent(req.headers);
    let responseBody = null;
    const origSend = res.send.bind(res);
    res.send = function (body) {
      // res.json stringifies before res.send — parse back so the 402
      // `error` field is readable for failure classification.
      try {
        responseBody = typeof body === "string" ? JSON.parse(body) : body;
      } catch {
        responseBody = body;
      }
      return origSend(body);
    };
    res.on("finish", () => {
      try {
        const now = new Date().toISOString();
        const st = laneStats(req.path);
        if (!st.first_seen) st.first_seen = now;
        st.last_seen = now;
        const tolled = isTolled(req.path);
        if (res.statusCode === 402 && tolled) {
          const v = ensureVisitor(usage, vk);
          if (!v.first_seen) v.first_seen = now;
          v.last_seen = now;
          v.lanes[req.path] = (v.lanes[req.path] || 0) + 1;
          if (hadPayment) {
            // Wallet out, money almost moved: the agent sent a payment
            // payload and the toll collector rejected it.
            const cls = classifyFailure(responseBody);
            st.failed = (st.failed || 0) + 1;
            v.failed += 1;
            usage.failed_log = usage.failed_log || [];
            usage.failed_log.push({ t: now, lane: req.path, visitor: vk, class: cls });
            while (usage.failed_log.length > MAX_FAILED_LOG) usage.failed_log.shift();
          } else {
            st.challenged += 1;
            v.challenges += 1;
          }
        } else if (res.statusCode >= 200 && res.statusCode < 300) {
          const v = ensureVisitor(usage, vk);
          if (!v.first_seen) v.first_seen = now;
          v.last_seen = now;
          if (tolled) {
            if (hadPayment) {
              st.paid += 1; // verified payment header present = real paid crossing
              v.paid = true;
              const payer = payerFromHeader(req);
              if (payer && !st.payers.includes(payer)) st.payers.push(payer);
            } else {
              // 2xx on a tolled lane with NO payment header (e.g. HEAD
              // requests: Express serves them via the GET handler, but the
              // toll collector only challenged GET). No money moved — track
              // separately so the paid count stays honest.
              st.unpaid_2xx = (st.unpaid_2xx || 0) + 1;
            }
          } else {
            st.visits += 1;
            if (isDiscovery(req.path)) v.discovery += 1;
          }
        } else {
          return; // errors leave no trace in the ledger
        }
        evictVisitors(usage);
        onEvent();
      } catch {
        // the ledger never breaks the request path
      }
    });
    next();
  };
}

function almostPaidSummary(usage) {
  const visitors = usage.visitors || {};
  const funnel = { discovery_only: 0, challenged: 0, tried_and_failed: 0, paid: 0 };
  let failedTotal = 0;
  const repeaters = [];
  for (const [key, v] of Object.entries(visitors)) {
    failedTotal += v.failed || 0;
    const stage = funnelStage(v);
    funnel[stage] += 1;
    const knocks = (v.challenges || 0) + (v.failed || 0);
    if (knocks >= 2) {
      repeaters.push({
        visitor: key,
        challenges: v.challenges || 0,
        failed: v.failed || 0,
        lanes: Object.keys(v.lanes || {}),
        last_seen: v.last_seen,
        funnel: stage,
      });
    }
  }
  repeaters.sort((a, b) => b.challenges + b.failed - (a.challenges + a.failed));
  return {
    failed_payments: failedTotal,
    repeat_challengers: repeaters.slice(0, 20),
    funnel,
  };
}

module.exports = {
  visitorKey,
  paymentHeaderPresent,
  classifyFailure,
  funnelStage,
  ensureVisitor,
  almostPaidSummary,
  createTracker,
  MAX_VISITORS,
};
