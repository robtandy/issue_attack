// Configuration: defaults merged with .issue_attack/config.json in the repo root.
// CLI flags override config values at the call site.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = {
  // Issue claiming
  label: "issue-attack-ready", // issues carrying this label are candidates
  claimedLabel: "issue-attack-claimed",
  blockedLabel: "issue-attack-blocked",
  doneLabel: "issue-attack-done",
  prLabel: "issue-attack", // label applied to PRs opened by agents

  // Fleet sizing
  maxConcurrent: 3,
  maxAttempts: 2, // total supervised attempts per issue per run
  pollSeconds: 60, // --watch polling interval
  claimOrder: "updatedAt", // claim ordering: "updatedAt" | "createdAt" | "number" (see gh.sortIssuesByOrder)

  // Issue interaction
  heartbeatMinutes: 10, // progress comment interval (0 disables)
  recentComments: 5, // comments inlined into the task prompt
  commentSteerSeconds: 30, // poll issue comments to steer live agents (0 disables)

  branchTemplate: "agent/issue-{n}", // {n} = issue number; e.g. "rob/ia-{n}" or "{n}-fix"
  mergeOnApprove: true, // reviewer merges approved PRs; false for repos where humans merge
  model: null, // e.g. "sonnet:high" — REQUIRED: init prompts with a searchable picker; ia never falls back to pi's default
  reviewModel: null, // model for `ia review` agents; falls back to `model`
  cleanupWorktreeOnMerge: true, // remove the worktree when its PR MERGES (kept while iterating on feedback)
  piBin: "pi",
  baseBranch: null, // defaults to the repository default branch
  prDraft: false, // open PRs as drafts
  approve: true, // pass -a to pi (trust project-local config in the worktree)
  noExtensions: false, // start workers with --no-extensions
  extraFlags: [], // extra raw flags passed to pi

  // GitHub account
  ghAccount: null, // login pinned for this repo (set by `init` / `account`); null = whatever gh has active
};

export function configPath(root) {
  return join(root, ".issue_attack", "config.json");
}

/** All runtime directories live under .issue_attack/ (gitignored). */
export function dirs(root) {
  const base = join(root, ".issue_attack");
  return {
    base,
    worktrees: join(base, "worktrees"),
    sessions: join(base, "sessions"),
    logs: join(base, "logs"),
    inbox: join(base, "inbox"),
    stop: join(base, "stop"),
    config: join(base, "config.json"),
    state: join(base, "state.json"),
  };
}

/** Valid claimOrder values. "updatedAt" (default) keeps the operator's
 *  deliberate ready-label ordering but re-queues issues on any later edit;
 *  "createdAt" is immune to edits; "number" is fully deterministic. */
export const CLAIM_ORDERS = ["updatedAt", "createdAt", "number"];

/** Keys accepted by older issue_attack versions but removed since. They are
 *  silently ignored today — the fleet behaves as if they were never set. */
export const REMOVED_KEYS = {
  statusBranch: "the status page was removed entirely",
  statusPublishMinutes: "the status page was removed entirely",
  timeBudgetMinutes: "budgets were removed — runs are unbounded by design",
  softBudgetRatio: "budgets were removed — runs are unbounded by design",
  costBudgetUsd: "budgets were removed — runs are unbounded by design",
  maxTokens: "budgets were removed — runs are unbounded by design",
};

/** Read the raw config.json object (null when absent). Throws with the file
 *  path on malformed JSON — the same error loadConfig has always raised. */
function readConfigFile(root) {
  const file = configPath(root);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`Invalid config JSON at ${file}: ${err.message}`);
  }
}

export function loadConfig(root) {
  const cfg = { ...DEFAULTS };
  const parsed = readConfigFile(root);
  if (parsed) Object.assign(cfg, parsed);
  return cfg;
}

/** Warnings for a raw config.json object: removed keys that silently do
 *  nothing, unknown keys that are likely typos, and invalid enum values.
 *  Empty when the file is clean. */
export function configWarnings(parsed) {
  const warnings = [];
  for (const [k, v] of Object.entries(parsed ?? {})) {
    if (k in REMOVED_KEYS) {
      warnings.push(`"${k}" no longer does anything (${REMOVED_KEYS[k]}) — remove it from config.json`);
    } else if (!(k in DEFAULTS)) {
      warnings.push(`unknown config key "${k}" — typo, or from a newer issue_attack? (valid keys: lib/config.js DEFAULTS)`);
    } else if (k === "claimOrder" && !CLAIM_ORDERS.includes(v)) {
      warnings.push(`claimOrder "${v}" is invalid — use one of: ${CLAIM_ORDERS.join(", ")} (falling back to "updatedAt")`);
    }
  }
  return warnings;
}

/** Config plus file warnings — entry points print these once so stale keys
 *  stop silently no-op'ing. */
export function loadConfigWithWarnings(root) {
  const parsed = readConfigFile(root);
  return { config: loadConfig(root), warnings: configWarnings(parsed) };
}
