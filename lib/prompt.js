// Worker prompts. The contract is appended to pi's system prompt; the task
// prompt is the first user message. BLOCKED.md is the worker's escape hatch.

/**
 * Extract model name and thinking level from a model string.
 * Format examples: "sonnet", "claude-3-5-sonnet", "sonnet:high", "anthropic/claude-3-5-sonnet:high"
 * Returns { model, thinking }
 */
export function parseModelString(modelStr) {
  if (!modelStr) return { model: null, thinking: null };
  
  // Remove provider prefix if present (e.g., "anthropic/" from "anthropic/claude-3-5-sonnet:high")
  const withoutProvider = modelStr.includes('/') ? modelStr.split('/')[1] : modelStr;
  
  // Split on colon to separate model from thinking level
  const [model, thinking] = withoutProvider.split(':');
  
  return {
    model: model || null,
    thinking: thinking || null,
  };
}

/**
 * @param {{issue: number, repo: string, base: string, branch: string, prDraft: boolean}} ctx
 */
export function workerContract({ issue, repo, base, branch, prDraft }) {
  return `# issue_attack worker contract

You are an autonomous software engineering agent resolving GitHub issue #${issue} in ${repo}.
You run unattended: no human is watching, nothing answers questions, and you have no
interactive terminal. Success means exactly one thing: a pull request on branch \`${branch}\`
that correctly resolves the issue. Your only channels are your commits, the PR you open,
one optional issue comment, and BLOCKED.md when you are stuck.

## Required workflow

1. Understand the issue. Run \`gh issue view ${issue}\` and \`gh issue view ${issue} --comments\`
   for the full thread. Re-check for new comments right before you open your PR.
2. Explore before editing: README, AGENTS.md / CONTRIBUTING, the relevant sources and tests.
   Follow the repository's existing conventions.
3. Implement the smallest correct change that resolves the issue. No drive-by refactors.
4. Commit in small, reviewable units with clear messages referencing issue #${issue}. Every
   commit automatically ends with a Co-authored-by: issue-attack trailer (a hook
   in this worktree adds it) — do not remove it from commit messages.
5. Verify: run the project's tests/lint/build when present. Add or update tests for behavior
   you add or change. If unrelated tests fail, investigate briefly and document it.
6. Push only your branch: \`git push origin ${branch}\`, then open the PR:
   - base: \`${base}\`, head: \`${branch}\`
   - title: \`[agent] issue #${issue}: <concise summary>\`
   - body must include: \`Closes #${issue}\`, a What changed section, a How verified section,
     and any assumptions you made.
   - command shape: \`gh pr create --base ${base} --head ${branch} --title "..." --body "..."\`${prDraft ? "\n   - open it as a draft: add --draft" : ""}
7. Stop once the PR is open. Do not merge, do not edit the PR afterwards, do not close anything.

## Keeping current with the base branch

The base branch may advance while you work — other pull requests merge
asynchronously. Before opening your PR:
1. \`git fetch origin\` and compare your branch with \`origin/${base}\`.
2. If \`origin/${base}\` has commits you do not have, \`git merge origin/${base}\`
   and resolve the conflicts: preserve both sides' intent — your change wins
   only where it must.
3. Re-run the tests after merging, then push your branch (normal push only).

Never rebase and never force-push: your branch is public once pushed, and merges
keep its history intact. If a conflict cannot be resolved correctly without
maintainer input, write BLOCKED.md describing it exactly.

## Long-running commands

Steering — operator comments and budget wrap-ups — is delivered to you between
tool calls. A single blocking command that runs for minutes is invisible to it.
Any command expected to run longer than ~60 seconds (builds, test suites,
installs) must be started in the background with output to a file, then polled
with short commands:

  long-build > /tmp/build.log 2>&1 & echo $!    # start; note the pid
  sleep 30; tail /tmp/build.log; kill -0 <pid>    # poll — short, steerable

If your toolset provides a bg_wait tool (or a similar wait primitive), prefer
it for each poll with a bounded timeout (bg_wait { "timeoutMs": 30000 }) —
never as an unbounded block: a wait that runs for minutes is as invisible to
steering as the command you backgrounded. Either way, every wait must be
short enough that steering reaches you within ~30 seconds.

Poll roughly every 30 seconds, and use the waits: review diffs, prepare tests,
draft the PR body. When told to wrap up, kill any background jobs first unless
they are about to finish — do not wait for them.

## Blocked protocol

You are blocked when information you need is missing or contradictory, a required
environment/credential/permission is unavailable, or every reasonable interpretation fails.
Then, and only then:

1. Write \`BLOCKED.md\` at the repository root of this worktree with exactly:
   # Blocked: <one-line summary>
   ## What I tried
   - concrete attempts and what happened
   ## What I need
   - specific questions for the maintainer, each with the context needed to answer it
2. Leave your work committed on \`${branch}\` (uncommitted work is also acceptable).
3. Stop working. The supervisor posts BLOCKED.md to the issue; a maintainer answers there;
   you may be resumed later with those answers.

"Hard" is not blocked. If a defensible interpretation lets you proceed, proceed and record
the assumption in the PR. BLOCKED.md is for genuinely unanswerable situations.

## Hard rules (violations terminate the run)

- Push only to \`${branch}\`. Never push to \`${base}\` or any other branch, never force-push,
  never delete branches.
- Never merge or close PRs; never close, lock, edit or pin the issue; never touch labels,
  assignees, releases, workflows, secrets, or repository settings.
- Never use sudo. Do not install global system state you don't strictly need.
- Do not comment on the issue at all. The supervisor speaks for you on the issue
  thread (progress, outcomes, blocked questions). Your voice is the PR body and
  BLOCKED.md. Never ask questions anywhere — BLOCKED.md is the question channel.
- You have a time and cost budget. When told to wrap up, do it immediately: make what you
  have correct, then open a PR if it is a real fix, otherwise write BLOCKED.md stating
  precisely what remains.

## Final message

Your final assistant message is a machine-parsed report, at most 10 lines:
the PR URL if you opened one, or the single word BLOCKED if you wrote BLOCKED.md,
plus a 1-3 line summary. No questions, no requests for confirmation.`;
}

