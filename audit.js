// TrollBridge /audit lane — data layer: async AI-agent audit job queue.
//
// Rung 2 of the audit ladder: /audit-prep ($1, instant, automated) →
// /audit ($25, deep review performed by an AI reviewer, ~15-30 min) →
// human audit ($10k+).
//
// Why async: a 15-minute deep review cannot fit a synchronous HTTP call.
// The buyer pays $25 to SUBMIT a job, then polls GET /audit?action=status
// (free) until the reviewer finishes. A fulfillment worker (the audit-worker
// cron, every ~10 min) picks up pending jobs, fetches verified source from
// Sourcify, performs three persona passes (Attacker, Economist, Pedant),
// and posts the aggregated report back through the keyed /audit/complete
// endpoint.
//
// V1 scope (kept tight):
// - chains: "base" | "ethereum" (verified source via Sourcify, no key).
// - Unverified contracts: the job completes with an HONEST "source not
//   verified — cannot review" report. Nothing is faked, ever.
// - Storage: jobs.json next to server.js. EPHEMERAL on Render free-tier
//   redeploys — a restart/redeploy loses pending jobs. The worker re-lists
//   every run; this is documented in the lane copy, not hidden.
// - The $25 toll covers SUBMITTING a job. Status checks and terms are free.
// - NOT in the tester whitelist: each audit costs real reviewer work,
//   so audits are paid-only.
//
// This module never moves money and never logs raw caller data.

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

const CHAINS = ["base", "ethereum"];
const MAX_JOBS = 100;
const COMPLETED_TTL_MS = 30 * 24 * 60 * 60 * 1000;

const WARNING = "NOT_A_HUMAN_AUDIT — deep AI review, not a formal audit.";

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function notFound(msg) {
  const e = new Error(msg);
  e.statusCode = 404;
  return e;
}

function storePath() {
  return path.join(__dirname, "jobs.json");
}

function loadJobs(sp) {
  try {
    const d = JSON.parse(fs.readFileSync(sp || storePath(), "utf8"));
    if (d && Array.isArray(d.jobs)) return d;
  } catch { /* missing or corrupt → start clean */ }
  return { jobs: [] };
}

function saveJobs(d, sp) {
  fs.writeFileSync(sp || storePath(), JSON.stringify(d, null, 2));
}

function isHexAddress(s) {
  return typeof s === "string" && /^0x[0-9a-fA-F]{40}$/.test(s);
}

function publicJob(j) {
  // The buyer-facing view: status is free, the report rides along when done.
  const out = {
    job_id: j.job_id,
    address: j.address,
    chain: j.chain,
    status: j.status,
    created_at: j.created_at,
  };
  if (j.started_at) out.started_at = j.started_at;
  if (j.completed_at) out.completed_at = j.completed_at;
  if (j.report) out.report = j.report;
  if (j.error) out.error = j.error;
  return out;
}

// Signature: submitAudit({ address, chain? }) → job receipt. Throws 400.
function submitAudit(p, sp) {
  const address = p.address;
  let chain = p.chain === undefined || p.chain === null || p.chain === "" ? "base" : String(p.chain).toLowerCase();
  if (!isHexAddress(address)) {
    throw badRequest("address must be a 0x contract address (40 hex chars)");
  }
  if (!CHAINS.includes(chain)) {
    throw badRequest("chain must be 'base' or 'ethereum'");
  }
  const store = loadJobs(sp);
  // Prune dead weight: drop completed jobs older than 30 days on every submit.
  const now = Date.now();
  store.jobs = store.jobs.filter((j) => {
    if (j.status !== "complete" && j.status !== "failed") return true;
    const doneAt = new Date(j.completed_at || j.created_at).getTime();
    return now - doneAt < COMPLETED_TTL_MS;
  });
  if (store.jobs.length >= MAX_JOBS) {
    throw badRequest("audit queue is full (100) — try again later");
  }
  const job_id = "au_" + crypto.randomBytes(8).toString("hex");
  const job = {
    job_id,
    address: address.toLowerCase(),
    chain,
    status: "pending",
    created_at: new Date(now).toISOString(),
    started_at: null,
    completed_at: null,
    report: null,
    error: null,
  };
  store.jobs.push(job);
  saveJobs(store, sp);
  return {
    lane: "/audit",
    job_id,
    status: "pending",
    address: job.address,
    chain,
    eta: "~15-30 min",
    check: "GET /audit?action=status&job_id=" + job_id,
    note: "Your $25 bought one deep AI review. Poll the status URL (free) until status is 'complete'.",
  };
}

