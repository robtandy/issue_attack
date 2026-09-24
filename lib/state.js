// Local run registry (.issue_attack/state.json) + file-based control channel
// (inbox for steering messages, stop markers). The control channel is what
// lets `issue_attack steer|stop` talk to runners owned by another process.

import { readFileSync, writeFileSync, existsSync, renameSync, mkdirSync, appendFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { dirs } from "./config.js";

export function loadState(root) {
  const file = dirs(root).state;
  if (!existsSync(file)) return { runs: {} };
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return { runs: {} };
  }
}

export function saveState(root, state) {
  const file = dirs(root).state;
  mkdirSync(dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, file);
}

export function getEntry(state, issueNumber) {
  return state.runs[String(issueNumber)] ?? null;
}

export function setEntry(state, issueNumber, patch) {
  const key = String(issueNumber);
  const prev = state.runs[key] ?? {};
  const next = { ...prev, ...patch, issue: Number(issueNumber), updatedAt: new Date().toISOString() };
  state.runs[key] = next;
  return next;
}

// ---- Control channel ------------------------------------------------------

export function steerFilePath(root, issueNumber) {
  return join(dirs(root).inbox, `issue-${issueNumber}.jsonl`);
}

export function stopFilePath(root, issueNumber) {
  return join(dirs(root).stop, `issue-${issueNumber}`);
}

/** Append a steering message (safe across processes: O_APPEND line writes). */
export function writeSteer(root, issueNumber, message) {
  const file = steerFilePath(root, issueNumber);
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify({ at: new Date().toISOString(), message }) + "\n");
}

/** Consume pending steering messages (rename-then-read avoids partial reads). */
export function takeSteer(root, issueNumber) {
  const file = steerFilePath(root, issueNumber);
  if (!existsSync(file)) return [];
  const take = file + ".taking";
  try {
    renameSync(file, take);
  } catch {
    return []; // another runner just consumed it
  }
  try {
    return readFileSync(take, "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
  } finally {
    rmSync(take, { force: true });
  }
}

export function setStop(root, issueNumber) {
  const file = stopFilePath(root, issueNumber);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, new Date().toISOString());
}

export function takeStop(root, issueNumber) {
  const file = stopFilePath(root, issueNumber);
  if (!existsSync(file)) return false;
  try {
    rmSync(file, { force: true });
    return true;
  } catch {
    return false;
  }
}

export function isPidAlive(pid) {
  if (!pid || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === "EPERM"; // exists but not ours
  }
}

/**
 * Reconcile stale state: any run still marked "running" whose supervisor pid
 * is gone is marked failed (its orphaned pi child, if any, is killed).
 * Returns the (possibly updated) state.
 */
export function reconcile(root) {
  const state = loadState(root);
  let changed = 0;
  for (const e of Object.values(state.runs)) {
    if (e.status === "running" && !isPidAlive(e.supervisorPid)) {
      if (e.piPid && isPidAlive(e.piPid)) {
        try {
          process.kill(e.piPid, "SIGTERM");
        } catch {
          /* already gone */
        }
      }
      e.status = "failed";
      e.endedAt = new Date().toISOString();
      e.note = "supervisor exited before the run finished";
      e.piPid = null;
      changed++;
    }
  }
  if (changed) saveState(root, state);
  return { state, changed };
}
