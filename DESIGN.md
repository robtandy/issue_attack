# issue_attack — system design

A supervisor that runs autonomous coding agents (pi harness) against GitHub
issues: one agent per issue, each in an isolated git worktree, unattended,
commenting on the issue when blocked, opening a PR when done.

This document is the rationale and contract for the implementation in `lib/`.

---

## 1. Goals and non-goals

**Goals**

1. An operator can point the tool at a repo's issue queue and walk away.
2. Agents never interfere with each other, the operator's checkout, or the
   default branch.
3. Every terminal state of a run is *legible*: a human looking at the issue
   (or `status`) always knows what happened and what to do next.
4. Humans can redirect or stop agents without killing processes by hand.
5. Spend is bounded: every run has time, cost, and token budgets, enforced
   with a graceful degradation ladder before hard abort.
6. Blocked runs are resumable with full context — exploration shouldn't be
   thrown away when the agent needs one answer from a human.

**Non-goals (for v0)**

- A hard security sandbox (we are a tripwire, not a jail — see §9).
- Multi-host coordination beyond the claim protocol (§5).
- Automatic resume from issue comments (deliberate: resuming spends money, so
  a human triggers it — see §12 roadmap).
- Reviewing/merging PRs — humans stay in the loop at the merge step.

---

## 2. Architecture

```
                       ┌──────────────────────────────────────────────┐
                       │        issue_attack supervisor (Node)        │
                       │  cli.js ─ runner.js ─ fleet loop (attack)     │
                       └───────┬──────────────┬───────────────┬──────┘
                               │              │               │
                claim / label / comment     spawn + RPC     budgets, policy,
                (gh API)                    (stdin/stdout)  heartbeat, stop
                               │              │               │
        ┌──────────────────────▼──────────────▼───────────────▼─────┐
        │                     per-issue AgentRunner                 │
        │  claim → worktree → pi worker → monitor → classify → label  │
        └───┬─────────────────────────────────────────────────┬─────┘
            │                                                 │
   .issue_attack/worktrees/issue-12        .issue_attack/{logs,sessions,inbox,stop}
   git worktree, branch agent/issue-12      control channel + audit trail
            │
   ┌────────▼──────────────────────────┐
   │  pi --mode rpc (worker)            │
   │  system prompt + worker contract   │
   │  tools: read/bash/edit/write       │
   │  uses gh itself: view issue,       │
   │  push branch, gh pr create,       │
   │  writes BLOCKED.md when stuck     │
   └───────────────────────────────────┘
```

Three control planes, deliberately separate:

| Plane | Mechanism | Owner |
|---|---|---|
| **Agent control** | pi RPC protocol (JSONL on stdin/stdout): `prompt`, `steer`, `abort`, `get_state`, `get_session_stats` | the AgentRunner process |
| **Operator control** | files in `.issue_attack/` (`inbox/*.jsonl` steering, `stop/*` markers) that the runner's monitor loop consumes | any `issue_attack` process, including another terminal |
| **Human communication** | the GitHub issue itself: assignee + labels (claim), comments (heartbeats, blocked questions, outcomes) | supervisor, on behalf of agents |

The file-based operator channel is what makes `steer`/`stop` work even when the
fleet runs in another process: they are just files, safe to write from any
process, consumed idempotently by the runner.

Why RPC mode (not `--print`/`--mode json`)? JSON mode is one-shot: no steering,
no abort, no mid-run stats. RPC keeps the worker controllable for its whole
lifetime, which is the difference between a batch job and a fleet you can
actually operate.

Why subprocess (not the SDK)? The supervisor should be a small, dependency-free
Node program that can supervise any pi on PATH; the RPC wire format is a
documented, stable contract. One worker process per issue also gives free
resource isolation (kill = `SIGTERM` the pid) and clean crash semantics.

---

## 3. Issue lifecycle

