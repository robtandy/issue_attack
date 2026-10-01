// `ia checkin` asks a running agent how it's going via the local steering
// inbox (no GitHub comment), then watches the run log for the reply. These
// tests cover the pure reply extraction: text deltas accumulate until the
// first assistant message_end that actually carries text; tool-call-only
// turns are not the answer.

import test from "node:test";
import assert from "node:assert/strict";
import { replyFromRecords } from "../lib/cli.js";

const delta = (d) => ({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: d } });
const end = () => ({ type: "message_end", message: { role: "assistant" } });
const tool = (cmd) => ({ type: "tool_execution_start", toolName: "bash", args: { command: cmd } });

test("collects the reply up to the first text-bearing assistant message", () => {
  const r = replyFromRecords([delta("All going "), delta("well — tests pass."), end()]);
  assert.deepEqual(r, { text: "All going well — tests pass.", done: true });
});

test("tool-call-only turns are skipped, the answer still extracted", () => {
  const r = replyFromRecords([
    delta("Let me check."), end(),          // tool-planning turn with text — counts as first answer
  ]);
  assert.equal(r.done, true);
  // the realistic full shape: planning text, tool turn (no text), then answer
  const r2 = replyFromRecords([
    tool("ls"), tool("cat x"),               // interleaved tool events are ignored
    delta("Halfway done; join.rs rewritten, "), delta("running tests now."), end(),
  ]);
  assert.equal(r2.done, true);
  assert.equal(r2.text, "Halfway done; join.rs rewritten, running tests now.");
});

test("incomplete replies report not-done", () => {
  const r = replyFromRecords([delta("partial answer with no end yet")]);
  assert.deepEqual(r, { text: "partial answer with no end yet", done: false });
});

test("empty input is handled", () => {
  assert.deepEqual(replyFromRecords([]), { text: "", done: false });
  assert.deepEqual(replyFromRecords(null), { text: "", done: false });
});