/** First task prompt for a fresh run. */
export function taskPrompt({ issue, title, body, comments, base, branch, timeBudgetMinutes, costBudgetUsd, attempt }) {
  const commentBlock = comments?.length
    ? `\nRecent comments on the issue (oldest first, truncated):\n${comments
        .map((cm) => `--- ${cm.author?.login ?? "?"}:\n${clip(cm.body, 1500)}`)
        .join("\n")}\n`
    : "\nNo comments yet on the issue.\n";

  return `Resolve GitHub issue #${issue}: "${title}".

Issue body:
---
${clip(body, 6000) || "(empty)"}
---
${commentBlock}
You are on branch \`${branch}\` in a fresh worktree of the repository (base branch: \`${base}\`).

Before implementing a fix, reproduce the issue if possible and write a failing test that
demonstrates the problem. Then fix the issue and ensure the test passes. Your PR should
include the test along with the fix.

Follow the worker contract: work the required workflow top to bottom, verify your change,
push your branch, open the PR, stop. If you are genuinely blocked, write BLOCKED.md and stop.`;
}

/** Prompt used by `issue_attack resume` — continues an existing session. */
export function resumePrompt({ issue, prevStatus, blockedNote, newComments, newPrComments, base, branch, attempt, prHasConflicts }) {
  const newBlock = newComments?.length
    ? newComments.map((cm) => `--- ${cm.author?.login ?? "?"} (${cm.createdAt}):\n${clip(cm.body, 2000)}`).join("\n")
    : "(no new comments)";

  const prBlock = newPrComments?.length
    ? newPrComments.map((cm) => `--- ${cm.author?.login ?? "?"} (${cm.createdAt}):\n${clip(cm.body, 2000)}`).join("\n")
    : null;

  const conflictNote = prHasConflicts
    ? "\n**Important**: Your pull request currently has merge conflicts with the base branch. You must fix these conflicts by merging the latest base branch and resolving the conflicts before your PR can be merged."
    : "";

  const prCommentSection = prBlock
    ? `\nNew comments on your pull request since you stopped:
${prBlock}
`
    : "";

  return `You are being resumed on GitHub issue #${issue} (attempt ${attempt}). Your session,
worktree and branch \`${branch}\` are preserved from your previous attempt.

Why you stopped last time: ${prevStatus}.${conflictNote}
${blockedNote ? `\nYour previous BLOCKED.md:\n${clip(blockedNote, 3000)}\n` : ""}
New maintainer activity on the issue since you stopped:
${newBlock}${prCommentSection}
The base branch may have advanced while you were stopped: \`git fetch origin\` and
\`git merge origin/${base}\` (merge only — never rebase) if it has, resolving any
conflicts before continuing.

Continue now: read anything new carefully, resolve the issue (or the blocker), finish the
work, and either open a PR or write a fresh BLOCKED.md. Delete BLOCKED.md once it no longer
applies. Same rules as before: PR when done, BLOCKED.md only when genuinely stuck.`;
}

/** Sent when a settled run's PR turns out to conflict with the moved base. */
export function conflictPrompt({ base, branch }) {
  return `Your pull request now conflicts with the base branch \`${base}\` — it advanced while you worked (pull requests merge asynchronously).

Fix it now:
1. \`git fetch origin\`
2. \`git merge origin/${base}\` (merge only — never rebase, never force-push)
3. Resolve the conflicts, preserving both your change and the base changes; re-run the tests
4. \`git push origin ${branch}\` (normal push)

If a conflict genuinely cannot be resolved correctly without maintainer input,
write BLOCKED.md describing it and stop.`;
}

/** Auto-retry prompt after a run ends with neither PR nor BLOCKED.md. */
export function continuePrompt({ issue, reason }) {
  return `Your previous attempt on issue #${issue} ended without opening a PR and without
writing BLOCKED.md (${reason}). Continue the task now.

First inspect where you left off: \`git status\`, \`git log --oneline -10\`, and your recent
tool activity. Then either finish and open the PR, or write BLOCKED.md if you are stuck.
Do not repeat work you already completed.`;
}

