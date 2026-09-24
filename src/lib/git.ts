// Git + worktree operations. The supervisor runs git in the main checkout;
// agents work inside per-issue worktrees.

import { existsSync, mkdirSync, writeFileSync, chmodSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { must, exec } from "./exec.js";

export async function git(root: string, args: string[], timeoutMs = 120_000): Promise<string> {
  return must("git", args, { cwd: root, timeoutMs });
}

export async function gitAllow(
  root: string,
  args: string[],
  timeoutMs = 120_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return exec("git", args, { cwd: root, timeoutMs });
}

/** Is `path` a registered worktree of this repo? */
export async function isWorktree(root: string, path: string): Promise<boolean> {
  if (!existsSync(path)) return false;
  const out = await git(root, ["worktree", "list", "--porcelain"]);
  return out
    .split("\n")
    .some((line) => line.startsWith("worktree ") && line.slice("worktree ".length) === path);
}

/**
 * Attribution hook installed into every agent worktree: appends the
 * co-author trailer to each commit made by an agent (idempotent).
 */
const HOOK = `#!/bin/sh
# issue_attack: mark every agent commit with a co-author trailer.
if ! grep -qi '^Co-authored-by: issue-attack' "$1" 2>/dev/null; then
  printf '\\nCo-authored-by: issue-attack <issue-attack@users.noreply.github.com>\\n' >> "$1"
fi
exit 0
`;

function hooksDir(root: string): string {
  return join(root, ".issue_attack", "hooks");
}

/** Install the shared hook + point this worktree's hooksPath at it (worktree-scoped config). */
async function setupHooks(root: string, path: string): Promise<void> {
  const dir = hooksDir(root);
  mkdirSync(dir, { recursive: true });
  const hookFile = join(dir, "prepare-commit-msg");
  if (!existsSync(hookFile) || readHook(hookFile) !== HOOK) {
    writeFileSync(hookFile, HOOK);
    chmodSync(hookFile, 0o755);
  }
  // core.hooksPath must be worktree-scoped or the operator's own commits in
  // the main checkout would get the trailer too.
  await git(root, ["config", "extensions.worktreeConfig", "true"]);
  await exec("git", ["config", "--worktree", "core.hooksPath", dir], { cwd: path });
}

function readHook(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/**
 * Ensure a worktree exists at `path` on `branch` (created from origin/base if
 * new). Reuses existing worktree/branch across attempts and resumes, and
 * installs the attribution hook on every entry.
 */
export async function ensureWorktree(
  root: string,
  path: string,
  branch: string,
  base: string
): Promise<void> {
  await git(root, ["fetch", "origin", base]);
  if (await isWorktree(root, path)) {
    await setupHooks(root, path);
    return;
  }

  const { code } = await gitAllow(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (code === 0) {
    // Branch exists locally (e.g. worktree was removed after a prior attempt).
    await git(root, ["worktree", "add", path, branch]);
  } else {
    await git(root, ["worktree", "add", "-b", branch, path, `origin/${base}`]);
  }
  await setupHooks(root, path);
}

/** Remove a worktree; force skips dirty-tree protection. */
export async function removeWorktree(root: string, path: string, force = false): Promise<boolean> {
  const args = ["worktree", "remove", path];
  if (force) args.push("--force");
  const { code, stderr } = await gitAllow(root, args);
  if (code !== 0 && !/already.*locked|not a working tree/i.test(stderr)) {
    throw new Error(`git worktree remove: ${stderr.trim()}`);
  }
  return code === 0;
}

/** True when the worktree has uncommitted changes. */
export async function isDirty(path: string): Promise<boolean> {
  const { code, stdout } = await exec("git", ["status", "--porcelain"], { cwd: path });
  if (code !== 0) return false;
  return stdout.trim().length > 0;
}

/** Delete a local branch (remote branches are never touched by this tool). */
export async function deleteLocalBranch(root: string, branch: string): Promise<void> {
  const { code } = await gitAllow(root, ["rev-parse", "--verify", `refs/heads/${branch}`]);
  if (code === 0) await git(root, ["branch", "-D", branch]);
}

export function worktreePath(root: string, issueNumber: number): string {
  return join(root, ".issue_attack", "worktrees", `issue-${issueNumber}`);
}

export function branchName(issueNumber: number): string {
  return `agent/issue-${issueNumber}`;
}

/** Resolve repo root from a directory inside it. */
export async function resolveRoot(from: string, explicit?: string): Promise<string | null> {
  if (explicit) return explicit;
  const { code, stdout } = await exec("git", ["rev-parse", "--show-toplevel"], { cwd: from });
  if (code !== 0) return null;
  return stdout.trim();
}
