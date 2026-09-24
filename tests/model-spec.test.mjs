// The configured model must win on resumed sessions too. pi sessions record
// their model and restore it on resume, so the --model CLI flag alone doesn't
// guarantee the config applies — the runner resolves the spec and applies it
// via the set_model / set_thinking_level RPC commands. These tests cover the
// pure parsing/resolution half.

import test from "node:test";
import assert from "node:assert/strict";
import { parseModelSpec, resolveModelSpec } from "../dist/lib/runner.js";

test("parseModelSpec splits a known thinking suffix", () => {
  assert.deepEqual(parseModelSpec("sonnet:high"), { modelPart: "sonnet", level: "high" });
  assert.deepEqual(parseModelSpec("ai-gw-baseten/baseten/zai-org/GLM-5.3:max"), {
    modelPart: "ai-gw-baseten/baseten/zai-org/GLM-5.3",
    level: "max",
  });
  assert.deepEqual(parseModelSpec("gpt-5.6:xhigh"), { modelPart: "gpt-5.6", level: "xhigh" });
});

test("parseModelSpec leaves unknown/bare colons alone", () => {
  assert.deepEqual(parseModelSpec("baseten/zai-org/GLM-5.3"), {
    modelPart: "baseten/zai-org/GLM-5.3",
    level: null,
  });
  // A bare level word is a (weird) model name, not a suffix
  assert.deepEqual(parseModelSpec("off"), { modelPart: "off", level: null });
  assert.deepEqual(parseModelSpec("some:model"), { modelPart: "some:model", level: null });
});

const MODELS = [
  { id: "anthropic/claude-haiku-4-5-20251001", name: "Claude Haiku 4.5", provider: "ai-gw-anthropic-200k" },
  { id: "baseten/zai-org/GLM-5.3", name: "GLM 5.3", provider: "ai-gw-baseten" },
];

test("resolveModelSpec matches exact provider/id, exact id, then substring", () => {
  assert.equal(resolveModelSpec("ai-gw-baseten/baseten/zai-org/GLM-5.3", MODELS)?.id, "baseten/zai-org/GLM-5.3");
  assert.equal(resolveModelSpec("baseten/zai-org/GLM-5.3", MODELS)?.id, "baseten/zai-org/GLM-5.3");
  assert.equal(resolveModelSpec("haiku", MODELS)?.id, "anthropic/claude-haiku-4-5-20251001");
  assert.equal(resolveModelSpec("GLM", MODELS)?.id, "baseten/zai-org/GLM-5.3");
  assert.equal(resolveModelSpec("no such model", MODELS), null);
});
