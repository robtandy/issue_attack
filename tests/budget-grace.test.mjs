// The wrap-up steer must leave the agent a usable window before the hard
// abort. A purely proportional (80%) soft threshold leaves only 20% of the
// budget to wrap up — fine at 45+ minutes, useless at 12 minutes (2.4
// minutes, observed killing an agent mid-wrap-up). The grace guarantees a
// minimum window; the cost dimension reserves grace-time worth of budget at
// the observed burn rate.

import test from "node:test";
import assert from "node:assert/strict";
import { softThresholdMs, softCostThreshold } from "../lib/runner.js";

const MIN = 60_000;

test("tight budgets get a real wrap-up window", () => {
  // the observed failure: 12m budget, 0.8 ratio → 2.4m window was too small
  assert.equal(softThresholdMs(12 * MIN, 0.8, 5 * MIN), 7 * MIN);
});

test("large budgets keep the proportional ratio point", () => {
  assert.equal(softThresholdMs(45 * MIN, 0.8, 5 * MIN), 36 * MIN);
  assert.equal(softThresholdMs(120 * MIN, 0.8, 5 * MIN), 96 * MIN);
});

test("grace 0 = pure ratio; no budget = never", () => {
  assert.equal(softThresholdMs(12 * MIN, 0.8, 0), 9.6 * MIN);
  assert.equal(softThresholdMs(0, 0.8, 5 * MIN), Infinity);
});

test("budgets smaller than the grace steer early (10% floor)", () => {
  assert.equal(softThresholdMs(3 * MIN, 0.8, 5 * MIN), 0.3 * MIN);
});

test("cost grace reserves the wrap-up at the observed burn rate", () => {
  const approx = (a, b) => assert.ok(Math.abs(a - b) < 1e-9, `${a} != ${b}`);
  // $1.5 budget burning $0.10/min: 5m grace costs $0.50 → soft at $1.0
  approx(softCostThreshold(1.5, 0.8, 0.1 / MIN, 5 * MIN), 1.0);
  // slow burn (no cost yet) → ratio point
  approx(softCostThreshold(1.5, 0.8, 0, 5 * MIN), 1.2);
  // burning too fast to afford the grace → steer immediately
  approx(softCostThreshold(1.5, 0.8, 0.4 / MIN, 5 * MIN), 0);
  assert.equal(softCostThreshold(0, 0.8, 1, 5 * MIN), Infinity);
});
