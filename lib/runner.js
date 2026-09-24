// AgentRunner: the full lifecycle of one agent attacking one issue.
//
//   claim issue -> create/reuse worktree -> spawn pi (RPC) -> send task ->
//   monitor (budgets, steering inbox, stop flag, policy, heartbeat comment) ->
//   classify outcome -> comment/label the issue -> update local state.
//
// The fleet function runs several runners concurrently against a label queue.

import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { c, toolSummary } from "./ui.js";
import * as gh from "./gh.js";
import * as git from "./git.js";
import * as stateMod from "./state.js";
import { checkCommand, violationMessage } from "./policy.js";
import { PiClient } from "./pi-client.js";
import {
  workerContract, taskPrompt, resumePrompt, continuePrompt, wrapupPrompt,
  statusCommentBody, outcomeComment,
} from "./prompt.js";
import { dirs } from "./config.js";

const noop = () => {};

export class SkipIssue extends Error {
  constructor(reason) {
    super(reason);
    this.code = "SKIP";
  }
}

export class AgentRunner {
  /**
   * @param {{root: string, repo: string, repoInfo: {nameWithOwner: string, defaultBranch: string},
   *          config: object, issue: number, mode?: 'run'|'resume'|'fresh', model?: string,
   *          onLine?: (msg: string) => void, streamText?: boolean}} opts
   */
  constructor(opts) {
    this.root = opts.root;
    this.repo = opts.repoInfo.nameWithOwner;
    this.repoInfo = opts.repoInfo;
    this.config = opts.config;
    this.issue = opts.issue;
    this.mode = opts.mode ?? "run";
    this.model = opts.model ?? null;
    this.onLine = opts.onLine ?? null;
    this.streamText = opts.streamText ?? false;

    this.startedAt = Date.now();
    this.outcome = null;
    this.violations = 0;
    this.stopRequested = false;
    this.softSent = false;
    this.statusCommentId = null;
    this.lastAction = null;
    this.state = stateMod.loadState(this.root);
    this.entry = stateMod.getEntry(this.state, this.issue);
  }

  line(msg) {
    (this.onLine ?? ((m) => console.log(m)))(msg);
  }

  logPath() {
    return join(dirs(this.root).logs, `issue-${this.issue}.jsonl`);
  }

  async run() {
    try {
      this.issueRecord = await gh.viewIssue(this.root, this.repo, this.issue);
      if (this.issueRecord.state !== "OPEN") throw new SkipIssue(`issue is ${this.issueRecord.state}`);

      this.base = this.config.baseBranch ?? this.repoInfo.defaultBranch;
      this.branch = git.branchName(this.issue);
      this.worktree = git.worktreePath(this.root, this.issue);

      await this.claim();

      this.attempt = (this.entry?.attempts ?? 0) + 1;
      stateMod.setEntry(this.state, this.issue, {
        status: "running",
        attempts: this.attempt,
        branch: this.branch,
        worktree: this.worktree,
        supervisorPid: process.pid,
        startedAt: new Date(this.startedAt).toISOString(),
        mode: this.mode,
      });
      stateMod.saveState(this.root, this.state);
      this.line(`${c.bold(`attempt ${this.attempt}`)} on branch ${c.cyan(this.branch)}`);

      await git.ensureWorktree(this.root, this.worktree, this.branch, this.base);
      await this.startClient();
      await this.sendTask();

      this.outcome = await this.monitorLoop();
    } catch (err) {
      if (err.code === "SKIP") {
        this.outcome = { kind: "skipped", reason: err.message };
      } else {
        this.outcome = { kind: "error", reason: err.message };
        this.line(`${c.red("error:")} ${err.message}`);
      }
    }
    // Capture final stats while the client is still alive.
    if (this.client && !this.client.exitInfo) {
      this.finalStats = await this.client.stats().catch(() => null);
      if (!this.outcome?.lastText) {
        this.outcome = { ...this.outcome, lastText: await this.client.lastAssistantText().catch(() => null) };
      }
    }
    await this.finalize();
    return this.outcome;
  }

  // ---- Claim ----------------------------------------------------------------

