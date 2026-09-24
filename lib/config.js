// Configuration: defaults merged with .issue_attack/config.json in the repo root.
// CLI flags override config values at the call site.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

export const DEFAULTS = {
  // Issue claiming
  label: "agent-ready", // issues carrying this label are candidates
  claimedLabel: "agent-claimed",
  blockedLabel: "agent-blocked",
  doneLabel: "agent-done",
  prLabel: "agent", // label applied to PRs opened by agents

  // Fleet sizing
  maxConcurrent: 3,
  maxAttempts: 2, // total supervised attempts per issue per run
  pollSeconds: 60, // --watch polling interval

  // Budgets
  timeBudgetMinutes: 45, // hard wall-clock budget per attempt
  softBudgetRatio: 0.8, // steer "wrap up" at 80% of time/cost budget
  costBudgetUsd: 5.0, // hard model cost budget per attempt (null disables)
  maxTokens: null, // hard session token budget (null disables)

  // Issue interaction
  heartbeatMinutes: 10, // progress comment interval (0 disables)
  recentComments: 5, // comments inlined into the task prompt
  commentSteerSeconds: 30, // poll issue comments to steer live agents (0 disables)

  // Status page (GitHub Pages)
  statusBranch: "gh-pages", // branch the dashboard is published to
  statusPublishMinutes: 2, // dashboard refresh cadence (0 disables)

  // Worker runtime
  model: null, // e.g. "sonnet:high" passed to pi --model
  piBin: "pi",
  baseBranch: null, // defaults to the repository default branch
  prDraft: false, // open PRs as drafts
  approve: true, // pass -a to pi (trust project-local config in the worktree)
  noExtensions: false, // start workers with --no-extensions
  extraFlags: [], // extra raw flags passed to pi
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

export function loadConfig(root) {
  const cfg = { ...DEFAULTS };
  const file = configPath(root);
  if (existsSync(file)) {
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8"));
      Object.assign(cfg, parsed);
    } catch (err) {
      throw new Error(`Invalid config JSON at ${file}: ${err.message}`);
    }
  }
  return cfg;
}
