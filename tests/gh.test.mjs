// Regression tests for issue #46: comment mutations must go through the
// GraphQL API with GraphQL node ids. The REST comment endpoints accept only
// the numeric database id, so feeding them the node ids that
// `gh --json comments` returns fails with "gh: Not Found (HTTP 404)" — the
// "could not acknowledge the issue comment" bug.

import test from "node:test";
import assert from "node:assert/strict";
import { reactionArgs, editCommentArgs, deleteCommentArgs } from "../dist/lib/gh.js";

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
