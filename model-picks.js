// TrollBridge /model-picks lane — data layer (the $0 edition).
// Value picks across the AI model catalog: a curated per-task quality table
// (coding/writing/reasoning/chat scores from public benchmarks — Artificial
// Analysis / LMArena — as of builder knowledge, NOT live measurements) joined
// with LIVE per-token pricing from the /models catalog (BlockRun.AI bridge).
// Ranked by value = quality / (price_per_1m_input_usd + 0.01), so free models
// get a fair shake without dividing by zero.
//
// Quality scores are a benchmark SNAPSHOT (2026-10-01), not live head-to-head
// results: actual quality varies by prompt and version, and leaderboard
// rankings move weekly. Use this lane to shortlist models, then benchmark
// your own workload before spending real money.
const defi = require("./defi-data");

const TASKS = ["coding", "writing", "reasoning", "chat"];
const DEFAULT_TASK = "chat";
const CACHE_TTL_MS = 30 * 60 * 1000;
const QUALITY_SNAPSHOT =
  "curated benchmark snapshot 2026-10-01 — scores from public benchmarks (Artificial Analysis/LMArena) as of builder knowledge, not live measurements";

// Curated quality scores 0-100 per task. Only models verified to exist in the
// live /models catalog (case-insensitive match below); anything not found at
// runtime is skipped and counted in skipped_curated_not_in_catalog.
const QUALITY_TABLE = [
  { id: "openai/gpt-5.6-sol-pro", coding: 97, writing: 96, reasoning: 97, chat: 96 },
  { id: "anthropic/claude-opus-5.5", coding: 97, writing: 95, reasoning: 96, chat: 94 },
  { id: "openai/gpt-5.5", coding: 95, writing: 96, reasoning: 96, chat: 95 },
  { id: "google/gemini-3.1-pro", coding: 94, writing: 94, reasoning: 96, chat: 94 },
  { id: "anthropic/claude-sonnet-5.5", coding: 93, writing: 93, reasoning: 92, chat: 93 },
  { id: "openai/gpt-5.3-codex", coding: 98, writing: 85, reasoning: 88, chat: 84 },
  { id: "xai/grok-4.7", coding: 90, writing: 92, reasoning: 92, chat: 93 },
  { id: "moonshot/kimi-k3", coding: 91, writing: 90, reasoning: 91, chat: 90 },
  { id: "zai/glm-5.3", coding: 88, writing: 88, reasoning: 89, chat: 87 },
  { id: "deepseek/deepseek-reasoner", coding: 86, writing: 80, reasoning: 93, chat: 82 },
  { id: "minimax/minimax-m2.7", coding: 88, writing: 86, reasoning: 89, chat: 87 },
  { id: "qwen/qwen3.7-plus", coding: 87, writing: 87, reasoning: 89, chat: 86 },
  { id: "xiaomi/mimo-v2.5-pro", coding: 85, writing: 84, reasoning: 87, chat: 85 },
  { id: "deepseek/deepseek-chat", coding: 84, writing: 85, reasoning: 82, chat: 86 },
  { id: "openai/gpt-4o", coding: 82, writing: 88, reasoning: 80, chat: 90 },
  { id: "google/gemini-2.5-flash", coding: 80, writing: 84, reasoning: 82, chat: 85 },
  { id: "anthropic/claude-haiku-4.5", coding: 82, writing: 85, reasoning: 80, chat: 84 },
  { id: "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning", coding: 74, writing: 72, reasoning: 80, chat: 74 },
];

function makeCache(ttlMs, max = 100) {
  const m = new Map();
  return {
    get(k) {
      const e = m.get(k);
      if (!e) return null;
      if (Date.now() - e.t > ttlMs) return { stale: e.v, age_ms: Date.now() - e.t };
      return { fresh: e.v };
    },
    set(k, v) {
      if (m.size >= max) m.delete(m.keys().next().value);
      m.set(k, { t: Date.now(), v });
    },
  };
}
const picksCache = makeCache(CACHE_TTL_MS);

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}
function round2(v) {
  return v == null ? null : +Number(v).toFixed(2);
}

// value = quality / (input price per 1M tokens + 0.01): the +0.01 keeps free
// models from dividing by zero while still rewarding them.
function valueScore(quality, price) {
  return round2(quality / (price + 0.01));
}

