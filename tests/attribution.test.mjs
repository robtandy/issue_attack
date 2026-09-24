import test from "node:test";
import assert from "node:assert";
import { prFooter, hasPrFooter, parseModelString } from "../dist/lib/prompt.js";

test("prFooter with issue and attempt", async (t) => {
  const cases = [
    {
      input: { issue: 42, attempt: 2 },
      shouldContain: ["This PR was opened by an", "https://github.com/robtandy/issue_attack", "issue #42", "attempt 2"],
    },
    {
      input: { issue: 7, attempt: 1 },
      shouldContain: ["This PR was opened by an", "https://github.com/robtandy/issue_attack", "issue #7", "attempt 1"],
    },
    {
      input: { issue: 99, attempt: 5 },
      shouldContain: ["This PR was opened by an", "https://github.com/robtandy/issue_attack", "issue #99", "attempt 5"],
    },
  ];

  for (const testCase of cases) {
    const description = `prFooter(issue: ${testCase.input.issue}, attempt: ${testCase.input.attempt})`;
    await t.test(description, () => {
      const result = prFooter(testCase.input);
      assert.strictEqual(typeof result, "string", "prFooter should return a string");
      for (const substring of testCase.shouldContain) {
        assert.match(result, new RegExp(substring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Footer should contain "${substring}"`);
      }
    });
  }
});

test("prFooter without attempt", async (t) => {
  const cases = [
    {
      input: { issue: 7 },
      shouldContain: ["This PR was opened by an", "https://github.com/robtandy/issue_attack", "issue #7"],
      shouldNotContain: ["attempt"],
    },
    {
      input: { issue: 123 },
      shouldContain: ["This PR was opened by an", "https://github.com/robtandy/issue_attack", "issue #123"],
      shouldNotContain: ["attempt"],
    },
  ];

  for (const testCase of cases) {
    const description = `prFooter(issue: ${testCase.input.issue}) without attempt`;
    await t.test(description, () => {
      const result = prFooter(testCase.input);
      assert.strictEqual(typeof result, "string", "prFooter should return a string");
      for (const substring of testCase.shouldContain) {
        assert.match(result, new RegExp(substring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Footer should contain "${substring}"`);
      }
      for (const substring of testCase.shouldNotContain) {
        assert.strictEqual(result.includes(substring), false, `Footer should not contain "${substring}"`);
      }
    });
  }
});

test("parseModelString", async (t) => {
  const cases = [
    {
      input: "claude-3-5-sonnet",
      expected: { model: "claude-3-5-sonnet", thinking: null },
    },
    {
      input: "claude-3-5-sonnet:high",
      expected: { model: "claude-3-5-sonnet", thinking: "high" },
    },
    {
      input: "anthropic/claude-3-5-sonnet",
      expected: { model: "claude-3-5-sonnet", thinking: null },
    },
    {
      input: "anthropic/claude-3-5-sonnet:medium",
      expected: { model: "claude-3-5-sonnet", thinking: "medium" },
    },
    {
      input: "gpt-4o",
      expected: { model: "gpt-4o", thinking: null },
    },
    {
      input: "gpt-4o:low",
      expected: { model: "gpt-4o", thinking: "low" },
    },
    {
      input: null,
      expected: { model: null, thinking: null },
    },
    {
      input: "",
      expected: { model: null, thinking: null },
    },
  ];

  for (const testCase of cases) {
    const description = `parseModelString("${testCase.input}")`;
    await t.test(description, () => {
      const result = parseModelString(testCase.input);
      assert.deepStrictEqual(result, testCase.expected);
    });
  }
});

test("prFooter with model and thinking level", async (t) => {
  const cases = [
    {
      input: { issue: 42, attempt: 1, model: "claude-3-5-sonnet", thinking: "high" },
      shouldContain: ["This PR was opened by an", "issue #42", "claude-3-5-sonnet", "high"],
    },
    {
      input: { issue: 7, model: "gpt-4o", thinking: "medium" },
      shouldContain: ["This PR was opened by an", "issue #7", "gpt-4o", "medium"],
    },
    {
      input: { issue: 99, attempt: 2, model: "gpt-4o-mini", thinking: null },
      shouldContain: ["This PR was opened by an", "issue #99", "attempt 2", "gpt-4o-mini"],
    },
    {
      input: { issue: 50, model: null, thinking: null },
      shouldContain: ["This PR was opened by an", "issue #50"],
    },
  ];

  for (const testCase of cases) {
    const description = `prFooter with model=${testCase.input.model} thinking=${testCase.input.thinking}`;
    await t.test(description, () => {
      const result = prFooter(testCase.input);
      assert.strictEqual(typeof result, "string", "prFooter should return a string");
      for (const substring of testCase.shouldContain) {
        assert.match(result, new RegExp(substring.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")), `Footer should contain "${substring}"`);
      }
    });
  }
});

test("hasPrFooter", async (t) => {
  const trueCases = [
    "Some PR description\n\n---\n🤖 This PR was opened by an [issue_attack](https://github.com/robtandy/issue_attack) agent autonomously working issue #42.",
    "This PR was opened by an agent",
    "This PR was opened by an [issue_attack](https://github.com/robtandy/issue_attack) agent autonomously working issue #7 (attempt 1).",
  ];

  for (const body of trueCases) {
    await t.test(`hasPrFooter returns true for body containing footer`, () => {
      const result = hasPrFooter(body);
      assert.strictEqual(result, true, `hasPrFooter should return true for: ${body.substring(0, 50)}...`);
    });
  }

  const falseCases = [
    "This is a regular PR body without any footer",
    "Some changes here, nothing special",
    "",
    null,
    undefined,
  ];

  for (const body of falseCases) {
    await t.test(`hasPrFooter returns false for unrelated body: ${String(body).substring(0, 30)}...`, () => {
      const result = hasPrFooter(body);
      assert.strictEqual(result, false, `hasPrFooter should return false for: ${String(body).substring(0, 50)}`);
    });
  }
});
