// Best-effort safety policy for bash commands issued by worker agents.
//
// This is a reactive tripwire, not a sandbox: the supervisor sees a command
// when it starts and can steer/abort, but cannot prevent execution. Pair with
// the worker contract (system prompt) and least-privilege credentials.
// A hard gate would be a pi extension intercepting tool calls (see DESIGN.md).
//
// Matching strategy: a command is split into shell statements (\n, ;, &&, ||),
// each statement is cut at its first quote/heredoc (string literals are data,
// not commands), and only statements that *start with* a capable command
// (git, gh, sudo, rm, chmod) are checked against the rule set. This avoids
// false positives on legitimate commands whose arguments quote dangerous-
// looking text (e.g. a `gh pr create --body` describing force-push tests)
// while still catching naive accidents like `git push origin main`.

const CAPABLE_COMMANDS = new Set(["git", "gh", "sudo", "rm", "chmod", "chown"]);

/** Split a command into shell statements and reduce each to its command prefix. */
function commandPrefixes(command: string): string[] {
  const statements = String(command ?? "")
    .split(/\n|;|&&|\|\|/)
    .map((s) => s.trim())
    .filter(Boolean);
  const prefixes: string[] = [];
  for (const stmt of statements) {
    // Cut at the first string literal or heredoc: everything after is data.
    const cut = stmt.search(/["'`]|<</);
    const prefix = (cut === -1 ? stmt : stmt.slice(0, cut)).trim();
    if (!prefix) continue;
    const first = prefix.split(/\s+/)[0];
    if (CAPABLE_COMMANDS.has(first)) prefixes.push(prefix);
  }
  return prefixes;
}

export interface PolicyContext {
  baseBranch: string;
  branch: string;
}

export interface PolicyRule {
  rule: string;
  test: RegExp;
  reason: string;
}

export type PolicyResult = { ok: true } | { ok: false; rule: string; reason: string };

/** A failed check: which rule fired and why. */
export type PolicyViolation = Extract<PolicyResult, { ok: false }>;

/**
 * Check a bash command against the denylist. Only statements that start with
 * a capable command are matched (see commandPrefixes above).
 */
export function checkCommand(command: string, { baseBranch, branch }: PolicyContext): PolicyResult {
  const esc = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const base = esc(baseBranch);

  const rules: PolicyRule[] = [
    {
      rule: "force-push",
      test: new RegExp(`\\bgit\\s+push\\b[^|;&]*(--force(?!-with-lease)|--force-with-lease|\\s-f\\b)`),
      reason: "force-pushing is not allowed",
    },
    {
      rule: "push-base",
      test: new RegExp(`\\bgit\\s+push\\b[^|;&]*\\b(${base}\\b|: *${base}|HEAD: *${base})`),
      reason: `pushing to the base branch '${baseBranch}' is not allowed`,
    },
    {
      rule: "branch-delete",
      test: /\bgit\s+push\b[^|;&]*(--delete\b|\s: *\S+)/,
      reason: "deleting remote branches is not allowed",
    },
    {
      rule: "checkout-base",
      test: new RegExp(`\\bgit\\s+(checkout|switch)\\s+(${base})(\\s|$)`),
      reason: `checking out the base branch '${baseBranch}' is not allowed; stay on ${branch}`,
    },
    {
      rule: "gh-pr-mutations",
      test: /\bgh\s+pr\s+(merge|close|ready|edit|reopen|delete)\b/,
      reason: "mutating pull requests (merge/close/edit) is not allowed",
    },
    {
      rule: "gh-issue-mutations",
      test: /\bgh\s+issue\s+(close|reopen|edit|delete|lock|unlock|pin|unpin|transfer)\b/,
      reason: "mutating the issue (close/edit/lock/pin) is not allowed",
    },
    {
      rule: "gh-repo-mutations",
      test: /\bgh\s+repo\s+(delete|edit|rename|create|archive|unarchive|sync)\b/,
      reason: "mutating repository settings is not allowed",
    },
    {
      rule: "gh-label-mutations",
      test: /\bgh\s+label\s+(create|delete|edit)\b/,
      reason: "mutating repo labels is not allowed",
    },
    {
      rule: "gh-secret",
      test: /\bgh\s+secret\b/,
      reason: "touching repo secrets is not allowed",
    },
    {
      rule: "gh-workflow",
      test: /\bgh\s+workflow\b[^|;&]*(\brun\b|\bdispatch\b|--delete)/,
      reason: "triggering or deleting workflows is not allowed",
    },
    {
      rule: "gh-release-mutations",
      test: /\bgh\s+release\s+(create|delete|edit|upload|download-transfer)\b/,
      reason: "creating or editing releases is not allowed",
    },
    {
      rule: "gh-api-write",
      test: /\bgh\s+api\b[^|;&]*((-X|--method)[= ]\s*(DELETE|PUT|PATCH|POST))/,
      reason: "write-method gh api calls are not allowed",
    },
    {
      rule: "gh-gist",
      test: /\bgh\s+gist\s+(create|edit|delete)\b/,
      reason: "publishing gists is not allowed",
    },
    {
      rule: "sudo",
      test: /(^|\s)\bsudo\b/,
      reason: "sudo is not allowed",
    },
    {
      rule: "dangerous-rm",
      test: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+|--recursive\b[^|;&]*\s+)+(\*|~|\/|\$HOME)/,
      reason: "recursive deletes of home/absolute paths are not allowed",
    },
    {
      rule: "chmod-recursive-root",
      test: /\bchmod\s+-R\s+[0-7]*[57][0-7]*\s+\/(\s|$)/,
      reason: "recursive chmod on / is not allowed",
    },
  ];

  for (const prefix of commandPrefixes(command)) {
    for (const r of rules) {
      if (r.test.test(prefix)) {
        return { ok: false, rule: r.rule, reason: r.reason };
      }
    }
  }
  return { ok: true };
}

/** The steering message sent to an agent on first violation. */
export function violationMessage(v: PolicyViolation): string {
  return (
    `[POLICY] Your command was flagged and stopped: ${v.reason} (${v.rule}). ` +
    `Hard rules: push only to your own branch, never force-push, never merge/close PRs, ` +
    `never close or edit the issue, never touch repo settings/secrets/workflows. ` +
    `Continue the task using allowed operations.`
  );
}
