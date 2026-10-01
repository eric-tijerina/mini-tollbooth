// TrollBridge /code-run lane — data layer.
// Sandboxed JavaScript execution for agents.
//
// SAFETY DESIGN (tested, not assumed):
// - The snippet runs in a FORKED CHILD PROCESS capped at 64MB heap
//   (--max-old-space-size=64). A worker thread was tried first and
//   REJECTED: a single huge allocation (new Array(1e12)) takes V8 down
//   its hard OOM-abort path, which kills the whole process even from a
//   worker. A forked child dying can never take the bridge with it.
// - Inside the child, code runs in a vm context with ONLY safe globals:
//   no require, no process, no fetch, no timers, no fs, no Buffer.
// - vm-level 4.5s timeout stops infinite loops; the parent SIGKILLs the
//   child at the requested timeout (default 5s, max 10s) as a backstop.
//
// HONEST LIMITS: synchronous JavaScript only (lang=js, v1). Pragmatic
// sandbox, not a hardened enclave — safe for data-processing snippets,
// not for untrusted adversarial code.
const { fork } = require("child_process");
const path = require("path");

const MAX_CODE_BYTES = 50 * 1024;
const MAX_TIMEOUT_MS = 10000;
const DEFAULT_TIMEOUT_MS = 5000;
const WORKER_PATH = path.join(__dirname, "code-run-worker.js");

function badRequest(msg) {
  const e = new Error(msg);
  e.statusCode = 400;
  return e;
}

function runInChild(code, timeoutMs, maxOut) {
  return new Promise((resolve) => {
    let settled = false;
    let stdout = "";
    const done = (msg) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { child.kill("SIGKILL"); } catch { /* already gone */ }
      resolve(msg);
    };
    let child;
    try {
      child = fork(WORKER_PATH, [], {
        execArgv: ["--max-old-space-size=64"],
        silent: true,
        // MINIMAL env: the vm Function constructor is host-reachable (Node
        // documents vm as not a security boundary), so the child must carry
        // no secrets. Only PATH + the snippet itself cross the boundary.
        env: {
          PATH: process.env.PATH || "/usr/bin:/bin",
          CODE_RUN_CODE: code,
          CODE_RUN_MAXOUT: String(maxOut),
        },
      });
    } catch (e) {
      return resolve({ verdict: "error", error: `sandbox spawn failed: ${e.message}`, logs: "", execution_ms: 0 });
    }
    const timer = setTimeout(() => {
      done({ verdict: "timeout", error: `execution exceeded ${timeoutMs}ms — child terminated`, logs: "", execution_ms: timeoutMs });
    }, timeoutMs);
    child.stdout.on("data", (d) => {
      stdout += d.toString();
      if (stdout.length > maxOut + 4096) stdout = stdout.slice(0, maxOut + 4096);
    });
    child.on("message", () => { /* unused: child reports via stdout */ });
    child.on("error", (e) => done({ verdict: "error", error: `sandbox error: ${String(e.message || e).slice(0, 500)}`, logs: "", execution_ms: 0 }));
    child.on("exit", (exitCode, signal) => {
      if (exitCode === 0) {
        try {
          const msg = JSON.parse(stdout.trim().split("\n").pop());
          return done({ logs: "", execution_ms: 0, ...msg });
        } catch {
          return done({ verdict: "error", error: "sandbox returned unparseable output", logs: "", execution_ms: 0 });
        }
      }
      done({
        verdict: "crashed",
        error: `sandbox child died (exit ${exitCode}${signal ? `, signal ${signal}` : ""}) — likely heap exhaustion at the 64MB cap. The bridge itself is unaffected.`,
        logs: "",
        execution_ms: 0,
      });
    });
  });
}

async function codeRun({ code, lang, timeout_ms, max_output_chars }) {
  const lg = (lang || "js").toLowerCase();
  if (lg !== "js" && lg !== "javascript") {
    throw badRequest("only JavaScript is supported in v1 (lang=js) — other languages need real sandbox infra we don't have yet");
  }
  const src = code || "";
  if (!src.trim()) throw badRequest("supply code= with the JavaScript snippet to run");
  if (Buffer.byteLength(src, "utf8") > MAX_CODE_BYTES) throw badRequest(`code too large (${Buffer.byteLength(src, "utf8")} bytes, cap ${MAX_CODE_BYTES})`);
  const timeoutMs = Math.min(Math.max(parseInt(timeout_ms, 10) || DEFAULT_TIMEOUT_MS, 1000), MAX_TIMEOUT_MS);
  const maxOut = Math.min(Math.max(parseInt(max_output_chars, 10) || 4000, 100), 20000);

  const out = await runInChild(src, timeoutMs, maxOut);
  return {
    lane: "/code-run",
    lang: "js",
    timeout_ms: timeoutMs,
    ...out,
    sandbox: {
      isolation: "forked child process, 64MB heap cap (--max-old-space-size=64); child death can never take the bridge down",
      code_context: "node vm, safe globals only — no require/process/fetch/timers/fs",
      child_hardening: "minimal env (no secrets); process.exit/kill/abort/binding/dlopen neutered, mainModule cleared, fetch/WebSocket stripped from child globalThis — tested against Function-constructor escape, OOM kill, parent-kill, and network-exfil attempts",
      vm_timeout_ms: 4500,
      network: "none",
      filesystem: "none",
      honesty: "Pragmatic sandbox, not a hardened enclave — safe for data-processing snippets, not for untrusted adversarial code.",
    },
  };
}

module.exports = { codeRun };
