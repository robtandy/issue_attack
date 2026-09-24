// Status page publishing: renders the fleet state to a JSON payload and
// force-pushes it (plus the dashboard HTML) to a dedicated branch. A GitHub
// Actions workflow on the default branch deploys the branch to GitHub Pages
// on every push — the sanctioned path for frequent deploys, since
// branch-based Pages builds are rate-limited to ~10/hour (see DESIGN.md).
//
// Publishing uses git plumbing (hash-object / mktree / commit-tree) so no
// worktree is needed and every publish is a fresh, self-contained commit —
// history never grows.
//
// The dashboard HTML ships with the package (assets/status-page.html) and is
// published verbatim next to status.json.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { hostname } from "node:os";
import { exec, must } from "./exec.js";
import * as gh from "./gh.js";
import * as stateMod from "./state.js";
import { Config } from "./config.js";

interface RepoInfo {
  nameWithOwner: string;
  defaultBranch: string;
}

interface AgentEntry {
  issue: number;
  issueUrl?: string;
  title?: string;
  status?: string;
  branch?: string;
  prUrl?: string;
  startedAt?: string;
  endedAt?: string;
  updatedAt?: string;
  lastAgentUpdateAt?: string;
  lastAction?: string;
  cost?: number;
  tokens?: number;
  model?: string;
  sessionId?: string;
  note?: string;
  attempts?: number;
  prNumber?: number;
  conflicts?: boolean;
}

interface StatusPayload {
  generatedAt: string;
  generatedBy: string;
  repo: string;
  repoUrl: string;
  defaultBranch: string;
  host: string;
  publishCadenceSeconds: number;
  agents: Array<{
    issue: number;
    issueUrl: string;
    title: string;
    status: string;
    attempt: number;
    branch: string | null;
    branchUrl: string | null;
    prUrl: string | null;
    prNumber: number | null;
    conflicts: boolean;
    startedAt: string | null;
    endedAt: string | null;
    lastAgentUpdateAt: string | null;
    lastAction: string | null;
    cost: number | null;
    tokens: number | null;
    model: string | null;
    session: string | null;
    note: string | null;
  }>;
  unclaimed: Array<{
    issue: number;
    issueUrl: string;
    title: string;
    updatedAt?: string;
  }>;
}

interface PublishResult {
  skipped?: string;
  pushed?: boolean;
  at?: string;
  agents?: number;
}

interface PageUrlResult {
  ok: boolean;
  created?: boolean;
  needsForce?: boolean;
  error?: string;
  warn?: string;
}

const VERSION = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
).version as string;
const ASSET = fileURLToPath(new URL("../../assets/status-page.html", import.meta.url));

const COMMIT_ENV = {
  GIT_AUTHOR_NAME: "issue_attack",
  GIT_AUTHOR_EMAIL: "issue_attack@agents",
  GIT_COMMITTER_NAME: "issue_attack",
  GIT_COMMITTER_EMAIL: "issue_attack@agents",
};

/** Deploy workflow committed to the default branch by `page init`. */
export function workflowYaml(statusBranch: string): string {
  return `# Deployed by issue_attack — publishes the agent fleet status page.
# Every status publish force-pushes ${statusBranch}; this workflow deploys it.
# (Actions-based deploys are not subject to the ~10/hour Pages build limit.)
name: issue_attack status page
on:
  push:
    branches: [${statusBranch}]
  workflow_dispatch:
  schedule:
    - cron: "*/15 * * * *" # safety net: redeploy latest state if a run was cancelled
permissions:
  contents: read
jobs:
  deploy:
    runs-on: ubuntu-latest
    permissions:
      pages: write
      id-token: write
    environment:
      name: github-pages
      url: \${{ steps.deploy.outputs.page_url }}
    concurrency:
      group: pages
      cancel-in-progress: true
    steps:
      - uses: actions/checkout@v4
        with:
          ref: ${statusBranch}
      - uses: actions/upload-pages-artifact@v3
        with:
          path: "."
      - id: deploy
        uses: actions/deploy-pages@v4
`;
}

/**
 * Build the status.json payload from local state. Enriches (and caches back)
 * issue titles/urls for entries that predate this feature. Also fetches
 * unclaimed issues (agent-ready but not agent-claimed).
 */
