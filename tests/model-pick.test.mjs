// The interactive model picker (fzf when present, search-and-number
// otherwise) is only exercised by humans; its pure search helper is tested
// here. The requirement itself is enforced in the runners: no model in the
// config (and no --model flag) is an error — ia never falls back to pi's
// default.

import test from "node:test";
import assert from "node:assert/strict";
import { matchesFor } from "../lib/cli.js";

const MODELS = [
  { provider: "ai-gw-baseten", id: "baseten/zai-org/GLM-5.3", name: "GLM 5.3" },
  { provider: "ai-gw-anthropic-200k", id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5" },
  { provider: "routy", id: "routy/routy-weave-16", name: "Weave 16" },
];

test("matchesFor: substring on provider/id and name, case-insensitive", () => {
  assert.deepEqual(matchesFor(MODELS, "glm").map((m) => m.id), ["baseten/zai-org/GLM-5.3"]);
  assert.deepEqual(matchesFor(MODELS, "GLM").map((m) => m.id), ["baseten/zai-org/GLM-5.3"]);
  assert.deepEqual(matchesFor(MODELS, "haiku").map((m) => m.id), ["anthropic/claude-haiku-4-5-20251001"]);
  assert.deepEqual(matchesFor(MODELS, "routy").map((m) => m.id), ["routy/routy-weave-16"]);
  assert.deepEqual(matchesFor(MODELS, "  weave  ").map((m) => m.id), ["routy/routy-weave-16"]); // by name
  assert.deepEqual(matchesFor(MODELS, "ai-gw").length, 2); // provider prefix matches two
});

test("matchesFor: empty or missing query matches nothing", () => {
  assert.deepEqual(matchesFor(MODELS, ""), []);
  assert.deepEqual(matchesFor(MODELS, "   "), []);
  assert.deepEqual(matchesFor(MODELS, null), []);
});
