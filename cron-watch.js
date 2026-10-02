// TrollBridge /cron-watch lane — data layer.
// Stateless gap analysis of cron/job run history the CALLER submits as a
// URL-encoded JSON array. Computes staleness multiples against declared
// cadence, flags missed execution windows, and scores SILENT_DEATH_RISK
// (0-100) — the chance the job has died quietly with nobody noticing.
//
// Pure local heuristic analysis — NO network calls, NO watching, NO state.
// This lane is not a monitoring service: it cannot see your jobs; it only
// analyzes the history you submit. Re-submit fresh history to re-check.

const MAX_JOBS_BYTES = 30 * 1024;
const MAX_JOBS = 100;

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

// ---- cadence parsing: -> seconds ----
function parseCadence(cadence) {
  if (typeof cadence === "number" && Number.isFinite(cadence) && cadence > 0) {
    return Math.floor(cadence);
  }
  const c = String(cadence || "").trim().toLowerCase();
  if (!c) throw badRequest("job is missing cadence");
  const named = {
    "15m": 15 * 60,
    "30m": 30 * 60,
    hourly: 3600,
    "1h": 3600,
    "6h": 6 * 3600,
    "12h": 12 * 3600,
    daily: 86400,
    "1d": 86400,
    weekly: 7 * 86400,
    "7d": 7 * 86400,
  };
  if (Object.prototype.hasOwnProperty.call(named, c)) return named[c];
  if (/^\d+$/.test(c)) {
    const n = parseInt(c, 10);
    if (n > 0) return n;
  }
  throw badRequest(
    `unknown cadence "${c}" — use 15m, 30m, hourly/1h, 6h, 12h, daily/1d, weekly/7d, or seconds as a plain number`
  );
}

// ---- input parsing ----
function parseJobs(jobs) {
  if (typeof jobs !== "string" || !jobs.trim()) {
    throw badRequest("missing required param: jobs (usage: GET /cron-watch?jobs=<URL-encoded JSON array>)");
  }
  if (Buffer.byteLength(jobs, "utf8") > MAX_JOBS_BYTES) {
    throw badRequest("jobs payload exceeds 30KB — trim it and retry");
  }
  let decoded;
  try {
    decoded = decodeURIComponent(jobs);
  } catch (e) {
    throw badRequest("jobs is not valid URL-encoded text");
  }
  let arr;
  try {
    arr = JSON.parse(decoded);
  } catch (e) {
    throw badRequest("jobs is not valid JSON — expected a URL-encoded JSON array of job objects");
  }
  if (!Array.isArray(arr)) throw badRequest("jobs must be a JSON array of job objects");
  if (arr.length === 0) throw badRequest("jobs array is empty — submit at least one job");
  if (arr.length > MAX_JOBS) throw badRequest(`jobs capped at ${MAX_JOBS} — you submitted ${arr.length}`);
  return arr;
}

function parseTime(value, field, jobIdx) {
  const t = Date.parse(value);
  if (!Number.isFinite(t)) {
    throw badRequest(`job at index ${jobIdx}: ${field} is not a valid ISO timestamp`);
  }
  return t;
}

// ---- formatting ----
function humanAge(seconds) {
  if (seconds < 0) seconds = 0;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  if (seconds < 3600) return `${(seconds / 60).toFixed(1)}m`;
  if (seconds < 86400) return `${(seconds / 3600).toFixed(1)}h`;
  return `${(seconds / 86400).toFixed(1)}d`;
}

function round1(n) {
  return Math.round(n * 10) / 10;
}

// ---- recommended checks ----
function buildRecommendedChecks({ status, missedWindows, runCount }) {
  const checks = [
    "Verify the job's output artifact was written, not just that the process is alive — check the artifact's mtime and size, not the PID.",
    "Check the scheduler's run logs around the last expected fire time for silent skips, overlapping runs, or uncaught exceptions.",
    "Verify the last deliverable actually exists and is fresh (report file, DB row, webhook receipt) — a process can run and still produce nothing.",
  ];
  if (status === "stale") {
    checks.push("Confirm the cron/schedule entry still exists — deploys and config rewrites silently delete schedules.");
    checks.push("Check for a stuck previous run (lock file, in-progress flag) that blocks new executions without erroring.");
  } else if (status === "due") {
    checks.push("Watch the next scheduled fire time — if it slips past again, treat it as stale and page on it.");
  }
  if (missedWindows > 0) {
    checks.push("Look for gaps where the job fired but produced no output: scheduler alive, job body broken. Correlate scheduler logs with artifact mtimes.");
  }
  if (runCount < 2) {
    checks.push("You have no baseline — collect at least 3-5 successful runs before tuning any alert threshold, or every blip pages you.");
  }
  return checks;
}

// ---- per-job analysis ----
function analyzeJob(raw, idx, nowMs) {
  if (raw === null || typeof raw !== "object") {
    throw badRequest(`job at index ${idx}: must be an object {name, cadence, last_runs, last_success}`);
  }
  const name = String(raw.name || "").trim();
  if (!name) throw badRequest(`job at index ${idx}: missing name`);
  const expected = parseCadence(raw.cadence);
  const lastSuccessMs = parseTime(raw.last_success, "last_success", idx);
  const runs = Array.isArray(raw.last_runs) ? raw.last_runs : [];
  const runMs = [];
  for (const r of runs) {
    const t = Date.parse(r);
    if (Number.isFinite(t)) runMs.push(t);
  }
  runMs.sort((a, b) => a - b);

  const ageSec = (nowMs - lastSuccessMs) / 1000;
  const stalenessMultiple = ageSec / expected;

  let status;
  if (stalenessMultiple <= 1.25) status = "ok";
  else if (stalenessMultiple <= 2) status = "due";
  else status = "stale";

  // gap analysis: largest gap between consecutive runs; count gaps > 2x cadence
  let missedWindows = 0;
  let largestGapSec = 0;
  for (let i = 1; i < runMs.length; i++) {
    const gap = (runMs[i] - runMs[i - 1]) / 1000;
    if (gap > largestGapSec) largestGapSec = gap;
    if (gap > 2 * expected) missedWindows++;
  }

  // SILENT_DEATH_RISK
  let risk = 0;
  if (status === "stale") risk += 40;
  else if (status === "due") risk += 20;
  risk += Math.min(missedWindows * 15, 30);
  if (runMs.length < 2) risk += 10;
  const hadRunInOneCadence = runMs.some((t) => nowMs - t <= expected * 1000);
  if (!hadRunInOneCadence) risk += 10;
  risk = Math.max(0, Math.min(100, risk));

  return {
    name,
    cadence: String(raw.cadence),
    status,
    last_success_age_human: humanAge(ageSec),
    staleness_multiple: round1(stalenessMultiple),
    missed_windows: missedWindows,
    largest_gap_human: humanAge(largestGapSec),
    runs_submitted: runMs.length,
    silent_death_risk: risk,
    next_expected_run: new Date(lastSuccessMs + expected * 1000).toISOString(),
    recommended_checks: buildRecommendedChecks({ status, missedWindows, runCount: runMs.length }),
  };
}

async function cronWatch(jobs) {
  const arr = parseJobs(jobs);
  const nowMs = Date.now();
  const analyzed = arr.map((raw, idx) => analyzeJob(raw, idx, nowMs));
  return {
    jobs_analyzed: analyzed.length,
    jobs: analyzed,
    note: "stateless gap analysis of the history YOU submitted — this lane does not watch anything itself; re-submit fresh history to re-check",
  };
}

module.exports = { cronWatch };
