// pi surfaces a terminal model failure as an agent_end record with
// willRetry:false and the provider's error message on the last assistant
// message (observed live: instant dead runs, 401 auth, nothing else in the
// output). ia must lift that error out and fail loudly with the provider's
// actual complaint — the payload below is the real record from that incident.

import test from "node:test";
import assert from "node:assert/strict";
import { finalErrorFromAgentEnd } from "../lib/runner.js";

const REAL = {
  type: "agent_end",
  willRetry: false,
  messages: [
    {
      role: "assistant",
      content: [],
      api: "anthropic-messages",
      provider: "ai-gw-anthropic-1m",
      model: "anthropic/claude-opus-5-5",
      usage: { totalTokens: 0, cost: { total: 0 } },
      stopReason: "error",
      errorMessage: '401 {"detail":"Authorization header not found","status":401}',
      thinkingLevel: "medium",
    },
  ],
};

test("extracts the terminal provider error from agent_end (real payload)", () => {
  assert.equal(finalErrorFromAgentEnd(REAL), '401 {"detail":"Authorization header not found","status":401}');
});

test("ignores retried, normal, and non-agent_end records", () => {
  assert.equal(finalErrorFromAgentEnd({ ...REAL, willRetry: true }), null); // retry pending
  assert.equal(
    finalErrorFromAgentEnd({ type: "agent_end", willRetry: false, messages: [{ role: "assistant", stopReason: "tool_calls" }] }),
    null
  ); // normal finish
  assert.equal(finalErrorFromAgentEnd({ type: "message_end", message: REAL.messages[0] }), null); // wrong record type
  assert.equal(finalErrorFromAgentEnd(null), null);
});
