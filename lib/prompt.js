// Worker prompts. The contract is appended to pi's system prompt; the task
// prompt is the first user message. BLOCKED.md is the worker's escape hatch.

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
4. Commit in small, reviewable units with clear messages referencing issue #${issue}.
5. Verify: run the project's tests/lint/build when present. Add or update tests for behavior
   you add or change. If unrelated tests fail, investigate briefly and document it.
6. Push only your branch: \`git push origin ${branch}\`, then open the PR:
   - base: \`${base}\`, head: \`${branch}\`
   - title: \`issue #${issue}: <concise summary>\`
   - body must include: \`Closes #${issue}\`, a What changed section, a How verified section,
     and any assumptions you made.
   - command shape: \`gh pr create --base ${base} --head ${branch} --title "..." --body "..."\`${prDraft ? "\n   - open it as a draft: add --draft" : ""}
7. Stop once the PR is open. Do not merge, do not edit the PR afterwards, do not close anything.

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
- Comment on the issue at most once per run, only to record a significant decision or
  assumption — never to ask questions (BLOCKED.md is the question channel).
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
  const budget = [];
  if (timeBudgetMinutes) budget.push(`~${timeBudgetMinutes}m of agent time`);
  if (costBudgetUsd) budget.push(`~$${costBudgetUsd} of model cost`);
  const budgetLine = budget.length ? budget.join(" and ") : "no explicit budget";

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
Budget for this attempt: ${budgetLine}. Attempt ${attempt}.

Follow the worker contract: work the required workflow top to bottom, verify your change,
push your branch, open the PR, stop. If you are genuinely blocked, write BLOCKED.md and stop.`;
}

/** Prompt used by `issue_attack resume` — continues an existing session. */
export function resumePrompt({ issue, prevStatus, blockedNote, newComments, base, branch, attempt }) {
  const newBlock = newComments?.length
    ? newComments.map((cm) => `--- ${cm.author?.login ?? "?"} (${cm.createdAt}):\n${clip(cm.body, 2000)}`).join("\n")
    : "(no new comments)";

  return `You are being resumed on GitHub issue #${issue} (attempt ${attempt}). Your session,
worktree and branch \`${branch}\` are preserved from your previous attempt.

Why you stopped last time: ${prevStatus}.
${blockedNote ? `\nYour previous BLOCKED.md:\n${clip(blockedNote, 3000)}\n` : ""}
New maintainer activity on the issue since you stopped:
${newBlock}

Continue now: read anything new carefully, resolve the issue (or the blocker), finish the
work, and either open a PR or write a fresh BLOCKED.md. Delete BLOCKED.md once it no longer
applies. Same rules as before: PR when done, BLOCKED.md only when genuinely stuck.`;
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
finish the current step so it is correct, then either open a PR (only if it is a real,
complete fix) or write BLOCKED.md describing exactly what remains. Do not start new work.`;
}

export const STATUS_MARKER = "<!-- issue_attack:status -->";

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
    if (usage.cost != null) {
      lines.push(`| Cost | $${usage.cost.toFixed(2)}${budget?.costBudgetUsd ? ` of $${budget.costBudgetUsd.toFixed(2)}` : ""} |`);
    }
  }
  if (lastAction) lines.push(`| Current | \`${clip(String(lastAction), 80)}\` |`);
  if (extra) lines.push(`| Note | ${clip(extra, 200)} |`);
  lines.push(
    "",
    "This comment updates automatically while the agent works.",
    `To redirect it live: \`issue_attack steer ${issue} "<guidance>"\` — replies here are picked up on resume (\`issue_attack resume ${issue}\`).`
  );
  return lines.join("\n");
}

/** Final outcome comment (a fresh, human-readable comment). */
export function outcomeComment({ outcome, issue, prUrl, blockedBody, lastText, attempt, cost, elapsedMs, logPath, worktree, retrying }) {
  const stat = `${attempt ? `attempt ${attempt}` : ""}${cost != null ? `, $${cost.toFixed(2)}` : ""}${elapsedMs ? `, ${fmtMin(elapsedMs)}` : ""}`;
  const parts = [];
  if (outcome === "succeeded") {
    const prRef = prUrl ? prUrl.replace("https://github.com/", "") : "PR";
    parts.push(`✅ issue_attack agent opened ${prRef} — ${stat}.`, "", "Review and merge at your leisure; the agent is finished.");
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
  if (logPath) parts.push("", `<sub>run log: ${logPath}</sub>`);
  if (worktree) parts.push(`<sub>worktree: ${worktree}</sub>`);
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
