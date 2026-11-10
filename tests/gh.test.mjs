// Regression tests for issue #46: comment mutations must go through the
// GraphQL API with GraphQL node ids. The REST comment endpoints accept only
// the numeric database id, so feeding them the node ids that
// `gh --json comments` returns fails with "gh: Not Found (HTTP 404)" — the
// "could not acknowledge the issue comment" bug.

import test from "node:test";
import assert from "node:assert/strict";
import { reactionArgs, editCommentArgs, deleteCommentArgs, closingRefs, sortIssuesByOrder } from "../lib/gh.js";

const NODE_ID = "IC_kwDOUp3K2M8AAAABWwBbfg";

test("reaction args: graphql addReaction with node id", () => {
  const args = reactionArgs(NODE_ID, "eyes");
  assert.equal(args[0], "api");
  assert.equal(args[1], "graphql");
  assert.ok(args.some((a) => a.includes("addReaction(input:{subjectId:$subject")));
  assert.ok(args.includes(`subject=${NODE_ID}`));
  assert.ok(args.includes("content=EYES")); // ReactionContent enum, not the REST lowercase value
});

test("comment mutation args never use the numeric-id REST path", () => {
  const all = [reactionArgs(NODE_ID, "eyes"), editCommentArgs(NODE_ID, "x"), deleteCommentArgs(NODE_ID)];
  for (const args of all) {
    assert.equal(args[1], "graphql");
    assert.ok(!args.some((a) => String(a).includes("/issues/comments/")), "must not hit REST comment endpoints");
  }
});

test("edit/delete args carry the node id and payload", () => {
  const e = editCommentArgs(NODE_ID, "new body");
  assert.ok(e.some((a) => a.includes("updateIssueComment")));
  assert.ok(e.includes(`id=${NODE_ID}`));
  assert.ok(e.includes("body=new body"));

  const d = deleteCommentArgs(NODE_ID);
  assert.ok(d.some((a) => a.includes("deleteIssueComment")));
  assert.ok(d.includes(`id=${NODE_ID}`));
});

// `Closes #N` parsing (closingRefs) backs the merge path: GitHub only
// auto-closes referenced issues when a PR merges into the DEFAULT branch;
// with a non-default base branch the supervisor must close them itself or
// every depends-N dependent waits forever.

test("closingRefs: parses all of GitHub's closing keywords", () => {
  assert.deepEqual(closingRefs("Closes #12"), [12]);
  assert.deepEqual(closingRefs("close #1"), [1]);
  assert.deepEqual(closingRefs("closed #2"), [2]);
  assert.deepEqual(closingRefs("fixes #3"), [3]);
  assert.deepEqual(closingRefs("fix #4"), [4]);
  assert.deepEqual(closingRefs("fixed #5"), [5]);
  assert.deepEqual(closingRefs("resolves #6"), [6]);
  assert.deepEqual(closingRefs("resolve #7"), [7]);
  assert.deepEqual(closingRefs("resolved #8"), [8]);
  // case-insensitive, mid-sentence, several per body
  assert.deepEqual(closingRefs("This closes #12 and RESOLVES #34, plus fixes #56."), [12, 34, 56]);
});

test("closingRefs: dedupes and ignores non-references", () => {
  assert.deepEqual(closingRefs("Closes #12. Also closes #12 again."), [12]);
  assert.deepEqual(closingRefs("no refs here"), []);
  assert.deepEqual(closingRefs(null), []);
  assert.deepEqual(closingRefs(""), []);
  // plain mentions are not closing keywords
  assert.deepEqual(closingRefs("see #12 for context"), []);
  // the URL form is not the #N form the supervisor looks for
  assert.deepEqual(closingRefs("https://github.com/o/r/issues/12"), []);
});

// Claim ordering (sortIssuesByOrder): default "updatedAt" honors the
// operator's ready-label ordering but re-queues issues on any later edit;
// "createdAt" is edit-immune; "number" is fully deterministic.

test("sortIssuesByOrder: updatedAt (default) — oldest-updated first", () => {
  const issues = [
    { number: 3, createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-03-03T00:00:00Z" },
    { number: 1, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-02-01T00:00:00Z" },
    { number: 2, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-02-15T00:00:00Z" },
  ];
  assert.deepEqual(sortIssuesByOrder([...issues]).map((i) => i.number), [1, 2, 3]);
  assert.deepEqual(sortIssuesByOrder([...issues], "updatedAt").map((i) => i.number), [1, 2, 3]);
});

test("sortIssuesByOrder: createdAt — immune to body/label edits", () => {
  const issues = [
    { number: 2, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-03-02T00:00:00Z" },
    { number: 3, createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-02-02T00:00:00Z" },
    { number: 1, createdAt: "2024-01-01T00:00:00Z", updatedAt: "2024-04-01T00:00:00Z" },
  ];
  // by createdAt: 1,2,3 — by updatedAt the same set would be 3,2,1
  assert.deepEqual(sortIssuesByOrder([...issues], "createdAt").map((i) => i.number), [1, 2, 3]);
});

test("sortIssuesByOrder: number — fully deterministic", () => {
  const issues = [
    { number: 10, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-02-02T00:00:00Z" },
    { number: 2, createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-02-03T00:00:00Z" },
  ];
  assert.deepEqual(sortIssuesByOrder([...issues], "number").map((i) => i.number), [2, 10]);
});

test("sortIssuesByOrder: invalid order falls back to updatedAt", () => {
  const issues = [
    { number: 2, createdAt: "2024-01-02T00:00:00Z", updatedAt: "2024-03-02T00:00:00Z" },
    { number: 1, createdAt: "2024-01-03T00:00:00Z", updatedAt: "2024-02-03T00:00:00Z" },
  ];
  assert.deepEqual(sortIssuesByOrder([...issues], "bogus").map((i) => i.number), [1, 2]);
});