  async claim() {
    const me = await gh.currentUser();
    const labels = (this.issueRecord.labels ?? []).map((l) => l.name);
    const assignees = (this.issueRecord.assignees ?? []).map((a) => a.login);
    const others = assignees.filter((a) => a !== me);
    const ours = labels.includes(this.config.claimedLabel) && assignees.includes(me);

    if (others.length > 0) throw new SkipIssue(`assigned to ${others.join(", ")}`);
    if (labels.includes(this.config.claimedLabel) && !ours && this.mode !== "resume") {
      throw new SkipIssue(`labeled ${this.config.claimedLabel} by another runner`);
    }
    if (ours) {
      this.line(`re-owning existing claim on issue ${this.issue}`);
      return;
    }

    await gh.ensureLabel(this.root, this.repo, this.config.claimedLabel, "d4c5f9", "claimed by an issue_attack agent");
    await gh.editIssue(this.root, this.repo, this.issue, {
      issue: this.issueRecord,
      addLabels: [this.config.claimedLabel],
      addAssignee: me,
    });

    // Optimistic-concurrency verify: we must be the only assignee.
    const after = await gh.viewIssue(this.root, this.repo, this.issue);
    const a2 = (after.assignees ?? []).map((a) => a.login);
    if (a2.some((a) => a !== me)) {
      await gh.editIssue(this.root, this.repo, this.issue, {
        issue: after,
        removeAssignee: me,
        removeLabels: (after.labels ?? []).map((l) => l.name).includes(this.config.claimedLabel)
          ? [this.config.claimedLabel]
          : [],
      }).catch(noop);
      throw new SkipIssue(`lost claim race to ${a2.filter((a) => a !== me).join(", ")}`);
    }
    this.issueRecord = after;
    this.line(`claimed issue ${this.issue} as ${c.cyan(me)}`);
  }

  async releaseClaim({ removeLabels = [] } = {}) {
    const me = await gh.currentUser().catch(() => null);
    if (!me) return;
    try {
      const rec = await gh.viewIssue(this.root, this.repo, this.issue);
      const labels = (rec.labels ?? []).map((l) => l.name);
      const toRemove = removeLabels.filter((l) => labels.includes(l));
      const ours = (rec.assignees ?? []).some((a) => a.login === me);
      await gh.editIssue(this.root, this.repo, this.issue, {
        issue: rec,
        removeLabels: toRemove,
        removeAssignee: ours ? me : undefined,
      });
    } catch (err) {
      this.line(`${c.yellow("warn:")} could not release claim: ${err.message}`);
    }
  }

  // ---- pi -------------------------------------------------------------------

  async startClient() {
    const sessionRoot = join(dirs(this.root).sessions, `issue-${this.issue}`);
    mkdirSync(sessionRoot, { recursive: true });
    const sessionId =
      this.mode === "fresh" || !this.entry?.sessionId
        ? `ia-issue-${this.issue}${this.mode === "fresh" ? "-" + Date.now().toString(36) : ""}`
        : this.entry.sessionId;
    this.sessionId = sessionId;

    mkdirSync(join(this.root, ".issue_attack", "logs"), { recursive: true });
    appendFileSync(this.logPath(), `\n# attempt ${this.attempt} ${new Date().toISOString()} mode=${this.mode}\n`);

    const args = [
      "--session-dir", sessionRoot,
      "--session-id", sessionId,
      "--name", `issue-${this.issue}`,
    ];
    if (this.config.approve) args.push("-a");
    else args.push("-na");
    if (this.model || this.config.model) args.push("--model", this.model || this.config.model);
    if (this.config.noExtensions) args.push("-ne");
    args.push(...(this.config.extraFlags ?? []));
    if (this.config.prDraft) args.push("--append-system-prompt", `Open the pull request as a draft: add --draft to gh pr create.`);

    this.client = new PiClient({
      bin: this.config.piBin,
      args: [...args, "--append-system-prompt", workerContract({
        issue: this.issue, repo: this.repo, base: this.base, branch: this.branch, prDraft: this.config.prDraft,
      })],
      cwd: this.worktree,
      env: { PI_SKIP_VERSION_CHECK: "1" },
      onRecord: (rec) => this.handleRecord(rec),
    });
    await this.client.start();
    await this.client.getState(); // protocol liveness check
    stateMod.setEntry(this.state, this.issue, { sessionId, piPid: this.client.child?.pid ?? null });
    stateMod.saveState(this.root, this.state);
    this.line(`pi session ${c.cyan(sessionId)} (pid ${this.client.child?.pid})`);
  }

