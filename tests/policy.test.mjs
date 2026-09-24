import test from "node:test";
import assert from "node:assert";
import { checkCommand } from "../lib/policy.js";

const ctx = { baseBranch: "main", branch: "agent/issue-12" };

test("allowed commands", async (t) => {
  const allowedCases = [
    "git push origin agent/issue-12",
    "gh issue view 12 --comments",
    "gh pr create --base main --title x --body y",
    "npm test",
    "rm -rf node_modules",
  ];

  for (const cmd of allowedCases) {
    await t.test(`allows: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, true, `Expected '${cmd}' to be allowed`);
    });
  }
});

test("denied: push to base branch", async (t) => {
  const deniedCases = [
    "git push origin main",
    "git push origin HEAD:main",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "push-base");
    });
  }
});

test("denied: force push", async (t) => {
  const deniedCases = [
    "git push origin agent/issue-12 --force",
    "git push origin agent/issue-12 -f",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "force-push");
    });
  }
});

test("denied: delete branch", async (t) => {
  const cmd = "git push origin --delete branch";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "branch-delete");
  });
});

test("denied: checkout base branch", async (t) => {
  const deniedCases = [
    "git checkout main",
    "git switch main",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "checkout-base");
    });
  }
});

test("denied: gh pr mutations", async (t) => {
  const deniedCases = [
    "gh pr merge",
    "gh pr close",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "gh-pr-mutations");
    });
  }
});

test("denied: gh issue mutations", async (t) => {
  const deniedCases = [
    "gh issue close",
    "gh issue edit",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "gh-issue-mutations");
    });
  }
});

test("denied: gh repo mutations", async (t) => {
  const cmd = "gh repo edit";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "gh-repo-mutations");
  });
});

test("denied: gh secret", async (t) => {
  const cmd = "gh secret set";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "gh-secret");
  });
});

test("denied: gh workflow", async (t) => {
  const cmd = "gh workflow run";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "gh-workflow");
  });
});

test("denied: gh api write", async (t) => {
  const cmd = "gh api -X DELETE /repos/owner/repo";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "gh-api-write");
  });
});

test("denied: gh gist", async (t) => {
  const cmd = "gh gist create";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "gh-gist");
  });
});

test("denied: sudo", async (t) => {
  const cmd = "sudo anything";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "sudo");
  });
});

test("denied: dangerous rm", async (t) => {
  const deniedCases = [
    "rm -rf ~",
    "rm -rf $HOME/x",
  ];

  for (const cmd of deniedCases) {
    await t.test(`denies: ${cmd}`, () => {
      const result = checkCommand(cmd, ctx);
      assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
      assert.strictEqual(result.rule, "dangerous-rm");
    });
  }
});

test("denied: chained commands", async (t) => {
  const cmd = "echo hi && git push origin main";
  await t.test(`denies: ${cmd}`, () => {
    const result = checkCommand(cmd, ctx);
    assert.strictEqual(result.ok, false, `Expected '${cmd}' to be denied`);
    assert.strictEqual(result.rule, "push-base");
  });
});