```
                    label: agent-ready, no assignee, no agent-claimed
                                      │
                                      ▼
                        ┌────────── claim ──────────┐
                        │ assign @me + agent-claimed│        (skip path:
                        │ verify sole assignee      │──────▶ skipped)
                        └────────────┬──────────────┘
                                     ▼
                                  RUNNING ──────────────┐
                          worktree, pi session,        │
                          task prompt                   │ steer / stop /
                                       │                │ budget abort
                     agent_settled + idle               ▼
                                       │            STOPPED ──▶ released
              ┌────────────────────────┼───────────────┐
              ▼                        ▼               ▼
        PR on branch?            BLOCKED.md?      neither
              │                        │               │
              ▼                        ▼               ▼
         SUCCEEDED                 BLOCKED     ┌─ attempts left? ─┐
        done label, PR              │          │  yes: continue-   │
        labeled, claim              │          │  prompt, retry    │
        released                    │          │  no: FAILED       │
                                     ▼          └───────────────────┘
                        blocked label, BLOCKED.md
                        posted as comment, claim
                        released, session+worktree KEPT
                                     │
                        maintainer answers in issue
                                     │
                        issue_attack resume N ──▶ claim ─▶ RUNNING
```

State machine invariants:

- A GitHub-side claim (assignee + `agent-claimed` label) exists **iff** a run is
  live; every terminal path releases it.
- `BLOCKED.md` in the worktree is the *only* blocked signal; PR-on-branch is
  the *only* success signal. Both are checked from the outside (git/GitHub),
  not trusted from the agent's self-report. The agent's final message is
  reported but never authoritative.
- Terminal runs keep worktree + session until a human decides
  (`cleanup`/`resume`); success keeps the branch because the PR references it.

## 4. The worker contract

The heart of the system is the prompt in `lib/prompt.js`: a contract appended
to pi's system prompt. It encodes:

- **Unattended-ness**: "no human is watching; your channels are commits, the
  PR, one optional comment, and BLOCKED.md". This kills the failure mode of
  agents ending with a question instead of work.
- **Workflow**: read issue + comments → explore → smallest correct change →
  verify (tests/lint) → push branch → PR with `Closes #N`, summary, how
  verified, assumptions.
- **Blocked protocol**: write `BLOCKED.md` (what I tried / what I need) and
  stop. Explicit anti-pattern: "hard" is not blocked; a defensible assumption
  recorded in the PR beats blocking.
- **Hard rules**: push only own branch, never force-push, never merge/close,
  never edit the issue/labels/settings/secrets, no sudo, at most one comment.
- **Budget compliance**: when told to wrap up, do it immediately.
- **Final message format**: a short machine-parsed report (PR url or `BLOCKED`
  plus a summary) — never questions.