function summaryFor(task, ranked, best, cheapest) {
  if (!ranked.length) return `No catalog models matched the quality table for task "${task}".`;
  const bestPart = `${best.id} (quality ${best.quality}/100, $${best.price_per_1m_input_usd}/1M input tokens)`;
  const cheapPart =
    cheapest.id === best.id
      ? "and it is also the cheapest option"
      : `cheapest alternative is ${cheapest.id} at $${cheapest.price_per_1m_input_usd}/1M input tokens`;
  return `Best value for ${task}: ${bestPart}, ${cheapPart}. Quality scores are a curated benchmark snapshot (2026-10-01), not live measurements; prices are live per-token catalog pricing.`;
}

async function modelPicks(task) {
  const t = (task || DEFAULT_TASK).toLowerCase();
  if (!TASKS.includes(t)) {
    throw badRequest(`task must be one of: ${TASKS.join(", ")} (default ${DEFAULT_TASK})`);
  }
  const key = `picks:${t}`;
  const hit = picksCache.get(key);
  if (hit && hit.fresh) return { ...hit.fresh, cached: true };

  let out;
  try {
    out = await runPicks(t);
  } catch (e) {
    if (hit && hit.stale) return { ...hit.stale, stale: true, cached: true };
    throw e;
  }
  out = { generated_at: new Date().toISOString(), cached: false, ...out };
  picksCache.set(key, out);
  return out;
}

async function runPicks(task) {
  const catalog = await defi.modelCatalog();
  const byId = new Map();
  for (const m of catalog.models || []) {
    if (m && m.id) byId.set(String(m.id).toLowerCase(), m);
  }

  const ranked = [];
  const skipped_curated_not_in_catalog = [];
  for (const q of QUALITY_TABLE) {
    const live = byId.get(q.id.toLowerCase());
    if (!live) {
      skipped_curated_not_in_catalog.push(q.id);
      continue;
    }
    const price = Number(live.price_per_1m_input_usd);
    if (!Number.isFinite(price)) continue; // no token price (e.g. per-image billing)
    const quality = q[task];
    ranked.push({
      id: live.id,
      name: live.name || live.id,
      provider: live.provider || null,
      billing_mode: live.billing_mode || null,
      quality,
      price_per_1m_input_usd: live.price_per_1m_input_usd,
      price_per_1m_output_usd: live.price_per_1m_output_usd,
      value_score: valueScore(quality, price),
    });
  }

  // Sort by value desc; ties break on quality desc, then price asc.
  ranked.sort(
    (a, b) => b.value_score - a.value_score || b.quality - a.quality || a.price_per_1m_input_usd - b.price_per_1m_input_usd
  );

  const best = ranked[0] || null;
  const cheapest = ranked.length
    ? [...ranked].sort(
        (a, b) => a.price_per_1m_input_usd - b.price_per_1m_input_usd || b.quality - a.quality
      )[0]
    : null;

  const best_value = best
    ? {
        id: best.id,
        quality: best.quality,
        price_per_1m_input_usd: best.price_per_1m_input_usd,
        value_score: best.value_score,
        est_cost_per_1m_input_tokens_usd: best.price_per_1m_input_usd,
        why: `highest value_score (${best.value_score}) for ${task} at quality ${best.quality}/100`,
      }
    : null;
  const cheapest_out = cheapest
    ? {
        id: cheapest.id,
        quality: cheapest.quality,
        price_per_1m_input_usd: cheapest.price_per_1m_input_usd,
        value_score: cheapest.value_score,
        est_cost_per_1m_input_tokens_usd: cheapest.price_per_1m_input_usd,
      }
    : null;

  return {
    task,
    quality_snapshot: QUALITY_SNAPSHOT,
    ranked,
    best_value,
    cheapest: cheapest_out,
    skipped_curated_not_in_catalog,
    summary: summaryFor(task, ranked, best, cheapest),
    source:
      "live per-token pricing: trollbridge /models catalog (BlockRun.AI); quality: curated benchmark snapshot",
    note: "Quality scores are a benchmark snapshot, not live measurements. Refresh: 30-min cache.",
  };
}

module.exports = { modelPicks, MODEL_PICK_TASKS: TASKS };
