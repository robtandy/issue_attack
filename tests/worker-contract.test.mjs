// The worker contract must keep agents steerable: operator steering is
// delivered between tool calls, so a single minutes-long blocking command —
// observed as a 20-minute cargo run that left the agent unreachable — defeats
// it. The contract therefore requires backgrounding + polling for long
// commands. These tests guard against a contract rewrite silently dropping
// those rules.

import test from "node:test";
import assert from "node:assert/strict";
import { workerContract } from "../lib/prompt.js";

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
  // bg_wait, when the toolset provides it, must be used as a bounded poll — never an unbounded block
  assert.match(contract, /bg_wait/);
  assert.match(contract, /timeoutMs/);
});