Design note: the agent does its own `gh issue view`, pushes and opens its own
PR (it has bash and the user's gh). The supervisor *verifies* outcomes from
git/GitHub state afterwards. This keeps the supervisor simple, avoids
token-count double accounting, and means the agent's real capability surface
matches its instructions.

### Why BLOCKED.md instead of "comment directly"?

Determinism. A file with a fixed structure is checkable from outside
(`existsSync`), has a stable shape for humans, and survives process crashes.
If the worker crashed before commenting, the supervisor still finds the file
and posts it. Comments are the *communication* medium; the file is the
*protocol*.

## 5. Claim protocol and concurrency

Within one host, `state.json` + the fleet loop prevent double-pickup. Across
hosts (or against humans), the issue itself is the mutex:

1. Read the issue. Skip if: not open, has assignees other than me, has
   `agent-claimed` (unless it's our own claim being re-owned, e.g. a resume
   after crash).
2. Claim: `gh issue edit --add-assignee @me --add-label agent-claimed`.
3. **Verify** (optimistic concurrency): re-fetch; if any assignee other than
   me appeared, we lost a race → remove our claim and skip.

The residual race (two runners assign between fetches) resolves in
verification: both see two assignees; both back off; next poll retries.
Livelock is possible in theory, irrelevant in practice for a personal fleet.
Humans preempt trivially: assigning yourself to an issue makes it
unclaimable and un-resumable — the runner refuses to steal an assigned issue.

## 6. Budgets and degradation ladder

Budgets (`timeBudgetMinutes`, `costBudgetUsd`, `maxTokens`) are enforced by the
runner, not the worker, from `get_session_stats` (polled every ~10s):

1. **Green** — normal run.
2. **Soft threshold** (80% by default) — steer: "wrap up NOW, PR or
   BLOCKED.md". The agent is given the chance to land its work gracefully.
3. **Hard threshold** — `abort()`, wait briefly for settle, outcome `timeout`
   with a comment explaining the budget, worktree+session kept for `resume`.

A run also self-retries once (`maxAttempts`): if the agent settles with no PR
and no BLOCKED.md, the runner sends a "continue: open a PR or write
BLOCKED.md, don't redo finished work" prompt rather than declaring failure —
cheap way to recover from agents that just… stop talking.

Costs are best-effort (provider-reported usage; some gateways report zero).
Time is the always-accurate backstop.

## 7. Operator interaction

- `steer N "…"` → appends to `inbox/issue-N.jsonl` → runner forwards via RPC
  `steer` (mid-run) or `prompt` (idle). Arrives between the current tool call
  and the next model turn — exactly when an agent can absorb new information.
- **Commenting on the issue also steers the live agent**: each runner polls its
  issue's comments every `commentSteerSeconds` and forwards new comments (from
  anyone except the supervisor's own gh account, and posted after the run
  started) as `[ISSUE COMMENT]` steering messages. The issue thread becomes a
  two-way channel: the agent's blocked questions and heartbeats flow out,
  maintainer answers flow in — no terminal required, works from a phone via the
  dashboard links.
- `stop N` → stop marker → runner aborts, classifies `stopped`, releases the
  claim. Double Ctrl-C in the fleet does the same for all agents.
- `status` reconciles the world (see §8) and prints the table; `--json` for
  scripting.
- Progress is also mirrored on the issue itself: a single editable status
  comment (found by a hidden HTML marker, updated every `heartbeatMinutes`)
  with elapsed, tokens, cost, current action. Deleted when the run ends, so
  the thread keeps only its final outcome comment — heartbeat noise never
  accumulates.

### 7a. Status page (GitHub Pages dashboard)

`page init` publishes a dashboard and keeps it current:

```
supervisor ──publishStatus (throttled, serialized)──▶ git plumbing ──force push──▶ gh-pages
   │  buildPayload: state.json + cached issue titles                        │
   │  git hash-object ×2 → git mktree → git commit-tree (orphan root)      ▼
   │                                                     GitHub Pages serves
   └─ runner hooks: on claim, every tick (≤ statusPublishMinutes),             │
      on terminal state (forced); fleet loop publishes each poll cycle  ◀── page polls
                                                                            status.json every 10s
```

Design decisions:

- **Actions-based deploys, not branch builds**: GitHub Pages "deploy from a
  branch" is rate-limited to ~10 builds/hour — useless for a live dashboard.
  `page init` converts the site to `build_type: workflow`, and the deploy
  workflow ships *inside every status publish* (push-triggered workflows are
  read from the pushed ref, so the status branch is fully self-contained —
  nothing is ever committed to the default branch). Every push triggers an
  Actions deploy (exempt from the Pages build limit) with `concurrency:
  cancel-in-progress`, so the freshest state wins. End-to-end freshness ≈
  `statusPublishMinutes` + ~30s of Actions runtime.
- **Cadence philosophy**: publishes are minute-scale — the dashboard exists to
  catch stalls, not to stream. A stall is visible from the per-agent
  `lastAgentUpdateAt` delta regardless of publish frequency, and the header's
  "data updated" clock stays honest either way.
- **git plumbing, not a worktree**: every publish builds `index.html` +
  `status.json` into a fresh orphan-root commit and force-pushes the status
  branch. No checkout is touched, no history grows, and concurrent publishes
  are serialized through a promise queue — a terminal-state publish is queued
  behind an in-flight one, never dropped.
