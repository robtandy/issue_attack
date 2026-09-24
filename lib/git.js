// Git + worktree operations. The supervisor runs git in the main checkout;
// agents work inside per-issue worktrees.

import { existsSync } from "node:fs";
import { join } from "node:path";
import { must, exec } from "./exec.js";

export async function git(root, args, opts = {}) {
  return must("git", args, { cwd: root, timeoutMs: opts.timeoutMs ?? 120_000 });
}

export async function gitAllow(root, args, opts = {}) {
  return exec("git", args, { cwd: root, timeoutMs: opts.timeoutMs ?? 120_000 });
}

/** Is `path` a registered worktree of this repo? */
export async function isWorktree(root, path) {
  if (!existsSync(path)) return false;
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .some((line) => line.startsWith("worktree ") && line.slice("worktree ".length) === path);
}

/**
 * Ensure a worktree exists at `path` on `branch` (created from origin/base if
 * new). Reuses existing worktree/branch across attempts and resumes.
 */
export async function ensureWorktree(root, path, branch, base) {
  await git(root, ["fetch", "origin", base]);
  if (await isWorktree(root, path)) return { created: false };

  const { code } = await gitAllow(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (code === 0) {
    // Branch exists locally (e.g. worktree was removed after a prior attempt).
    await git(root, ["worktree", "add", path, branch]);
    return { created: true };
  }
  await git(root, ["worktree", "add", "-b", branch, path, `origin/${base}`]);
  return { created: true };
}

/** Remove a worktree; force skips dirty-tree protection. */
export async function removeWorktree(root, path, force = false) {
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  const { code, stderr } = await gitAllow(root, args);
  if (code !== 0 && !/already.*locked|not a working tree/i.test(stderr)) {
    throw new Error(`git worktree remove: ${stderr.trim()}`);
  }
  return code === 0;
}

/** True when the worktree has uncommitted changes. */
export async function isDirty(path) {
  const { code, stdout } = await exec("git", ["status", "--porcelain"], { cwd: path });
  if (code !== 0) return false;
  return stdout.trim().length > 0;
}

/** Delete a local branch (remote branches are never touched by this tool). */
export async function deleteLocalBranch(root, branch) {
  const { code } = await gitAllow(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (code === 0) await git(root, ["branch", "-D", branch]);
}

export function worktreePath(root, issueNumber) {
  return join(root, ".issue_attack", "worktrees", `issue-${issueNumber}`);
}

export function branchName(issueNumber) {
  return `agent/issue-${issueNumber}`;
}

/** Resolve repo root from a directory inside it. */
export async function resolveRoot(from = process.cwd(), explicit) {
  if (explicit) return explicit;
  const { code, stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: from });
  if (code !== 0) return null;
  return stdout.trim();
}
