// Config hygiene: keys removed from earlier versions (status page, budgets)
// were silently accepted by loadConfig — a stale config.json kept lying to
// its operator. configWarnings + loadConfigWithWarnings surface removed keys,
// likely typos, and invalid enum values everywhere config is loaded.

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, loadConfigWithWarnings, configWarnings, DEFAULTS, REMOVED_KEYS, CLAIM_ORDERS } from "../lib/config.js";

test("a clean config produces no warnings", () => {
  assert.deepEqual(configWarnings(null), []);
  assert.deepEqual(configWarnings({ model: "x", pollSeconds: 30 }), []);
});

test("removed keys warn with what replaced them", () => {
  // exactly the stale keys found in a live repo's config.json
  const warnings = configWarnings({
    statusBranch: "gh-pages",
    statusPublishMinutes: 1,
    timeBudgetMinutes: 12,
    softBudgetRatio: 0.8,
    costBudgetUsd: 1.5,
    maxTokens: 4096,
  });
  assert.equal(warnings.length, Object.keys(REMOVED_KEYS).length);
  for (const w of warnings) assert.match(w, /no longer does anything/);
  assert.ok(warnings.some((w) => w.includes("status page")));
  assert.ok(warnings.some((w) => w.includes("unbounded")));
});

test("unknown keys look like typos", () => {
  const warnings = configWarnings({ pollSecods: 30 }); // (sic)
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /unknown config key "pollSecods"/);
});

test("invalid claimOrder warns; valid ones don't", () => {
  assert.deepEqual(configWarnings({ claimOrder: "updatedAt" }), []);
  assert.deepEqual(configWarnings({ claimOrder: "createdAt" }), []);
  assert.deepEqual(configWarnings({ claimOrder: "number" }), []);
  const warnings = configWarnings({ claimOrder: "priority" });
  assert.match(warnings[0], /claimOrder "priority" is invalid/);
  assert.ok(CLAIM_ORDERS.every((o) => warnings[0].includes(o)));
});

test("loadConfigWithWarnings reads the file and reports its stale keys", () => {
  const root = mkdtempSync(join(tmpdir(), "ia-config-"));
  try {
    mkdirSync(join(root, ".issue_attack"), { recursive: true });
    writeFileSync(
      join(root, ".issue_attack", "config.json"),
      JSON.stringify({ model: "m", statusBranch: "gh-pages", timeBudgetMinutes: 12, pollSecods: 5 })
    );
    const { config, warnings } = loadConfigWithWarnings(root);
    assert.equal(config.model, "m");
    assert.equal(config.claimOrder, "updatedAt"); // the new default applies
    assert.equal(config.pollSeconds, DEFAULTS.pollSeconds);
    assert.equal(warnings.length, 3);
    assert.ok(warnings.some((w) => w.includes("statusBranch")));
    assert.ok(warnings.some((w) => w.includes("timeBudgetMinutes")));
    assert.ok(warnings.some((w) => w.includes("pollSecods")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("malformed config JSON still fails loudly with its path", () => {
  const root = mkdtempSync(join(tmpdir(), "ia-config-"));
  try {
    mkdirSync(join(root, ".issue_attack"), { recursive: true });
    writeFileSync(join(root, ".issue_attack", "config.json"), "{not json");
    assert.throws(() => loadConfig(root), /Invalid config JSON at .*/);
    assert.throws(() => loadConfigWithWarnings(root), /Invalid config JSON at .*/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