  async sendTask() {
    let promptText;
    if (this.mode === "resume" && this.entry) {
      const since = this.entry.endedAt ?? this.entry.startedAt ?? new Date(0).toISOString();
      const newComments = (this.issueRecord.comments ?? []).filter((cm) => cm.createdAt > since);
      let blockedNote = null;
      const blockedPath = join(this.worktree, "BLOCKED.md");
      if (existsSync(blockedPath)) blockedNote = readFileSync(blockedPath, "utf8");
      promptText = resumePrompt({
        issue: this.issue,
        prevStatus: this.entry.status ?? "unknown",
        blockedNote,
        newComments,
        base: this.base,
        branch: this.branch,
        attempt: this.attempt,
      });
    } else {
      const comments = (this.issueRecord.comments ?? []).slice(-this.config.recentComments);
      promptText = taskPrompt({
        issue: this.issue,
        title: this.issueRecord.title,
        body: this.issueRecord.body,
        comments,
        base: this.base,
        branch: this.branch,
        timeBudgetMinutes: this.config.timeBudgetMinutes,
        costBudgetUsd: this.config.costBudgetUsd,
        attempt: this.attempt,
      });
    }
    await this.client.message(promptText);
    this.line(`task dispatched (${promptText.length} chars)`);
  }

  // ---- Monitoring ------------------------------------------------------------

