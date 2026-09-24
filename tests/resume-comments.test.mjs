// Resume must feed the agent every comment that has never been acknowledged
// (👀), regardless of age — the reaction is the source of truth, not the last
// run's endedAt. The old timestamp window made comments older than the
// previous attempt's end invisible to resume forever (the "unacknowledged
// comment on an old PR never gets addressed" bug).

import test from "node:test";
import assert from "node:assert/strict";
import { unaddressedComments } from "../dist/lib/runner.js";

const human = (id, body) => ({
  id,
  body,
  createdAt: "2026-09-24T20:43:43Z",
  author: { login: "robtandy" },
});

test("keeps unacknowledged human comments, however old", () => {
  const out = unaddressedComments([human("IC_1", "I want this PR to address X")], []);
  assert.equal(out.length, 1);
  assert.equal(out[0].id, "IC_1");
});

test("drops acknowledged comments", () => {
  const out = unaddressedComments([human("IC_1", "a"), human("IC_2", "b")], ["IC_1"]);
  assert.deepEqual(out.map((c) => c.id), ["IC_2"]);
});

test("drops supervisor-generated comments (status marker and outcome text)", () => {
  const comments = [
    human("IC_1", "<!-- issue_attack:status -->\n🤖 working..."),
    human("IC_2", "✅ issue_attack agent opened robtandy/issue_attack/pull/31 — attempt 1, 4m."),
    human("IC_3", "please handle this"),
  ];
  const out = unaddressedComments(comments, []);
  assert.deepEqual(out.map((c) => c.id), ["IC_3"]);
});

test("tolerates null/undefined inputs and id-less comments", () => {
  assert.deepEqual(unaddressedComments(null, undefined), []);
  assert.deepEqual(unaddressedComments([{ body: "no id" }], []), []);
});
