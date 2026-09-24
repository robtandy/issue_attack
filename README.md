# issue_attack

Autonomous CLI agents that pick up GitHub issues, work them independently in
isolated git worktrees, and open pull requests — powered by
[pi](https://pi.dev) as the agent harness.

```
$ issue_attack attack --max 3 --watch
attacking robtandy/issue_attack — label: agent-ready max: 3 (watch mode)
[#12] picked up: Migrate config loader to ESM
[#12] attempt 1 on branch agent/issue-12
[#12] claimed issue 12 as robtandy
[#12] pi session ia-issue-12 (pid 4242)
[#12] → bash gh issue view 12 --comments
[#12] → bash rg "require\\(" lib/
[#12] → edit lib/config.js
[#12] ✔ PR opened: https://github.com/robtandy/issue_attack/pull/13
```

Each agent:

- **runs in its own git worktree** on branch `agent/issue-<n>` — agents never
  share a checkout, never touch your working tree, and never push to the base branch
- **works unattended** — no prompts, no questions, no human in the loop
- **comments on the issue when blocked** (structured `BLOCKED.md` protocol) and
  can be **resumed later** with your answers
- **opens a PR** (`Closes #<n>`) when finished, with summary, verification notes,
  and an `agent` label
- lives under **hard budgets** (time, model cost, tokens) with a graceful
  "wrap up" steer before any hard abort
- can be **steered live** (`issue_attack steer 12 "use an env var, not the DB"`)
  and **stopped** (`issue_attack stop 12`)

## How it works, in one paragraph

`issue_attack` is a supervisor. It claims issues (assignee + label mutex),
creates a worktree per issue, and spawns a `pi --mode rpc` worker inside it with
a strict *worker contract* appended to its system prompt: understand the issue,
implement the smallest correct change, verify, push, open a PR — or write
`BLOCKED.md` and stop. The supervisor watches the worker's event stream,
enforces budgets, trips on dangerous commands, posts heartbeat/progress
comments to the issue, and classifies the outcome (`succeeded` / `blocked` /
`timeout` / `failed`) — each with the right labels and comments so humans
always know what happened and what to do next.

Full design, failure modes, and rationale: [DESIGN.md](DESIGN.md).

## Requirements

- Node.js >= 22
- `pi` on PATH, authenticated (`pi` → `/login`) — [install pi](https://pi.dev)
- `gh` on PATH, authenticated (`gh auth login`) with push access to the repo
- A git repository with a GitHub remote

## Install

```bash
npm install -g robtandy/issue_attack
```

Or from a checkout:

```bash
git clone https://github.com/robtandy/issue_attack
cd issue_attack && npm link
```

## Quickstart

```bash
cd your-repo
issue_attack init                  # config, labels, gitignore (safe to re-run)
issue_attack doctor                # verify pi/gh/git/labels are all ready

# Mark an issue as attackable and let an agent work it:
gh issue edit 12 --add-label agent-ready
issue_attack run 12                # foreground, streams the agent
#   ... or the fleet version:
issue_attack attack --max 3        # up to 3 issues concurrently
issue_attack attack --max 3 --watch # keep polling for newly labeled issues
```

When an agent finishes you get a PR (`Closes #12`). When it's blocked you get
a comment listing exactly what it needs — answer in the issue, then:

```bash
issue_attack resume 12             # agent picks up where it left off
```

## Commands

| Command | What it does |
|---|---|
| `init` | Create `.issue_attack/config.json`, repo labels, gitignore entries |
| `doctor` | Check node, pi, gh auth, repo, labels, config, models |
| `list [--label L]` | Show claimable issues (default label `agent-ready`) |
| `run <issue#> [--model m] [--fresh]` | Work one issue in the foreground |
| `attack [--max N] [--watch] [--label L] [--poll secs]` | Fleet: N agents concurrently, optionally polling for more |
| `resume <issue#>` | Continue a blocked/failed/timed-out run with fresh issue comments |
| `status [--json]` | Local fleet status (runs, outcomes, cost) |
| `steer <issue#> <message>` | Live guidance to a running agent |
| `stop <issue#> [--wait]` | Stop an agent, release the claim |
| `log <issue#> [--raw] [--lines n]` | Inspect a run's event log |
| `cleanup [--issue n] [--purge]` | Remove worktrees of finished runs; `--purge` also drops sessions, logs, branches, state |

Exit codes: `0` for `succeeded`/`blocked`/`stopped`, `1` for `failed`/`timeout`/`skipped` — scriptable.

## Configuration

`.issue_attack/config.json` (created by `init`, per repository):

```jsonc
{
  "label": "agent-ready",        // issues with this label are claimable
  "claimedLabel": "agent-claimed",
  "blockedLabel": "agent-blocked",
  "doneLabel": "agent-done",
  "prLabel": "agent",            // label applied to agent-opened PRs

  "maxConcurrent": 3,            // fleet size
  "maxAttempts": 2,              // supervised attempts per run (auto-retry)
  "pollSeconds": 60,             // --watch polling interval

  "timeBudgetMinutes": 45,       // wall-clock budget per run
  "softBudgetRatio": 0.8,         // steer "wrap up" at 80% of budget
  "costBudgetUsd": 5.0,          // model cost budget per run (null = off)
  "maxTokens": null,              // token budget (null = off)

  "heartbeatMinutes": 10,        // progress comment interval (0 = off)
  "recentComments": 5,           // comments inlined into the task prompt

  "model": null,                  // pi model for workers, e.g. "sonnet:high"
  "baseBranch": null,             // default: repo default branch
  "prDraft": false,
  "approve": true,                // workers pass -a (trust project config in worktree)
  "noExtensions": false,
  "extraFlags": []                // extra flags for pi
}
```

Everything lives under `.issue_attack/` (gitignored): `worktrees/`,
`sessions/` (resumable pi sessions), `logs/` (full RPC event streams),
`inbox/` + `stop/` (the control channel), `state.json` (fleet registry).

## The blocked loop

1. Agent hits something it genuinely can't resolve → writes `BLOCKED.md`
   (what it tried, exactly what it needs) → stops.
2. Supervisor comments it on the issue, labels it `agent-blocked`, releases
   the claim, **keeps the worktree + session**.
3. You answer in the issue.
4. `issue_attack resume <n>` re-claims, feeds your answers + prior context to
   the same agent, and it continues where it stopped.

Agents are instructed to prefer a defensible assumption + a note in the PR
over blocking; `BLOCKED.md` is for genuinely unanswerable situations.

## Safety model

- Workers are confined to their branch and worktree (enforced by the worker
  contract, a reactive command tripwire with steer-then-abort escalation, and
  the supervisor's own verification of every outcome).
- They never push to the base branch, force-push, merge/close PRs, edit
  issues/labels/settings, or touch secrets — see the policy denylist in
  [`lib/policy.js`](lib/policy.js).
- All credentials they hold are the ones you gave `gh` and `pi` — scope them
  accordingly (a dedicated account or fine-grained PAT is a good idea).
- Every run leaves a complete audit trail: local event log + pi session +
  the issue thread itself.

This is a tripwire, not a sandbox; read [the safety section of
DESIGN.md](DESIGN.md#safety--trust-model) before pointing it at anything
important.

## Development

```bash
node bin/issue_attack.js help
node bin/issue_attack.js doctor
```

No build step, zero runtime dependencies. `bin/` + `lib/` are plain ESM
Node 22+.

## License

MIT