  handleRecord(rec) {
    try {
      appendFileSync(this.logPath(), JSON.stringify(rec) + "\n");
    } catch {
      /* logging must never break the run */
    }

    if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") {
      if (this.streamText) process.stdout.write(rec.assistantMessageEvent.delta);
      return;
    }
    if (rec.type === "tool_execution_start") {
      const sum = toolSummary(rec);
      this.lastAction = `${rec.toolName}: ${sum}`;
      this.line(`${c.dim("→")} ${rec.toolName} ${c.dim(sum)}`);
      if (rec.toolName === "bash" || rec.toolName === "powershell") {
        const v = checkCommand(rec.args?.command ?? "", { baseBranch: this.base, branch: this.branch });
        if (!v.ok) this.handleViolation(v);
      }
      return;
    }
    if (rec.type === "agent_settled") {
      this.line(c.dim("· agent settled"));
    }
  }

  handleViolation(v) {
    this.violations++;
    this.line(`${c.red(`policy violation (${v.rule}):`)} ${v.reason}`);
    if (this.violations === 1) {
      this.client.message(violationMessage(v)).catch((e) => this.line(`steer failed: ${e.message}`));
    } else {
      this.line(c.red("second violation — aborting run"));
      this.client.abort().catch(noop);
    }
  }

  requestStop() {
    this.stopRequested = true;
  }

  async monitorLoop() {
    const tickMs = 2_000;
    let handledSettled = 0;
    let lastStatsAt = 0;
    let lastHeartbeatAt = Date.now();
    let stats = null;

    while (true) {
      await sleep(tickMs);

      if (this.client.exitInfo) {
        return { kind: "failed", reason: `pi process exited (code=${this.client.exitInfo.code})`, lastText: null };
      }

      // Operator stop (same process flag or cross-process marker file).
      if (this.stopRequested || stateMod.takeStop(this.root, this.issue)) {
        this.line(c.yellow("stop requested — aborting agent"));
        await this.client.abort().catch(noop);
        return { kind: "stopped" };
      }

      // Steering inbox (written by `issue_attack steer` in another process).
      for (const s of stateMod.takeSteer(this.root, this.issue)) {
        this.line(`${c.magenta("steer:")} ${s.message}`);
        await this.client.message(`[OPERATOR GUIDANCE] ${s.message}`).catch((e) =>
          this.line(`steer failed: ${e.message}`)
        );
      }

      // Usage polling.
      if (Date.now() - lastStatsAt > 10_000) {
        lastStatsAt = Date.now();
        stats = (await this.client.stats().catch(() => stats)) ?? stats;
      }
      const usage = {
        cost: stats?.cost ?? null,
        tokens: stats?.tokens?.total ?? null,
      };

      // Budgets: soft steer, hard abort.
      const elapsed = Date.now() - this.startedAt;
      const tBudgetMs = this.config.timeBudgetMinutes * 60_000;
      const softMs = tBudgetMs * this.config.softBudgetRatio;
      const costOver = this.config.costBudgetUsd && usage.cost != null && usage.cost >= this.config.costBudgetUsd;
      const costSoft =
        this.config.costBudgetUsd && usage.cost != null &&
        usage.cost >= this.config.costBudgetUsd * this.config.softBudgetRatio;
      const tokenOver = this.config.maxTokens && usage.tokens != null && usage.tokens >= this.config.maxTokens;

      if (!this.softSent && (elapsed >= softMs || costSoft)) {
        this.softSent = true;
        this.line(c.yellow("soft budget reached — telling agent to wrap up"));
        await this.client.message(wrapupPrompt({ issue: this.issue })).catch(noop);
      }
      if (elapsed >= tBudgetMs || costOver || tokenOver) {
        this.line(c.red("budget exceeded — aborting agent"));
        await this.client.abort().catch(noop);
        await this.waitSettle(30_000);
        return { kind: "timeout" };
      }

      // Heartbeat status comment on the issue.
      if (this.config.heartbeatMinutes > 0 &&
          Date.now() - lastHeartbeatAt >= this.config.heartbeatMinutes * 60_000) {
        lastHeartbeatAt = Date.now();
        await this.updateStatusComment("running", usage).catch((e) =>
          this.line(`${c.yellow("warn:")} heartbeat comment failed: ${e.message}`)
        );
      }

      // Completion: settled and genuinely idle.
      if (this.client.settledCount > handledSettled) {
        handledSettled = this.client.settledCount;
        const st = await this.client.getState().catch(() => null);
        if (!st || (!st.isStreaming && (st.pendingMessageCount ?? 0) === 0)) {
          const result = await this.classify();
          if (result.kind === "failed" && this.attempt < this.config.maxAttempts && !this.stopRequested) {
            this.line(c.yellow("no PR and no BLOCKED.md — auto-retry with a continue prompt"));
            this.attempt++;
            stateMod.setEntry(this.state, this.issue, { attempts: this.attempt });
            stateMod.saveState(this.root, this.state);
            await this.client.message(continuePrompt({ issue: this.issue, reason: result.reason }));
            continue;
          }
          return result;
        }
      }
    }
  }

  async waitSettle(timeoutMs) {
    const target = this.client.settledCount + 1;
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline && this.client.settledCount < target && !this.client.exitInfo) {
      await sleep(500);
    }
  }

  async classify() {
    const prs = await gh.prsForBranch(this.root, this.repo, this.branch).catch(() => []);
    const open = prs.find((p) => p.state === "OPEN") ?? prs[0];
    if (open) return { kind: "succeeded", prUrl: open.url, prNumber: open.number };

    const blockedPath = join(this.worktree, "BLOCKED.md");
    if (existsSync(blockedPath)) {
      return { kind: "blocked", body: readFileSync(blockedPath, "utf8") };
    }
    const lastText = await this.client.lastAssistantText().catch(() => null);
    return { kind: "failed", reason: "ended without opening a PR or writing BLOCKED.md", lastText };
  }

  // ---- Issue-side output ----------------------------------------------------

  async updateStatusComment(stateLabel, usage, extra) {
    const body = statusCommentBody({
      state: stateLabel,
      issue: this.issue,
      attempt: this.attempt,
      elapsedMs: Date.now() - this.startedAt,
      budget: this.config,
      usage: usage
        ? { cost: usage.cost, tokens: usage.tokens, maxTokens: this.config.maxTokens }
        : null,
      lastAction: this.lastAction,
      extra,
    });
    if (this.statusCommentId) {
      await gh.editComment(this.root, this.repo, this.statusCommentId, body);
    } else {
      const existing = gh.findStatusComment(this.issueRecord);
      if (existing) {
        this.statusCommentId = existing.id;
        await gh.editComment(this.root, this.repo, existing.id, body);
      } else {
        this.statusCommentId = await gh.createComment(this.root, this.repo, this.issue, body);
      }
    }
  }

  async deleteStatusComment() {
    if (!this.statusCommentId) return;
    try {
      await gh.deleteComment(this.root, this.repo, this.statusCommentId);
    } catch {
      /* best effort */
    }
    this.statusCommentId = null;
  }

  async postOutcome(kind) {
    const body = outcomeComment({
      outcome: kind,
      issue: this.issue,
      prUrl: this.outcome?.prUrl,
      blockedBody: this.outcome?.body,
      lastText: this.outcome?.lastText ?? this.outcome?.reason,
      attempt: this.attempt,
      cost: this.finalStats?.cost ?? null,
      elapsedMs: Date.now() - this.startedAt,
      logPath: this.logPath(),
      worktree: this.worktree,
    });
    await gh.createComment(this.root, this.repo, this.issue, body);
  }

  // ---- Finalization ---------------------------------------------------------

  async finalize() {
    const kind = this.outcome?.kind ?? "error";

    if (this.client) {
      await this.client.close().catch(noop);
      this.client = null;
    }

    const safe = async (label, fn) => {
      try {
        await fn();
      } catch (err) {
        this.line(`${c.yellow("warn:")} ${label} failed: ${err.message}`);
      }
    };

    if (kind === "skipped") {
      this.line(`${c.dim("skipped:")} ${this.outcome.reason}`);
      return;
    }

    if (kind === "succeeded") {
      await safe("label issue done", async () => {
        await gh.ensureLabel(this.root, this.repo, this.config.doneLabel, "0e8a16", "resolved by an issue_attack agent");
        await gh.editIssue(this.root, this.repo, this.issue, {
          issue: this.issueRecord,
          addLabels: [this.config.doneLabel],
          removeLabels: [this.config.claimedLabel, this.config.blockedLabel],
          removeAssignee: await gh.currentUser(),
        });
      });
      await safe("label PR", async () => {
        const created = await gh.addPrLabel(this.root, this.repo, this.outcome.prNumber, this.config.prLabel).catch(() => false);
        if (!created) {
          await gh.ensureLabel(this.root, this.repo, this.config.prLabel, "1d76db", "opened by an issue_attack agent");
          await gh.addPrLabel(this.root, this.repo, this.outcome.prNumber, this.config.prLabel);
        }
      });
      await this.deleteStatusComment();
      await safe("outcome comment", () => this.postOutcome("succeeded"));
      this.line(`${c.green("✔ PR opened:")} ${this.outcome.prUrl}`);
    } else if (kind === "blocked") {
      await safe("label issue blocked", async () => {
        await gh.ensureLabel(this.root, this.repo, this.config.blockedLabel, "fbca04", "issue_attack agent is blocked, needs maintainer input");
        await gh.editIssue(this.root, this.repo, this.issue, {
          issue: this.issueRecord,
          addLabels: [this.config.blockedLabel],
          removeLabels: [this.config.claimedLabel],
          removeAssignee: await gh.currentUser(),
        });
      });
      await this.deleteStatusComment();
      await safe("outcome comment", () => this.postOutcome("blocked"));
      this.line(c.yellow("agent blocked — comment posted to issue"));
    } else if (kind === "timeout" || kind === "failed") {
      await safe("release claim", () => this.releaseClaim({ removeLabels: [this.config.claimedLabel] }));
      await this.deleteStatusComment();
      await safe("outcome comment", () => this.postOutcome(kind));
      this.line(c.red(`run ended: ${kind}`));
    } else if (kind === "stopped") {
      await safe("release claim", () => this.releaseClaim({ removeLabels: [this.config.claimedLabel] }));
      this.line(c.yellow("stopped"));
    } else if (kind === "error") {
      await safe("release claim", () => this.releaseClaim({ removeLabels: [this.config.claimedLabel] }));
      this.line(c.red(`error: ${this.outcome.reason}`));
    }

    stateMod.setEntry(this.state, this.issue, {
      status: kind,
      endedAt: new Date().toISOString(),
      prUrl: this.outcome?.prUrl ?? null,
      cost: this.finalStats?.cost ?? null,
      tokens: this.finalStats?.tokens?.total ?? null,
      sessionId: this.sessionId ?? this.entry?.sessionId ?? null,
      piPid: null,
    });
    stateMod.saveState(this.root, this.state);
  }
}