- **`generatedAt` staleness is a feature**: the header pill shows how long ago
  the data was refreshed. If the supervisor dies or the laptop sleeps, the
  page turns stale — that is the honest, observable signal, exactly the
  inverse of heartbeat systems that keep looking alive from cache.
- **Per-agent `lastAgentUpdateAt`** is persisted from real RPC events (tool
  starts, assistant turns), so "agent active 4m ago" distinguishes a working
  agent from a stalled one at a glance.
- **Title caching**: runners cache issue title/url into `state.json` at claim
  time, so routine publishes need zero GitHub API calls; a bounded self-healing
  enrichment fills gaps for pre-existing entries.
- **Existing Pages sites are respected**: if the repo already serves Pages
  from another branch, `page init` refuses to hijack it without `--force`.
- **Single host per repo** for now: concurrent hosts would force-push over
  each other's branch (last writer wins). Multi-host status merge is roadmap.

### 7b. GitHub account pinning

`gh` operates as whichever account is *active* — a trap when you juggle an
enterprise and a personal login (enterprise tokens often cannot touch your
personal repos, and the failure surfaces as cryptic "not allowed" errors).
Repos pin their account in local config (`ghAccount`, set by `init` or
`issue_attack account <login>`). At startup the supervisor resolves that
account's token (`gh auth token --user <login>`) and exports `GH_TOKEN` for
its whole process tree — every gh call, including the ones worker agents make
from their worktrees, runs as the pinned account no matter what `gh` has
active. Failing to resolve the pin fails fast with a fix hint; `doctor`
reports pin vs. effective login.

## 8. Failure modes

| Failure | Detection | Handling | Issue-side effect |
|---|---|---|---|
| Worker hangs (model stall, tool hang) | time budget | soft steer → hard abort | timeout comment, resume possible |
| Provider outage mid-run | pi auto-retry events, then run settles/aborts | runner auto-retry prompt once, else failed | failed comment with last message |
| Worker policy violation | `tool_execution_start` tripwire | 1st: steer a warning; 2nd: abort | failed comment citing the rule |
| Supervisor crash (fleet dies) | `state.json` `running` entry with dead pid — reconciled by next `status`/`attack`/`resume` | orphan pi killed, entry marked failed with note; `attack` re-picks crash-orphans automatically | claim released lazily on next interaction with the issue |
| Machine reboot | same as above | same | same |
| Worker crashes before PR/BLOCKED | classify finds neither | auto-retry, then failed | comment includes last assistant text |
| gh/GitHub down | gh calls throw | run continues locally where possible; finalize retries warn, never throws | comment may be missing; local state still authoritative |
| Two hosts race a claim | claim verify step | loser un-claims and skips | none |
| Human takes over an issue | assignee check | runner refuses to claim/resume | none |

Deliberate rule: the fleet re-attacks only *crash orphans* (dead-supervisor
runs), never agent-declared failures — retry spend is a human decision.

## 9. Safety and trust model

Layers, outside-in:

1. **Contract** (system prompt): the rules the model should follow.
2. **Tripwire** (`lib/policy.js`): every `bash`/`powershell` tool call the
   worker makes is checked against a denylist — force-push, push to base,
   branch deletion, checkout of base, `gh pr merge/close`, `gh issue
   close/edit`, repo/label/secret/workflow/release mutations, write-method
   `gh api`, gists, sudo, recursive rm of home/absolute paths. First
   violation steers a correction; second aborts the run. Reactive, not
   preventative — the command may run before the steer lands.
3. **Verification**: outcomes are classified from external state (PR on
   branch / BLOCKED.md / neither), never from the agent's claims.
4. **Blast-radius limits**: worktree + non-base branch means the worst
   plausible git outcome is a junk branch; GitHub-side mutations are
   denylisted; PRs are the only write path to the default branch, and merging
   stays human.
5. **Credentials**: workers inherit your `gh` and provider credentials.
   Scope them: a fine-grained PAT (repo: read/write, no admin) and a
   low-limit API key for the model. The budget system caps spend per run.