export async function buildPayload(
  root: string,
  repoInfo: RepoInfo,
  config?: Config
): Promise<StatusPayload> {
  const repo = repoInfo.nameWithOwner;
  const repoUrl = `https://github.com/${repo}`;
  const state = stateMod.loadState(root);
  const label = config?.label ?? "agent-ready";
  const claimedLabel = config?.claimedLabel ?? "agent-claimed";

  const entries = Object.values(state.runs)
    .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")))
    .slice(0, 40);

  // Self-healing title cache (bounded so publishes stay fast).
  let enriched = 0;
  for (const e of entries) {
    if ((e.title && e.issueUrl) || enriched >= 5) continue;
    enriched++;
    try {
      const rec = await gh.viewIssue(root, repo, e.issue);
      e.title = rec.title;
      e.issueUrl = rec.url;
      stateMod.setEntry(state, e.issue, { title: rec.title, issueUrl: rec.url });
      stateMod.saveState(root, state);
    } catch {
      /* issue may be deleted or inaccessible; leave untitled */
    }
  }

  const rank: Record<string, number> = { running: 0, blocked: 1 };
  const agents = entries
    .map((e) => ({
      issue: e.issue,
      issueUrl: e.issueUrl ?? `${repoUrl}/issues/${e.issue}`,
      title: e.title ?? `issue #${e.issue}`,
      status: e.status ?? "unknown",
      attempt: (e.attempts ?? 1) as number,
      branch: (e.branch ?? null) as string | null,
      branchUrl: e.branch ? `${repoUrl}/tree/${e.branch}` : null,
      prUrl: (e.prUrl ?? null) as string | null,
      prNumber: (e.prNumber ?? null) as number | null,
      conflicts: (e.conflicts ?? false) as boolean,
      startedAt: (e.startedAt ?? null) as string | null,
      endedAt: (e.endedAt ?? null) as string | null,
      lastAgentUpdateAt: (e.lastAgentUpdateAt ?? e.endedAt ?? e.updatedAt ?? null) as string | null,
      lastAction: (e.lastAction ?? null) as string | null,
      cost: (e.cost ?? null) as number | null,
      tokens: (e.tokens ?? null) as number | null,
      model: (e.model ?? null) as string | null,
      session: (e.sessionId ?? null) as string | null,
      note: (e.note ?? null) as string | null,
    }))
    .sort(
      (a, b) =>
        (rank[a.status] ?? 2) - (rank[b.status] ?? 2) ||
        String(b.lastAgentUpdateAt ?? "").localeCompare(String(a.lastAgentUpdateAt ?? ""))
    );

  // Fetch unclaimed issues (agent-ready but not agent-claimed)
  let unclaimed: Array<{ issue: number; issueUrl: string; title: string; updatedAt?: string }> = [];
  try {
    const readyIssues = await gh.listIssues(root, repo, label, 100);
    unclaimed = readyIssues
      .filter((issue) => !issue.labels?.some((l) => l.name === claimedLabel))
      .map((issue) => ({
        issue: issue.number,
        issueUrl: `${repoUrl}/issues/${issue.number}`,
        title: issue.title,
        updatedAt: issue.updatedAt,
      }))
      .sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
  } catch {
    /* unclaimed issues may be unavailable; continue without them */
  }

  return {
    generatedAt: new Date().toISOString(),
    generatedBy: `issue_attack ${VERSION}`,
    repo,
    repoUrl,
    defaultBranch: repoInfo.defaultBranch,
    host: hostname(),
    publishCadenceSeconds: (config?.statusPublishMinutes ?? 2) * 60,
    agents,
    unclaimed,
  };
}

let chain: Promise<PublishResult> = Promise.resolve({ skipped: "" } as PublishResult); // serialized publishes: terminal states are never dropped
let lastPublishAt = 0;

/**
 * Publish the dashboard + status.json to config.statusBranch.
 * All calls are serialized (queued, not dropped); throttled by
 * config.statusPublishMinutes unless `force` (init, manual publish, and
 * terminal states). Each push triggers the deploy workflow on GitHub.
 */
export function publishStatus(
  root: string,
  repoInfo: RepoInfo,
  config: Config,
  { force = false } = {}
): Promise<PublishResult> {
  const task = () => doPublish(root, repoInfo, config, force);
  const result = chain.then(task, task);
  chain = result.catch(() => ({ error: "publish failed" } as unknown as PublishResult));
  return result;
}

