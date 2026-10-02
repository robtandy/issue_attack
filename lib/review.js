// Review supervisor: `ia review` — spawns a reviewer agent per pending agent
// PR, parses its verdict, and acts supervisor-side:
//   APPROVE         → re-check the PR (open, same head, mergeable), post the
//                     review comment, merge with a merge commit
//   REQUEST_CHANGES → post the feedback comment on the PR (picked up by
//                     `ia resume`'s unacknowledged-comment logic, closing the
//                     review loop), and the PR is re-reviewed once re-pushed
//
// Review state lives on the PR as a marker comment keyed by the head SHA
// (see reviewComment) — nothing depends on state.json. The reviewer runs in
// a detached worktree under .issue_attack/reviews/ (invisible to `ia cleanup`),
// may run the project's tests, and never merges, comments, or pushes: the
// supervisor executes all outcomes, mirroring the worker/supervisor split.

import { appendFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { c, toolSummary } from "./ui.js";
import * as gh from "./gh.js";
import { checkCommand } from "./policy.js";
import { PiClient } from "./pi-client.js";
import { exec, must } from "./exec.js";
import { parseModelSpec, resolveModelSpec, finalErrorFromAgentEnd } from "./runner.js";
import { reviewerContract, reviewPrompt, reviewComment } from "./prompt.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const noop = () => {};

/** Reviewer model resolution: --model flag > config.reviewModel > config.model. */
export function effectiveReviewModel(flagModel, config) {
  return flagModel ?? config?.reviewModel ?? config?.model ?? null;
}

/** Parse the reviewer's final message. The verdict is a line that starts
 *  (after markdown decoration) with APPROVE or REQUEST_CHANGES — agents
 *  are told to put it first, but models often wrap it in prose, so it is
 *  searched anywhere in the message. Everything else is the summary. */
export function parseReviewVerdict(text) {
  if (!text) return { action: "none", summary: null };
  const lines = String(text)
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);
  const VERDICT = /^[#*>\s]*(?:\*{0,2})\s*(APPROVED?|REQUEST[_ ]CHANGES)\b(?:\*{0,2})\s*[.!:—-]*\s*(.*)$/i;
  let idx = -1;
  let m = null;
  for (let i = 0; i < lines.length; i++) {
    const hit = lines[i].match(VERDICT);
    if (hit) {
      idx = i;
      m = hit;
      break;
    }
  }
  if (idx < 0) {
    // Fallback: the verdict trailing at the very end of the final message
    // ("…everything checks out. APPROVE") — with a negation guard so
    // "…I do not APPROVE" cannot read as an approval.
    const trail = text.match(/\b(\S+\s+)?(APPROVED?|REQUEST[_ ]CHANGES)\*{0,2}\s*[.!?:]*\s*$/i);
    const negator = /^(not|never|cannot|cant|don'?t|dont|won'?t|wont|wouldn'?t|shouldn'?t|do)$/i;
    if (trail && !negator.test((trail[1] ?? "").trim())) {
      const keyword = trail[2].toUpperCase().replace(/[_\s]+/g, "_");
      // summary: everything before the trailing verdict token (the prose line(s))
      const prefix = text.slice(0, trail.index + (trail[1] ?? "").length).trim();
      return {
        action: keyword.startsWith("APPROVE") ? "approve" : "request_changes",
        summary: prefix || null,
      };
    }
    return { action: "none", summary: lines.join("\n") };
  }
  const keyword = m[1].toUpperCase().replace(/[_\s]+/g, "_");
  const action = keyword.startsWith("APPROVE") ? "approve" : "request_changes";
  const summary = [m[2].trim(), ...lines.slice(idx + 1)].join("\n").trim() || null;
  return { action, summary };
}

/** Head SHA this PR was last reviewed at (from marker comments), or null. */
export function reviewedShaFromComments(comments) {
  let sha = null;
  for (const cm of comments ?? []) {
    const m = String(cm.body ?? "").match(/<!-- issue_attack:review:([0-9a-f]+) -->/);
    if (m) sha = m[1];
  }
  return sha;
}

/** Open, labeled, non-draft agent PRs that have not been reviewed at their
 *  current head. Returns [{ pr, issue }] with full PR records. */
export async function pendingReviews(root, repo, config) {
  const listed = await gh.listOpenPrsWithLabel(root, repo, config.prLabel).catch(() => []);
  const pending = [];
  for (const pr of listed) {
    if (pr.isDraft) continue;
    const full = await gh.viewPr(root, repo, pr.number).catch(() => null);
    if (!full || full.state !== "OPEN") continue;
    const head = full.headRefOid ?? pr.headRefOid;
    if (!head) continue;
    if (reviewedShaFromComments(full.comments) === head) continue;
    const issue =
      full.title.match(/issue #(\d+)/)?.[1] ??
      (full.body ?? "").match(/[Cc]loses #(\d+)/)?.[1] ??
      null;
    pending.push({ pr: { ...pr, ...full }, issue: issue ? Number(issue) : null });
  }
  return pending;
}

/** One PR review: detached worktree at the PR head, one pi reviewer session,
 *  verdict parsed from the final assistant message. */
export class ReviewRunner {
  constructor({ root, repoInfo, config, pr, issue, model, onLine, streamText }) {
    this.root = root;
    this.repo = repoInfo.nameWithOwner;
    this.base = config.baseBranch ?? repoInfo.defaultBranch;
    this.config = config;
    this.pr = pr;
    this.issue = issue;
    this.model = model ?? null;
    this.onLine = onLine;
    this.streamText = streamText;
    this.issueRecord = null;
    this.client = null;
    this.modelFailed = null; // terminal model error (agent_end with no retry)
    this.aborted = false;
    this.logPath = join(root, ".issue_attack", "logs", `review-pr-${pr.number}.jsonl`);
  }

  line(msg) {
    (this.onLine ?? ((m) => console.log(m)))(msg);
  }

  async run() {
    const worktree = await this.ensureWorktree();
    try {
      await this.startClient(worktree);
      await this.sendTask();
      return await this.monitor();
    } finally {
      await this.client?.close().catch(noop);
      this.removeWorktree();
    }
  }

  // ---- worktree (detached, at the PR head) --------------------------------

  worktreePath() {
    return join(this.root, ".issue_attack", "reviews", `pr-${this.pr.number}`);
  }

  async ensureWorktree() {
    const dir = this.worktreePath();
    await exec("git", ["worktree", "remove", "--force", dir], { cwd: this.root }).catch(noop);
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dirname(dir), { recursive: true });
    await must("git", ["worktree", "add", "--detach", dir, this.pr.headRefOid], { cwd: this.root });
    await must("git", ["fetch", "origin", this.base], { cwd: dir });
    return dir;
  }

  removeWorktree() {
    exec("git", ["worktree", "remove", "--force", this.worktreePath()], { cwd: this.root }).catch(noop);
    rmSync(this.worktreePath(), { recursive: true, force: true });
  }

  // ---- reviewer session -----------------------------------------------------

  async startClient(worktree) {
    const sessionRoot = join(this.root, ".issue_attack", "sessions", `review-pr-${this.pr.number}`);
    mkdirSync(sessionRoot, { recursive: true });
    const contractPath = join(sessionRoot, "reviewer-contract.md");
    writeFileSync(contractPath, reviewerContract({ repo: this.repo, base: this.base }));
    const sessionId = `ia-review-pr-${this.pr.number}-${Date.now().toString(36)}`;

    const args = ["--session-dir", sessionRoot, "--session-id", sessionId, "--name", `review-pr-${this.pr.number}`];
    args.push(this.config.approve ? "-a" : "-na");
    if (!this.model) {
      throw new Error("no reviewer model configured — set reviewModel (or model) in .issue_attack/config.json, or pass --model");
    }
    args.push("--model", this.model);
    args.push("--append-system-prompt", contractPath);

    this.client = new PiClient({
      bin: this.config.piBin,
      args,
      cwd: worktree,
      env: { PI_SKIP_VERSION_CHECK: "1" },
      onRecord: (rec) => this.handleRecord(rec),
    });
    await this.client.start();
    // Apply the configured model explicitly — failures surface as review
    // errors instead of silently reviewing on some other model.
    await this.applyModelSpec(this.model);
  }

  async applyModelSpec(spec) {
    const { modelPart, level } = parseModelSpec(spec);
    const models = await this.client.availableModels();
    const resolved = resolveModelSpec(modelPart, models);
    if (!resolved) throw new Error(`no configured model matches "${modelPart}"`);
    await this.client.setModel(resolved.provider, resolved.id);
    if (level) await this.client.setThinkingLevel(level);
  }

  async sendTask() {
    if (this.issue) {
      this.issueRecord = await gh.viewIssue(this.root, this.repo, this.issue).catch(() => null);
    }
    const prompt = reviewPrompt({ pr: this.pr, issue: this.issue, issueRecord: this.issueRecord, base: this.base });
    await this.client.message(prompt);
    this.line(`review dispatched to ${c.cyan("pi session")} (${prompt.length} chars)`);
  }

  handleRecord(rec) {
    try {
      appendFileSync(this.logPath, JSON.stringify(rec) + "\n");
    } catch {
      /* logging must never break the review */
    }
    if (rec.type === "message_update" && rec.assistantMessageEvent?.type === "text_delta") {
      if (this.streamText) process.stdout.write(rec.assistantMessageEvent.delta);
      return;
    }
    if (rec.type === "agent_end") {
      const err = finalErrorFromAgentEnd(rec);
      if (err && !this.modelFailed) {
        this.modelFailed = err;
        this.line(c.red(`model call failed: ${err}`));
      }
      return;
    }
    if (rec.type === "tool_execution_start") {
      this.line(`${c.dim("→")} ${rec.toolName} ${c.dim(toolSummary(rec))}`);
      if (rec.toolName === "bash" || rec.toolName === "powershell") {
        const v = checkCommand(rec.args?.command ?? "", { baseBranch: this.base, branch: this.pr.headRefName });
        if (!v.ok) {
          this.line(`${c.red(`policy violation (${v.rule}):`)} ${v.reason} — aborting review`);
          this.aborted = true;
          this.client.abort().catch(noop);
        }
      }
    }
  }

  async monitor() {
    while (true) {
      await sleep(2_000);
      if (this.modelFailed) {
        return { action: "error", summary: `model unreachable: ${this.modelFailed}` };
      }
      if (this.aborted) return { action: "error", summary: "policy violation during review" };
      if (this.client.exitInfo) {
        return { action: "error", summary: `pi exited (code=${this.client.exitInfo.code})` };
      }
      if (this.client.settledCount > 0) {
        const st = await this.client.getState().catch(() => null);
        if (!st || (!st.isStreaming && (st.pendingMessageCount ?? 0) === 0)) {
          const text = await this.client.lastAssistantText().catch(() => null);
          return parseReviewVerdict(text);
        }
      }
    }
  }
}

/** PR reference with the issue number, when known: "PR #54 (issue #42)". */
export function prRef(pr, issue) {
  return `PR #${pr.number}${issue != null ? ` (issue #${issue})` : ""}`;
}

/** Execute a verdict supervisor-side: the only place reviews merge or speak. */
async function executeVerdict(root, repo, config, entry, verdict, out) {
  const { pr, issue } = entry;
  const sha = pr.headRefOid;

  if (verdict.action === "request_changes") {
    await gh.createComment(root, repo, pr.number, reviewComment({ sha, action: verdict.action, summary: verdict.summary, issue }));
    out(c.yellow(`\nchanges requested on ${prRef(pr, issue)} — feedback posted${issue ? ` (resume with: issue_attack resume ${issue})` : ""}`));
    return;
  }
  if (verdict.action === "error") {
    out(c.red(`\nreview of ${prRef(pr, issue)} failed: ${verdict.summary ?? "unknown error"}`));
    return;
  }
  if (verdict.action !== "approve") {
    const tail = String(verdict.summary ?? "").replace(/\s+/g, " ").slice(-200);
    out(c.red(`\nreviewer returned no verdict for ${prRef(pr, issue)} — will retry on the next pass`));
    if (tail) out(c.dim(`  final message tail: …${tail}`));
    return;
  }

  // APPROVE — re-check before merging: still open, still the reviewed head, mergeable.
  const now = await gh.viewPr(root, repo, pr.number).catch(() => null);
  if (!now || now.state !== "OPEN") {
    out(c.yellow(`\n${prRef(pr, issue)} closed before the merge — nothing to do`));
    return;
  }
  if (now.headRefOid !== sha) {
    out(c.yellow(`\n${prRef(pr, issue)} head moved since the review — skipping merge, re-reviewing next pass`));
    return;
  }
  if (now.mergeable === false) {
    await gh.createComment(root, repo, pr.number, reviewComment({ sha, action: "approve", summary: verdict.summary, issue }));
    out(c.yellow(`\n${prRef(pr, issue)} has merge conflicts — approved but not merged; resume the agent to resolve`));
    return;
  }
  await gh.createComment(root, repo, pr.number, reviewComment({ sha, action: "approve", summary: verdict.summary, issue }));
  await gh.mergePr(root, repo, pr.number);
  out(c.green(`\n✔ ${prRef(pr, issue)} approved and merged`));
}

/** `ia review`: one pass over pending PRs, or a watch loop waiting for more. */
export async function reviewLoop({ root, repoInfo, config, watch, pollSeconds, model, dryRun, out }) {
  const repo = repoInfo.nameWithOwner;
  let stopping = false;
  const onSigint = () => {
    if (stopping) process.exit(130);
    stopping = true;
    out(c.yellow("\nstopping review (Ctrl-C again to force)…"));
  };
  process.on("SIGINT", onSigint);

  try {
    do {
      const pending = await pendingReviews(root, repo, config).catch((e) => {
        out(c.yellow(`warn: PR scan failed: ${e.message}`));
        return [];
      });
      if (!pending.length) {
        out(watch ? c.dim("no PRs to review — waiting…") : "No open agent PRs to review.");
      }
      const cooldown = new Map(); // prNumber -> last no-verdict/error time
      const COOLDOWN_MS = 10 * 60_000; // don't re-burn a full review run every poll
      for (const entry of pending) {
        if (stopping) break;
        const last = cooldown.get(entry.pr.number) ?? 0;
        if (Date.now() - last < COOLDOWN_MS) {
          out(c.dim(`PR #${entry.pr.number}: backing off — no verdict ${Math.round((Date.now() - last) / 60_000)}m ago`));
          continue;
        }
        const { pr, issue } = entry;
        out(c.bold(`\n── reviewing ${prRef(pr, issue)}: ${pr.title} ──`));
        if (dryRun) {
          out(`  head ${String(pr.headRefOid).slice(0, 8)}${issue ? `, issue #${issue}` : ""} — would spawn reviewer (${model ?? "pi default"}), then act on the verdict`);
          continue;
        }
        const runner = new ReviewRunner({ root, repoInfo, config, pr, issue, model, onLine: out, streamText: true });
        const verdict = await runner.run().catch((e) => ({ action: "error", summary: e.message }));
        if (verdict.action === "none" || verdict.action === "error") cooldown.set(pr.number, Date.now());
        await executeVerdict(root, repo, config, entry, verdict, out).catch((e) =>
          out(c.red(`executing verdict on ${prRef(pr, issue)} failed: ${e.message}`))
        );
      }
      if (watch && !stopping) await sleep((pollSeconds ?? 60) * 1000);
    } while (watch && !stopping);
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}
