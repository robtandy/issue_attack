import { test } from "node:test";
import * as assert from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as stateMod from "../lib/state.js";
import { loadConfig } from "../lib/config.js";

test("acquireLock prevents concurrent access", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "issue-attack-test-"));
  try {
    // Initialize the required state files
    const state = { runs: {} };
    stateMod.saveState(tmpRoot, state);
    
    // Acquire a lock
    const release1 = stateMod.acquireLock(tmpRoot, "test-lock", 5000);
    assert.ok(typeof release1 === "function", "acquireLock should return a release function");
    
    // Try to acquire the same lock with a short timeout
    let timedOut = false;
    try {
      stateMod.acquireLock(tmpRoot, "test-lock", 100);
    } catch (err) {
      timedOut = true;
      assert.ok(err.message.includes("lock-timeout") || err.message.includes("failed to acquire lock"));
    }
    assert.ok(timedOut, "Second lock acquisition should timeout");
    
    // Release the first lock
    release1();
    
    // Now we should be able to acquire the lock again
    const release2 = stateMod.acquireLock(tmpRoot, "test-lock", 5000);
    assert.ok(typeof release2 === "function", "Lock should be acquirable after release");
    release2();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});

test("different locks don't interfere", async () => {
  const tmpRoot = mkdtempSync(join(tmpdir(), "issue-attack-test-"));
  try {
    // Initialize the required state files
    const state = { runs: {} };
    stateMod.saveState(tmpRoot, state);
    
    // Acquire different locks
    const release1 = stateMod.acquireLock(tmpRoot, "lock-a", 5000);
    const release2 = stateMod.acquireLock(tmpRoot, "lock-b", 5000);
    
    // Both should succeed
    assert.ok(typeof release1 === "function");
    assert.ok(typeof release2 === "function");
    
    release1();
    release2();
  } finally {
    rmSync(tmpRoot, { recursive: true, force: true });
  }
});