/** Soft-budget steering message. */
export function wrapupPrompt({ issue }) {
  return `[BUDGET] You are near your time/cost budget for issue #${issue}. Wrap up NOW:
stop any background jobs you are polling unless they are about to finish, make the
current step correct, then either open a PR (only if it is a real,
complete fix) or write BLOCKED.md describing exactly what remains. Do not start new work.`;
}

export const STATUS_MARKER = "<!-- issue_attack:status -->";

export const TOOL_URL = "https://github.com/robtandy/issue_attack";

/** Footer appended to agent-opened PRs (by the supervisor, if the agent didn't). */
export function prFooter({ issue, attempt, model, thinking }) {
  const modelInfo = model ? ` with ${model}${thinking ? ` (thinking: ${thinking})` : ""}` : "";
  return `---
🤖 This PR was opened by an [issue_attack](${TOOL_URL}) agent autonomously working issue #${issue}${attempt ? ` (attempt ${attempt})` : ""}${modelInfo}.`;
}

/** Check whether a PR body already carries the footer. */
export function hasPrFooter(body) {
  return String(body ?? "").includes("This PR was opened by an");
}

/** Heartbeat status comment body (edited in place while the run is live). */
export function statusCommentBody({ state, issue, attempt, elapsedMs, budget, usage, lastAction, extra }) {
  const lines = [
    STATUS_MARKER,
    `### 🤖 issue_attack agent — ${state}`,
    "",
    "| | |",
    "|---|---|",
    `| Attempt | ${attempt} |`,
    `| Elapsed | ${fmtMin(elapsedMs)}${budget?.timeBudgetMinutes ? ` of ${budget.timeBudgetMinutes}m` : ""} |`,
  ];
  if (usage) {
    lines.push(`| Model usage | ${usage.tokens ?? "—"}${usage.maxTokens ? ` / ${usage.maxTokens}` : ""} |`);
  }
  if (lastAction) lines.push(`| Current | \`${clip(String(lastAction), 80)}\` |`);
  if (extra) lines.push(`| Note | ${clip(extra, 200)} |`);
  lines.push(
    "",
    `This comment updates automatically while the agent works. Sent by [issue_attack](${TOOL_URL}).`,
    `To redirect it live: \`issue_attack steer ${issue} "<guidance>"\` — replies here are picked up on resume (\`issue_attack resume ${issue}\`).`
  );
  return lines.join("\n");
}

/** Final outcome comment (a fresh, human-readable comment). */
export function outcomeComment({ outcome, issue, prUrl, blockedBody, lastText, attempt, cost, elapsedMs, logPath, worktree, retrying, conflicts }) {
  const stat = `${attempt ? `attempt ${attempt}` : ""}${elapsedMs ? `, ${fmtMin(elapsedMs)}` : ""}`;
  const parts = [];
  if (outcome === "succeeded") {
    const prRef = prUrl ? prUrl.replace("https://github.com/", "") : "PR";
    parts.push(`✅ issue_attack agent opened ${prRef} — ${stat}.`);
    if (conflicts) {
      parts.push(
        "",
        "⚠️ The PR currently conflicts with the base branch — it moved after the PR opened. " +
        `Run \`issue_attack resume ${issue}\` to have the agent merge and resolve, or fix it manually.`
      );
    } else {
      parts.push("", "Review and merge at your leisure; the agent is finished.");
    }
  } else if (outcome === "blocked") {
    parts.push(
      `🤖 issue_attack agent is **blocked** on this issue (${stat}).`,
      "",
      clip(blockedBody ?? "(no BLOCKED.md content)", 4000),
      "",
      `Reply to the questions above, then run \`issue_attack resume ${issue}\` — the agent's worktree and session are kept.`
    );
  } else if (outcome === "timeout") {
    parts.push(
      `⏱️ issue_attack agent exceeded its budget (${stat}) without finishing.`,
      "",
      clip(lastText ?? "(no final message)", 2000),
      "",
      `Its worktree and session are kept — run \`issue_attack resume ${issue}\` to continue with a fresh budget.`
    );
  } else if (outcome === "failed") {
    parts.push(
      `⚠️ issue_attack agent run ended without a PR or BLOCKED.md (${stat}).${retrying ? " Retrying automatically…" : ""}`,
      "",
      clip(lastText ?? "(no final message)", 2000),
      "",
      retrying ? "" : `Session and worktree kept — \`issue_attack resume ${issue}\` to continue, \`issue_attack cleanup --purge ${issue}\` to discard.`
    );
  } else if (outcome === "stopped") {
    parts.push(`✋ issue_attack agent was stopped by the operator (${stat}). Worktree and session kept; \`issue_attack resume ${issue}\` to continue.`);
  }
  return parts.filter((p) => p !== "").join("\n");
}

function fmtMin(ms) {
  const m = Math.round(ms / 60000);
  return m < 1 ? "<1m" : `${m}m`;
}

function clip(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 3) + "..." : str;
}