Honest statement: this is **not** a sandbox. A capable model instructed to do
so could evade a reactive regex tripwire (e.g. writing a script to disk and
executing it). The design assumes a threat model of *accidents and
misunderstandings*, not adversarial prompts. The roadmap (§12) hardens this
with an in-process pi extension that can veto tool calls pre-execution.

## 10. Observability

- **Per-run event log** (`.issue_attack/logs/issue-N.jsonl`): the complete RPC
  record stream — every tool call, result, usage, retry — replayable with
  `issue_attack log --raw`.
- **pi sessions** (`.issue_attack/sessions/issue-N/`): durable transcripts;
  `resume` continues the exact session, so nothing is re-explored.
- **`state.json`**: the fleet registry — attempts, branch, PR url, cost,
  tokens, timestamps, pids.
- **The issue thread**: heartbeat + outcome comments; labels as state flags.
- All machine-written comments carry a hidden marker so they can be found
  and edited/deleted by the supervisor without touching human comments.

## 11. Data layout

```
.issue_attack/                 (gitignored)
├── config.json                per-repo configuration
├── state.json                 fleet registry (one entry per issue)
├── worktrees/issue-N/         one git worktree per attacked issue
├── sessions/issue-N/          pi session storage (--session-dir)
├── logs/issue-N.jsonl         full RPC event stream per issue
├── inbox/issue-N.jsonl        steering messages (append-only, consumed)
└── stop/issue-N               stop markers (existence = intent)
```

## 12. Roadmap

- **Hard policy gate**: a pi extension loaded via `-e` that intercepts tool
  calls in-process and can veto before execution; the tripwire becomes a
  wall.
- **Comment-driven auto-resume**: watch blocked issues for maintainer answers
  and resume automatically (today: deliberate, manual).
- **Multi-host fleets**: lease file in the repo or a GitHub-based lease
  (an issue comment with host id + heartbeat) so N machines share the queue
  without the claim race back-off; status publishes would merge per-host
  files instead of force-pushing a single branch.
- **Review round**: after PR feedback (`/request-changes`), feed review
  comments into the same session and let the agent iterate.
- **Cost dashboards**: aggregate session stats per repo/label/model.
- **Templates per label**: e.g. `docs` issues get a lighter contract and a
  cheaper model — model selection per label already works via config,
  prompts don't yet.
- **`gh` extension packaging**: `gh issue-attack` subcommand via gh's
  extension mechanism.

## 13. Field notes from the first live run

The first live end-to-end run (this repo, issue #1, a cheap model) surfaced two
real bugs within minutes — both now fixed and covered by the agent's own tests:

- **Long argv is fragile.** Workers' system-prompt contract was passed as an
  inline `--append-system-prompt` argument; on this managed laptop, an
  endpoint agent SIGKILLed any `pi` process whose argv exceeded ~1KB. The fix:
  write the contract to a file in the session dir and pass its path (the
  documented form). Long *content* belongs in files or stdin, never argv.
- **Policy must check command position, not raw text.** `gh pr create --body`
  quoting test cases like `git push --force` (as *data*) tripped the denylist
  and aborted a healthy run. The fix: split commands into shell statements,
  cut at the first string literal, and gate on capable command prefixes before
  applying rules.

Both are the tripwire behaving exactly as designed — fail-safe — but each
  false positive burns a run's budget, so precision matters.

## 14. Alternatives considered

- **In-process SDK instead of subprocess**: rejected — coupling supervisor
  lifetime to worker lifetime; the RPC contract is stable and gives us
  process isolation for free.
- **Agent self-reports outcome via structured output**: rejected — trusting
  the model's self-assessment; external verification (PR exists, BLOCKED.md
  exists) cannot be hallucinated.
- **Supervisor does all GitHub I/O** (agent never touches gh): rejected —
  doubles token accounting, and the agent genuinely needs live issue context
  (comments can arrive mid-run). Middle ground: supervisor owns all
  *state-changing* issue operations (labels/assignee/comments), the agent may
  only read issues, push its branch, and create its PR.
- **One queue process daemon**: rejected — `attack --watch` covers it without
  a service to install; every command is crash-reconcilable from state files.
