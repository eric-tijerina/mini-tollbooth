// TrollBridge lane #16: /file-pr — PR filing for AI agents.
// The exact pipeline proven on 2026-09-29 (xpaysh/awesome-x402 PR #1659):
// fork the target public repo under the keeper's account, cut a branch via
// the GitHub API, commit the file byte-precise, open the PR. No web editor,
// no mangling. Runs on Render with GITHUB_TOKEN (fine-grained PAT: Contents
// + Pull requests read/write on the keeper's repos).
//
// v1 guardrails: public repos only, one file per call, 100KB content cap,
// caller picks the branch name (must not exist yet). The keeper's fork is
// synced to upstream before branching so the PR diff is exactly the caller's
// change.

const GH_API = "https://api.github.com";
const FORK_OWNER = "eric-tijerina";
const MAX_CONTENT_BYTES = 100 * 1024;
const REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]+$/;
const FORK_POLL_MS = 60000;
const FORK_POLL_STEP_MS = 3000;

function ghError(statusCode, message) {
  const e = new Error(message);
  e.statusCode = statusCode;
  return e;
}

async function gh(token, method, apiPath, body) {
  const res = await fetch(GH_API + apiPath, {
    method,
    headers: {
      Authorization: "Bearer " + token,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      "User-Agent": "TrollBridge-file-pr",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });
  let json = null;
  try {
    json = await res.json();
  } catch { /* non-JSON (rare) */ }
  if (!res.ok) {
    const msg = (json && json.message) || `GitHub API ${res.status}`;
    throw ghError(res.status >= 500 ? 502 : res.status, msg);
  }
  return json;
}

function validateInput(b) {
  const need = ["repo", "path", "content", "branch", "pr_title"];
  const missing = need.filter((k) => typeof b[k] !== "string" || !b[k].trim());
  if (missing.length) throw ghError(400, `missing fields: ${missing.join(", ")}`);
  const repo = b.repo.trim();
  if (!REPO_RE.test(repo)) throw ghError(400, "repo must be owner/name (e.g. xpaysh/awesome-x402)");
  let filePath = b.path.trim().replace(/^\/+/, "");
  if (!filePath || filePath.includes("..") || filePath.length > 400 || filePath.includes("\0"))
    throw ghError(400, "path must be a relative file path without .. (max 400 chars)");
  const content = b.content;
  if (Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES)
    throw ghError(400, `content exceeds ${MAX_CONTENT_BYTES / 1024}KB cap`);
  const branch = b.branch.trim();
  if (!BRANCH_RE.test(branch) || branch.length > 100 || branch.startsWith("/") || branch.endsWith("/"))
    throw ghError(400, "branch must be a valid new git branch name (letters, numbers, . _ - /, max 100 chars)");
  if (b.pr_body !== undefined && typeof b.pr_body !== "string")
    throw ghError(400, "pr_body must be a string");
  if (b.pr_body && Buffer.byteLength(b.pr_body, "utf8") > 32 * 1024)
    throw ghError(400, "pr_body exceeds 32KB cap");
  return { repo, filePath, content, branch, prTitle: b.pr_title.trim(), prBody: (b.pr_body || "").trim() };
}

async function waitForFork(token, forkFullName) {
  const deadline = Date.now() + FORK_POLL_MS;
  for (;;) {
    try {
      await gh(token, "GET", `/repos/${forkFullName}`);
      return;
    } catch (e) {
      if (e.statusCode !== 404) throw e;
    }
    if (Date.now() >= deadline) throw ghError(502, "fork not ready after 60s — try again");
    await new Promise((r) => setTimeout(r, FORK_POLL_STEP_MS));
  }
}

// filePr(input, token) -> { pr_url, pr_number, branch, fork, repo }
// Throws with .statusCode for HTTP mapping (400 caller error, 502 GitHub-side).
async function filePr(input, token) {
  if (!token) throw ghError(503, "file-pr lane not configured yet (GITHUB_TOKEN missing)");
  const { repo, filePath, content, branch, prTitle, prBody } = validateInput(input);
  const [owner, name] = repo.split("/");

  // 1. Target must exist and be public.
  const target = await gh(token, "GET", `/repos/${repo}`);
  if (target.private) throw ghError(400, "private repos are not supported — public repos only");
  const defaultBranch = target.default_branch || "main";

  // 2. Work repo: own repos directly, everything else via the keeper's fork.
  let workRepo = repo;
  let forkOwner = owner;
  if (owner.toLowerCase() !== FORK_OWNER) {
    const forkFullName = `${FORK_OWNER}/${name}`;
    try {
      await gh(token, "GET", `/repos/${forkFullName}`);
    } catch (e) {
      if (e.statusCode !== 404) throw e;
      await gh(token, "POST", `/repos/${repo}/forks`, { default_branch_only: true });
      await waitForFork(token, forkFullName);
    }
    // Sync the fork's default branch to upstream so the PR diff is exactly
    // the caller's change (best-effort: a stale fork still works, diff just
    // shows more).
    try {
      await gh(token, "POST", `/repos/${forkFullName}/merge-upstream`, { branch: defaultBranch });
    } catch { /* non-fatal */ }
    workRepo = forkFullName;
    forkOwner = FORK_OWNER;
  }

  // 3. Cut the branch from the work repo's default HEAD.
  let baseSha;
  try {
    const ref = await gh(token, "GET", `/repos/${workRepo}/git/ref/heads/${defaultBranch}`);
    baseSha = ref.object.sha;
  } catch (e) {
    throw ghError(502, `could not read default branch ${defaultBranch}: ${e.message}`);
  }
  try {
    await gh(token, "POST", `/repos/${workRepo}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
  } catch (e) {
    if (e.statusCode === 422) throw ghError(409, `branch "${branch}" already exists — pick another name`);
    throw e;
  }

  // 4. Commit the file (create or replace), byte-precise via the API.
  let existingSha = null;
  try {
    const cur = await gh(
      token,
      "GET",
      `/repos/${workRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}?ref=${encodeURIComponent(branch)}`
    );
    if (cur && cur.sha && !cur.truncated) existingSha = cur.sha;
  } catch (e) {
    if (e.statusCode !== 404) throw e;
  }
  const putBody = {
    message: prTitle,
    content: Buffer.from(content, "utf8").toString("base64"),
    branch,
  };
  if (existingSha) putBody.sha = existingSha;
  await gh(
    token,
    "PUT",
    `/repos/${workRepo}/contents/${encodeURIComponent(filePath).replace(/%2F/g, "/")}`,
    putBody
  );

  // 5. Open the PR against upstream.
  const pr = await gh(token, "POST", `/repos/${repo}/pulls`, {
    title: prTitle,
    head: `${forkOwner}:${branch}`,
    base: defaultBranch,
    body: prBody || undefined,
    maintainer_can_modify: true,
  });
  return {
    status: "filed",
    pr_url: pr.html_url,
    pr_number: pr.number,
    repo,
    branch,
    fork: workRepo,
  };
}

module.exports = { filePr, MAX_CONTENT_BYTES };