async function doPublish(root: string, repoInfo: RepoInfo, config: Config, force: boolean): Promise<PublishResult> {
  if (!force && (config.statusPublishMinutes ?? 0) <= 0) return { skipped: "disabled" };
  if (!force && Date.now() - lastPublishAt < (config.statusPublishMinutes ?? 2) * 60_000) {
    return { skipped: "throttled" };
  }
  lastPublishAt = Date.now();
  const payload = await buildPayload(root, repoInfo, config);
  const json = JSON.stringify(payload, null, 2) + "\n";
  const html = readFileSync(ASSET, "utf8");
  const branch = config.statusBranch ?? "gh-pages";

  // Three blobs: the dashboard, the data, and the deploy workflow that
  // carries them to Pages (push triggers read the workflow from the pushed
  // ref, so it travels inside every publish — the branch is self-contained).
  const sha = async (content: string): Promise<string> =>
    (await must("git", ["hash-object", "-w", "--stdin"], { cwd: root, input: content })).trim();
  const mk = async (
    entries: Array<{ mode: string; type: string; sha: string; name: string }>
  ): Promise<string> =>
    (
      await must("git", ["mktree"], {
        cwd: root,
        input: entries.map((e) => `${e.mode} ${e.type} ${e.sha}\t${e.name}`).join("\n") + "\n",
      })
    ).trim();

  const htmlSha = await sha(html);
  const jsonSha = await sha(json);
  const wfSha = await sha(workflowYaml(branch));
  const ymlTree = await mk([{ mode: "100644", type: "blob", sha: wfSha, name: "issue_attack-status.yml" }]);
  const ghTree = await mk([{ mode: "040000", type: "tree", sha: ymlTree, name: "workflows" }]);
  const tree = await mk([
    { mode: "040000", type: "tree", sha: ghTree, name: ".github" },
    { mode: "100644", type: "blob", sha: htmlSha, name: "index.html" },
    { mode: "100644", type: "blob", sha: jsonSha, name: "status.json" },
  ]);
  const commit = (
    await must("git", ["commit-tree", tree, "-m", `agent status ${payload.generatedAt}`], {
      cwd: root,
      env: COMMIT_ENV,
    })
  ).trim();
  await must("git", ["push", "--force", "origin", `${commit}:refs/heads/${branch}`], {
    cwd: root,
  });
  return { pushed: true, at: payload.generatedAt, agents: payload.agents.length };
}

// ---- GitHub Pages configuration ------------------------------------------------------

const pagesState = async (
  root: string,
  repo: string
): Promise<Record<string, unknown> | null> => {
  const { code, stdout } = await exec("gh", ["api", `repos/${repo}/pages`], { cwd: root });
  if (code !== 0) return null;
  try {
    return JSON.parse(stdout) as Record<string, unknown>;
  } catch {
    return null;
  }
};

/** GitHub Pages site URL for the repo, or null when Pages isn't enabled. */
export async function pageUrl(root: string, repo: string): Promise<string | null> {
  const state = await pagesState(root, repo);
  return (state?.html_url as string | null) ?? null;
}

// gh api can choke ("unexpected end of JSON input") on empty 2xx bodies even
// when the request succeeded — observed with 201/204 responses.
const isGhEmptyBodyQuirk = (stderr: string | undefined): boolean =>
  /unexpected end of JSON input|empty/i.test(stderr ?? "");

/**
 * Enable GitHub Pages served by the deploy workflow:
 * - create the site (build_type workflow) if absent,
 * - re-point / convert it if it exists in another configuration (needs force).
 */
export async function enablePages(
  root: string,
  repo: string,
  statusBranch: string,
  { force = false } = {}
): Promise<PageUrlResult> {
  const current = await pagesState(root, repo);

  if ((current as any)?.build_type === "workflow") return { ok: true, created: false };

  if (current) {
    const hijack = (current as any)?.source?.branch !== statusBranch;
    if (hijack && !force) {
      return {
        ok: false,
        needsForce: true,
        error: `Pages already serves branch '${(current as any)?.source?.branch}' with build_type '${(current as any)?.build_type}'. Re-run with --force to convert it to the issue_attack dashboard.`,
      };
    }
  }

  if (!current) {
    const { code, stderr } = await exec("gh", ["api", "-X", "POST", `repos/${repo}/pages`, "--input", "-"], {
      cwd: root,
      input: JSON.stringify({ build_type: "workflow" }),
    });
    if (code !== 0 && !isGhEmptyBodyQuirk(stderr)) {
      // Some API versions require a legacy source at creation; create then convert.
      const legacy = await exec("gh", ["api", "-X", "POST", `repos/${repo}/pages`, "--input", "-"], {
        cwd: root,
        input: JSON.stringify({ source: { branch: statusBranch, path: "/" } }),
      });
      if (legacy.code !== 0 && !isGhEmptyBodyQuirk(legacy.stderr)) {
        return { ok: false, error: (stderr || legacy.stderr).trim() };
      }
    }
  }

  // Convert to Actions-based deploys (exempt from the ~10/hour build limit).
  const put = await exec("gh", ["api", "-X", "PUT", `repos/${repo}/pages`, "--input", "-"], {
    cwd: root,
    input: JSON.stringify({ build_type: "workflow" }),
  });
  const after = await pagesState(root, repo);
  if ((after as any)?.build_type === "workflow") return { ok: true, created: !current };
  if (put.code === 0 || isGhEmptyBodyQuirk(put.stderr)) {
    return { ok: true, created: !current, warn: "could not confirm build_type=workflow" };
  }
  return {
    ok: after != null,
    created: !current,
    error: after
      ? `deploys may be rate-limited (Pages build_type stayed '${(after as any)?.build_type}')`
      : put.stderr.trim(),
  };
}