// Signature: getJob(job_id) → public job view. Throws 400/404.
function getJob(job_id, sp) {
  if (!job_id || typeof job_id !== "string") {
    throw badRequest("missing required param: job_id (usage: GET /audit?action=status&job_id=<job_id>)");
  }
  const store = loadJobs(sp);
  const j = store.jobs.find((x) => x.job_id === job_id);
  if (!j) throw notFound("unknown job_id");
  return { lane: "/audit", ...publicJob(j) };
}

// Signature: listPending() — internal: jobs awaiting the reviewer.
function listPending(sp) {
  const store = loadJobs(sp);
  return store.jobs.filter((j) => j.status === "pending").map(publicJob);
}

// Signature: updateJob(job_id, patch) — internal (keyed endpoint).
// patch: { status: "in_review" } for a status-only update, or
// { status: "complete", report: {...} } / { status: "failed", error: "..." }.
function updateJob(job_id, patch, sp) {
  if (!job_id || typeof job_id !== "string") throw badRequest("missing job_id");
  const store = loadJobs(sp);
  const j = store.jobs.find((x) => x.job_id === job_id);
  if (!j) throw notFound("unknown job_id");
  const now = new Date().toISOString();
  if (patch.status === "in_review") {
    if (j.status !== "pending") throw badRequest("job is not pending (status: " + j.status + ")");
    j.status = "in_review";
    j.started_at = now;
  } else if (patch.status === "complete") {
    if (!patch.report || typeof patch.report !== "object") throw badRequest("complete requires a report object");
    j.status = "complete";
    j.completed_at = now;
    j.report = patch.report;
  } else if (patch.status === "failed") {
    j.status = "failed";
    j.completed_at = now;
    j.error = String(patch.error || "reviewer failed").slice(0, 500);
  } else {
    throw badRequest("status must be 'in_review', 'complete', or 'failed'");
  }
  saveJobs(store, sp);
  return { lane: "/audit", ...publicJob(j) };
}

// Signature: auditTerms() — free terms briefing.
function auditTerms() {
  return {
    warning: WARNING,
    lane: "/audit/terms",
    what: "AI agent audit. A deep multi-persona review (Attacker, Economist, Pedant) performed by an AI reviewer in ~15-30 minutes.",
    what_it_is_not: [
      "NOT a human audit — no human auditor reads your contract.",
      "NOT formal verification — no mathematical proof of correctness.",
      "Best used as the step between automated screening (/audit-prep, $1) and a paid human audit ($10k+).",
    ],
    how_it_works: [
      "1. Pay $25: GET /audit?action=submit&address=0x…&chain=base — you get a job_id.",
      "2. Poll (free): GET /audit?action=status&job_id=… until status is 'complete'.",
      "3. Read the report: findings[] with severity, plain-English explanations, exact locations, explicit uncertainty where the reviewer cannot rule something out, plus what_a_human_auditor_should_still_check[].",
    ],
    price: "$25.00 USDC per audit (Base or Solana). Status checks and these terms are free.",
    chains: CHAINS,
    source: "Verified source fetched from Sourcify (no key needed). Unverified contracts get an honest 'cannot review' — nothing is faked.",
    limits: "Jobs live on this host's disk — a bridge restart loses pending jobs (v1 limitation, stated plainly). Max 100 jobs in queue.",
  };
}

module.exports = { submitAudit, getJob, listPending, updateJob, auditTerms, WARNING, CHAINS };
