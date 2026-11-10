// Regression tests for issue #65: a reviewer called ask_user_question in
// its scripted session, nothing could answer it, and the review loop hung
// for ~4 hours — no verdict, no timeout, no retry. The guards are layered:
//   1. the reviewer contract states it is unattended and must not ask;
//   2. both worker and reviewer pi sessions start with ask_user_question
//      excluded (--exclude-tools), so the rule is mechanical, not advisory;
//   3. (in review.js) an ask_user_question tool call aborts the review.
// These tests pin layers 1 and 2.

import test from "node:test";
import assert from "node:assert/strict";
import { reviewerContract } from "../lib/prompt.js";
import { reviewerSessionArgs } from "../lib/review.js";
import { workerSessionArgs } from "../lib/runner.js";

const contract = reviewerContract({ repo: "o/r", base: "main" });

test("reviewer contract says the session is unattended", () => {
  assert.match(contract, /unattended/i);
  assert.match(contract, /no human is watching/i);
  assert.match(contract, /nothing answers questions/i);
});

test("reviewer contract forbids ask_user_question and prescribes the alternative", () => {
  assert.match(contract, /ask_user_question/);
  // the actionable rule: when unsure, recheck — then verdict; never ask
  assert.match(contract, /recheck/i);
  assert.match(contract, /never call ask_user_question/i);
});

test("reviewer session excludes ask_user_question (#65 layer 2)", () => {
  const args = reviewerSessionArgs({
    config: { approve: true },
    model: "openai/gpt-6.1-sol:max",
    sessionRoot: "/tmp/s",
    sessionId: "sid",
    prNumber: 55,
    contractPath: "/tmp/s/reviewer-contract.md",
  });
  const i = args.indexOf("--exclude-tools");
  assert.ok(i >= 0, "must pass --exclude-tools");
  assert.equal(args[i + 1], "ask_user_question");
  // the rest of the shape is unchanged
  assert.ok(args.includes("-a"));
  assert.ok(args.includes("--model"));
  assert.ok(args.includes("--append-system-prompt"));
});

test("reviewer session refuses to start without a model", () => {
  assert.throws(
    () => reviewerSessionArgs({ config: {}, model: null, sessionRoot: "/tmp/s", sessionId: "sid", prNumber: 1, contractPath: "/x" }),
    /no reviewer model configured/
  );
});

test("worker session also excludes ask_user_question (same hang, unbounded runs)", () => {
  const args = workerSessionArgs({
    config: { approve: false, noExtensions: true, extraFlags: ["--verbose"] },
    model: null,
    sessionRoot: "/tmp/s",
    sessionId: "sid",
    issue: 12,
    contractPath: "/tmp/s/worker-contract.md",
  });
  const i = args.indexOf("--exclude-tools");
  assert.ok(i >= 0, "workers must not be able to ask questions either");
  assert.equal(args[i + 1], "ask_user_question");
  assert.ok(args.includes("-na"));
  assert.ok(args.includes("-ne"));
  assert.ok(args.includes("--verbose"));
  // no model configured and none given → no --model flag (runner verifies separately)
  assert.ok(!args.includes("--model"));
});