// ---- Fleet -------------------------------------------------------------------

/**
 * Run up to `max` agents concurrently against issues labeled `label`.
 * With `watch`, keep polling for new work until interrupted.
 */
export async function attackFleet({ root, repoInfo, config, max, label, watch, pollSeconds, limit, model, out }) {
  const repo = repoInfo.nameWithOwner;
  const state = stateMod.loadState(root);
  const active = new Map(); // issueNumber -> {done, runner}
  let stopping = false;

  const fleetLine = (n, msg) => out(`[${c.bold(`#${n}`)}] ${msg}`);

  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    out(c.yellow("\nstopping all agents (Ctrl-C again to force)…"));
    for (const n of active.keys()) stateMod.setStop(root, n);
  };
  process.on("SIGINT", onSigint);

  const nextClaimable = async () => {
    // Re-read state each pass: runners mutate it on disk as they finish.
    const state = stateMod.loadState(root);
    const issues = await gh.listIssues(root, repo, label, limit ?? 100).catch((e) => {
      out(c.yellow(`warn: issue list failed: ${e.message}`));
      return [];
    });
    for (const it of issues) {
      const labels = (it.labels ?? []).map((l) => l.name);
      if (labels.includes(config.claimedLabel)) continue;
      if ((it.assignees ?? []).length > 0) continue;
      if (active.has(it.number)) continue;
      const entry = stateMod.getEntry(state, it.number);
      if (entry?.status === "running") continue;
      // Terminal entries need a human decision — except runs orphaned by a dead
      // supervisor (crash recovery), which the fleet re-attacks automatically.
      if (entry && !(entry.status === "failed" && entry.note === "supervisor exited before the run finished")) continue;
      return it;
    }
    return null;
  };

  const launch = async (issueNumber) => {
    const entry = stateMod.getEntry(stateMod.loadState(root), issueNumber);
    const mode = entry ? "resume" : "run";
    const runner = new AgentRunner({
      root, repoInfo, config, issue: issueNumber, mode, model,
      onLine: (m) => fleetLine(issueNumber, m),
    });
    const slot = { done: false, runner };
    active.set(issueNumber, slot);
    runner.run().then((out2) => {
      if (out2.kind === "skipped") fleetLine(issueNumber, c.dim(`skipped: ${out2.reason}`));
      slot.done = true;
    }).catch((err) => {
      fleetLine(issueNumber, c.red(`runner crashed: ${err.message}`));
      slot.done = true;
    });
  };

  out(`attacking ${c.bold(repo)} — label: ${c.cyan(label)} max: ${max}${watch ? " (watch mode)" : ""}`);

  let wake = null;
  const sleepInterruptible = (ms) =>
    new Promise((r) => {
      wake = r;
      setTimeout(r, ms);
    });

  while (true) {
    while (!stopping && active.size < max) {
      const next = await nextClaimable();
      if (!next) break;
      fleetLine(next.number, `picked up: ${next.title}`);
      await launch(next.number);
    }

    const finished = [...active.entries()].filter(([, s]) => s.done);
    for (const [n] of finished) active.delete(n);

    if (active.size === 0) {
      if (!watch || stopping) break;
      await sleepInterruptible(pollSeconds * 1000);
    } else {
      await sleepInterruptible(1000);
    }
  }

  process.removeListener("SIGINT", onSigint);
  out("fleet drained.");
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
