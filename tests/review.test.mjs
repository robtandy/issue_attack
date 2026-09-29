// `ia review` mechanics: verdict parsing from the reviewer's final message,
// review-state markers on PRs (keyed by head SHA, so re-pushes re-review),
// the verdict-comment builder, and reviewer model resolution
// (--model > config.reviewModel > config.model).

import test from "node:test";
import assert from "node:assert/strict";
import { parseReviewVerdict, reviewedShaFromComments, effectiveReviewModel } from "../lib/review.js";
import { reviewComment } from "../lib/prompt.js";

test("parseReviewVerdict: first line decides", () => {
  assert.deepEqual(parseReviewVerdict("APPROVE\n- tests pass\n- resolves the issue"), {
    action: "approve",
    summary: "- tests pass\n- resolves the issue",
  });
  assert.deepEqual(parseReviewVerdict("REQUEST_CHANGES\n- add a test for the empty case"), {
    action: "request_changes",
    summary: "- add a test for the empty case",
  });
  // tolerant spellings
  assert.equal(parseReviewVerdict("APPROVED\nok").action, "approve");
  assert.equal(parseReviewVerdict("Request_Changes\nfix").action, "request_changes");
  assert.equal(parseReviewVerdict("REQUEST CHANGES\nfix").action, "request_changes");
});

test("parseReviewVerdict: junk and emptiness", () => {
  assert.equal(parseReviewVerdict(null).action, "none");
  assert.equal(parseReviewVerdict("").action, "none");
  assert.equal(parseReviewVerdict("The PR looks reasonable to me overall").action, "none");
});

test("reviewedShaFromComments: extracts the latest review marker", () => {
  const comments = [
    { body: "some human comment" },
    { body: "<!-- issue_attack:review:abc123 -->\n### approved" },
    { body: "<!-- issue_attack:review:def456 -->\n### changes requested" },
  ];
  assert.equal(reviewedShaFromComments(comments), "def456");
  assert.equal(reviewedShaFromComments([{ body: "no markers" }]), null);
  assert.equal(reviewedShaFromComments(null), null);
});

test("reviewComment carries the head-sha marker and the right shape", () => {
  const approve = reviewComment({ sha: "abc123", action: "approve", summary: "tests green", issue: 12 });
  assert.match(approve, /<!-- issue_attack:review:abc123 -->/);
  assert.match(approve, /approved/);
  assert.match(approve, /Merged by the supervisor/);
  assert.doesNotMatch(approve, /resume 12/);

  const changes = reviewComment({ sha: "abc123", action: "request_changes", summary: "- add tests", issue: 12 });
  assert.match(changes, /<!-- issue_attack:review:abc123 -->/);
  assert.match(changes, /changes requested/);
  assert.match(changes, /issue_attack resume 12/); // feeds the resume loop
});

test("effectiveReviewModel: flag > reviewModel > model > null", () => {
  assert.equal(effectiveReviewModel("flag:m", { reviewModel: "r", model: "w" }), "flag:m");
  assert.equal(effectiveReviewModel(null, { reviewModel: "r", model: "w" }), "r");
  assert.equal(effectiveReviewModel(null, { model: "w" }), "w");
  assert.equal(effectiveReviewModel(null, {}), null);
});
