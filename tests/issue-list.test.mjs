// `ia run` (and `ia resume`) accept a comma-separated list of issue numbers,
// executed sequentially in the given order: "run 12,15,3" (also "run 12 15 3").
// These tests cover the pure parser: order preservation, whitespace, mixed
// separators, duplicate dropping, and rejection of garbage.

import test from "node:test";
import assert from "node:assert/strict";
import { parseIssueList } from "../lib/cli.js";

test("parses comma-separated lists in order", () => {
  assert.deepEqual(parseIssueList(["12,15,3"]), [12, 15, 3]);
});

test("tolerates whitespace and mixed separators", () => {
  assert.deepEqual(parseIssueList(["5, 12", "3"]), [5, 12, 3]);
  assert.deepEqual(parseIssueList(["5 12 3"]), [5, 12, 3]);
});

test("drops duplicates, keeps first-seen order", () => {
  assert.deepEqual(parseIssueList(["5,5,12,5"]), [5, 12]);
});

test("single issue still works", () => {
  assert.deepEqual(parseIssueList(["12"]), [12]);
});

test("rejects garbage and empty input", () => {
  assert.throws(() => parseIssueList(["abc"]), /invalid issue number/);
  assert.throws(() => parseIssueList(["12,x"]), /invalid issue number/);
  assert.throws(() => parseIssueList(["-3"]), /invalid issue number/);
  assert.throws(() => parseIssueList([]), /expected an issue number/);
});
