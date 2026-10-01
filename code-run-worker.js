// TrollBridge /code-run worker — runs as a FORKED CHILD PROCESS with
// --max-old-space-size=64 (set by the parent in code-run.js).
//
// Why a child process and not a worker thread: a single huge allocation
// (e.g. new Array(1e12)) takes V8 down its hard OOM-abort path, which
// kills the entire process even from a worker thread. A forked child
// dying can never take the bridge server with it — the parent just sees
// a nonzero exit and reports verdict "crashed".
//
// The agent's code runs inside a vm context exposing ONLY safe globals:
// no require, no process, no fetch, no timers, no fs. vm-level timeout
// (4.5s) stops infinite loops; the parent SIGKILLs at the requested
// timeout as a backstop. Result is printed as one JSON line on stdout.
const vm = require("vm");

const code = process.env.CODE_RUN_CODE || "";
const maxOut = Math.min(Math.max(parseInt(process.env.CODE_RUN_MAXOUT || "4000", 10) || 4000, 100), 20000);

// SECURITY: Node documents the vm module as NOT a security boundary —
// the context's Function constructor can reach the host (here: this
// child process). So BEFORE running agent code, neuter the child's own
// process object. Assume the agent obtains `process`; with these patches
// the worst it can do is crash its own sandbox (which costs it the toll
// and affects nothing else). The child also inherits a MINIMAL env from
// the parent (no secrets to exfiltrate).
const _exit = process.exit.bind(process);
try { process.exit = () => { throw new Error("process.exit is disabled in the sandbox"); }; } catch { /* non-writable: ignore */ }
try { process.kill = () => { throw new Error("process.kill is disabled in the sandbox"); }; } catch { /* ignore */ }
try { process.abort = () => { throw new Error("process.abort is disabled in the sandbox"); }; } catch { /* ignore */ }
try { process.binding = () => { throw new Error("process.binding is disabled in the sandbox"); }; } catch { /* ignore */ }
try { process.dlopen = () => { throw new Error("process.dlopen is disabled in the sandbox"); }; } catch { /* ignore */ }
try { process.mainModule = undefined; } catch { /* ignore */ }
// Strip network-capable globals from the child: the vm Function-
// constructor escape reaches the child's real globalThis, so fetch /
// WebSocket must not exist there. (The agent's vm sandbox never had them.)
try { globalThis.fetch = undefined; } catch { /* ignore */ }
try { globalThis.WebSocket = undefined; } catch { /* ignore */ }

const logs = [];
const fmt = (v) => {
  try {
    const s = typeof v === "string" ? v : JSON.stringify(v);
    return String(s).slice(0, 2000);
  } catch {
    return String(v).slice(0, 2000);
  }
};
const sandboxConsole = {
  log: (...a) => logs.push(a.map(fmt).join(" ")),
  error: (...a) => logs.push("[error] " + a.map(fmt).join(" ")),
  warn: (...a) => logs.push("[warn] " + a.map(fmt).join(" ")),
  info: (...a) => logs.push("[info] " + a.map(fmt).join(" ")),
};
// NOTE: only data/compute intrinsics. No require, process, fetch,
// setTimeout/setInterval, Buffer, or module system — the agent's code
// cannot reach the host's I/O no matter what it tries.
const sandbox = {
  console: sandboxConsole,
  Math, JSON, String, Number, Boolean, BigInt, Array, Object, Date,
  RegExp, Error, TypeError, RangeError, SyntaxError, ReferenceError,
  Map, Set, WeakMap, WeakSet, Symbol, Proxy, Reflect,
  parseInt, parseFloat, isNaN, isFinite,
  encodeURI, decodeURI, encodeURIComponent, decodeURIComponent,
  Intl, structuredClone, atob, btoa,
};

function safeResult(v) {
  try {
    const seen = new Set();
    const s = JSON.stringify(v, (k, x) => {
      if (typeof x === "bigint") return x.toString() + "n";
      if (typeof x === "function") return "[function]";
      if (typeof x === "symbol") return "[symbol]";
      if (x && typeof x === "object") {
        if (seen.has(x)) return "[circular]";
        seen.add(x);
      }
      return x;
    });
    return (s === undefined ? String(v) : s).slice(0, maxOut);
  } catch {
    return String(v).slice(0, maxOut);
  }
}

const started = Date.now();
let msg;
try {
  const script = new vm.Script(code, { filename: "agent-snippet.js" });
  const result = script.runInNewContext(sandbox, { timeout: 4500, displayErrors: true });
  msg = { verdict: "ok", result: safeResult(result), execution_ms: Date.now() - started };
} catch (e) {
  const em = String((e && e.message) || e);
  msg = {
    verdict: /timed out/i.test(em) ? "timeout" : "error",
    error: em.slice(0, 1000),
    execution_ms: Date.now() - started,
  };
}
msg.logs = logs.join("\n").slice(0, maxOut);
process.stdout.write(JSON.stringify(msg) + "\n", () => _exit(0));
