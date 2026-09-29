// The `ia run` PR lifecycle: once a PR opens, the run waits for merge (done),
// close without merge (move on), or feedback (resume the agent, wait again).
// Feedback detection reuses the resume bookkeeping — unacknowledged comments
// on the PR (not in entry.ackCommentIds, not supervisor-generated). Review
// comments from `ia review` count as feedback, which closes the full loop:
// review -> feedback -> fix -> re-review -> merge.

import test from "node:test";
import assert from "node:assert/strict";
import { prWaitOutcome } from "../lib/cli.js";

const cm = (id, body) => ({ id, body, createdAt: "2026-09-29T00:00:00Z", author: { login: "robtandy" } });

test("prWaitOutcome: merged and closed are terminal", () => {
  assert.equal(prWaitOutcome({ state: "MERGED" }, null).kind, "merged");
  assert.equal(prWaitOutcome({ state: "CLOSED", comments: [cm(1, "feedback!")] }, null).kind, "closed");
});

test("prWaitOutcome: unacknowledged PR comments are feedback", () => {
  const pr = { state: "OPEN", comments: [cm("IC_1", "please handle the edge case")] };
  const o = prWaitOutcome(pr, { ackCommentIds: [] });
  assert.equal(o.kind, "feedback");
  assert.equal(o.count, 1);

  // acknowledged comments are not feedback
  assert.equal(prWaitOutcome(pr, { ackCommentIds: ["IC_1"] }).kind, "waiting");
});

test("prWaitOutcome: supervisor and review marker noise is filtered; review feedback is not", () => {
  const comments = [
    cm("IC_1", "<!-- issue_attack:status -->\nworking"),
    cm("IC_2", "✅ issue_attack agent opened a PR — attempt 1, 4m."),
    cm("IC_3", "human: looks good but add a test"),
    cm("IC_4", "<!-- issue_attack:review:abc123 -->\n### changes requested\n- add tests"),
  ];
  const pr = { state: "OPEN", comments };
  const o = prWaitOutcome(pr, {});
  assert.equal(o.kind, "feedback");
  assert.deepEqual(o.comments.map((x) => x.id), ["IC_3", "IC_4"]); // review feedback included
});

test("prWaitOutcome: waiting states", () => {
  assert.equal(prWaitOutcome(null, null).kind, "waiting");
  assert.equal(prWaitOutcome({ state: "OPEN", comments: [] }, {}).kind, "waiting");
});
