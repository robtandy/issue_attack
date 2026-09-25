// The worker contract must keep agents steerable: steering (operator
// comments, budget wrap-ups) is delivered between tool calls, so a single
// minutes-long blocking command — observed as a 20-minute cargo run that
// swallowed the entire wrap-up window — leaves the agent unreachable.
// The contract therefore requires backgrounding + polling for long commands,
// and the wrap-up prompt must account for background jobs. These tests guard
// against a contract rewrite silently dropping those rules.

import test from "node:test";
import assert from "node:assert/strict";
import { workerContract, wrapupPrompt } from "../lib/prompt.js";

const contract = workerContract({
  issue: 12,
  repo: "o/r",
  base: "main",
  branch: "agent/issue-12",
  prDraft: false,
});

test("worker contract requires backgrounding long commands", () => {
  assert.match(contract, /Long-running commands/);
  assert.match(contract, /~60 seconds/);
  assert.match(contract, /background/i);
  assert.match(contract, /poll/i);
  assert.match(contract, /kill/);
});

test("wrap-up prompt handles background jobs and keeps its essentials", () => {
  const p = wrapupPrompt({ issue: 12 });
  assert.match(p, /background jobs/);
  assert.match(p, /BLOCKED\.md/);
  assert.match(p, /Do not start new work/);
});
