// Regression tests for issue #53: `ia resume` must notice when the issue's
// open PR has merge conflicts — from the live PR, not the last run's snapshot
// (base moves after a run ends; stopped runs drop the flag) — task the agent
// to resolve them first, and keep a per-run conflict-repair budget so a
// resumed run can always address them, even when earlier runs exhausted the
// recorded attempt count.

import test from "node:test";
import assert from "node:assert/strict";
import {
  openPrWithConflicts,
  prConflictsWithBase,
  conflictRepairBudget,
} from "../lib/runner.js";
import { resumePrompt } from "../lib/prompt.js";

const PR = (over = {}) => ({
  number: 7,
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  mergeable: true,
  mergeStateStatus: "CLEAN",
  ...over,
});

// ---- noticing conflicts in live PR records (the "resume should notice" half)

test("openPrWithConflicts: a DIRTY open PR is a conflict", () => {
  const { pr, conflicts } = openPrWithConflicts([
    PR({ mergeable: false, mergeStateStatus: "DIRTY" }),
  ]);
  assert.equal(pr?.number, 7);
  assert.equal(conflicts, true);
});

test("openPrWithConflicts: mergeable false alone is a conflict (status lagging)", () => {
  const { conflicts } = openPrWithConflicts([PR({ mergeable: false, mergeStateStatus: "UNKNOWN" })]);
  assert.equal(conflicts, true);
});

test("openPrWithConflicts: BEHIND but mergeable is not a conflict", () => {
  const { conflicts } = openPrWithConflicts([PR({ mergeStateStatus: "BEHIND" })]);
  assert.equal(conflicts, false);
});

test("openPrWithConflicts: mergeability still computing (null) is not a conflict", () => {
  const { conflicts } = openPrWithConflicts([PR({ mergeable: null, mergeStateStatus: "UNKNOWN" })]);
  assert.equal(conflicts, false);
});

test("openPrWithConflicts: closed/merged PRs and empty lists carry no conflicts", () => {
  const merged = PR({ state: "MERGED", mergeable: false, mergeStateStatus: "DIRTY" });
  assert.equal(openPrWithConflicts([merged]).pr, null);
  assert.equal(openPrWithConflicts([merged]).conflicts, false);
  assert.deepEqual(openPrWithConflicts([]), { pr: null, conflicts: false });
  assert.deepEqual(openPrWithConflicts(undefined), { pr: null, conflicts: false });
});

test("openPrWithConflicts: picks the open PR among several records", () => {
  const { pr, conflicts } = openPrWithConflicts([
    PR({ number: 3, state: "CLOSED" }),
    PR({ number: 7, mergeable: false }),
  ]);
  assert.equal(pr?.number, 7);
  assert.equal(conflicts, true);
});

test("prConflictsWithBase: predicate over a single record", () => {
  assert.equal(prConflictsWithBase(PR({ mergeable: false })), true);
  assert.equal(prConflictsWithBase(PR({ mergeStateStatus: "DIRTY" })), true);
  assert.equal(prConflictsWithBase(PR()), false);
  assert.equal(prConflictsWithBase(PR({ state: "CLOSED", mergeable: false })), false);
  assert.equal(prConflictsWithBase(null), false);
});

// ---- the resume prompt tasks the agent to resolve conflicts first

const resumeCtx = {
  issue: 53,
  prevStatus: "succeeded",
  blockedNote: null,
  newComments: [],
  newPrComments: [],
  base: "main",
  branch: "agent/issue-53",
  attempt: 2,
};

test("resumePrompt: conflicted resume carries concrete merge-and-resolve steps", () => {
  const p = resumePrompt({ ...resumeCtx, prHasConflicts: true });
  assert.match(p, /merge conflicts with the base branch `main`/);
  assert.match(p, /`git fetch origin`/);
  assert.match(p, /`git merge origin\/main`/);
  assert.match(p, /never rebase, never force-push/);
  assert.match(p, /`git push origin agent\/issue-53`/);
  assert.match(p, /re-run the tests/);
  // the callout is the first order of business, ahead of the comment digest
  assert.ok(
    p.indexOf("merge conflicts") < p.indexOf("New maintainer activity"),
    "conflict callout must come before the new-activity digest"
  );
});

test("resumePrompt: conflicted resume drops the 'may have advanced' hedge", () => {
  // one definite instruction, not a second conditional one
  const p = resumePrompt({ ...resumeCtx, prHasConflicts: true });
  assert.doesNotMatch(p, /may have advanced/);
});

test("resumePrompt: clean resume keeps the generic base-drift note, no callout", () => {
  const p = resumePrompt({ ...resumeCtx, prHasConflicts: false });
  assert.doesNotMatch(p, /merge conflicts/);
  assert.match(p, /may have advanced/);
});

// ---- the repair budget a resumed run arrives with

test("conflictRepairBudget: bounded per run, independent of prior attempts", () => {
  assert.equal(conflictRepairBudget(2), 1); // default maxAttempts → 1 repair pass per run
  assert.equal(conflictRepairBudget(3), 2);
  assert.equal(conflictRepairBudget(1), 0); // single-attempt config: no repair passes
  assert.equal(conflictRepairBudget(null), 0);
  assert.equal(conflictRepairBudget(undefined), 0);
});
