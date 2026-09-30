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

test("parseReviewVerdict: verdict anywhere in the message (observed: APPROVE at the end)", () => {
  // the real-world failure: prose first, verdict last
  const end = parseReviewVerdict("I have completed the review of this change.\n\nEverything checks out — tests pass and the fix is minimal.\n\nAPPROVE");
  assert.equal(end.action, "approve");
  // markdown-decorated verdicts
  assert.equal(parseReviewVerdict("**APPROVE**\nall good").action, "approve");
  assert.equal(parseReviewVerdict("### APPROVE\nall good").action, "approve");
  assert.equal(parseReviewVerdict("## Verdict\n\nREQUEST CHANGES\n- add tests").action, "request_changes");
  // inline summary on the verdict line
  const inline = parseReviewVerdict("APPROVE — tests pass, resolves #26");
  assert.equal(inline.action, "approve");
  assert.equal(inline.summary, "tests pass, resolves #26");
  // first verdict wins when the summary mentions the other keyword later
  assert.equal(parseReviewVerdict("REQUEST_CHANGES\n- fix X\n- I would approve after").action, "request_changes");
});

test("parseReviewVerdict: junk and near-misses", () => {
  assert.equal(parseReviewVerdict(null).action, "none");
  assert.equal(parseReviewVerdict("").action, "none");
  assert.equal(parseReviewVerdict("The PR looks reasonable to me overall").action, "none");
  // words starting with APPROVE- but not the verdict
  assert.equal(parseReviewVerdict("APPROVALS are pending from the team").action, "none");
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
