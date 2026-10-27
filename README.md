# issue-attack

Autonomous AI agents that claim GitHub issues, implement fixes in isolated git worktrees, and open pull requests.

## What it does

```
issue-attack attack --max 3 --watch       # agents work issues concurrently
issue-attack review --watch               # AI reviewers verdict PRs (another terminal)
```

Each issue gets its own agent running in an isolated git worktree on branch `agent/issue-<n>`. The agent reads the issue, implements a fix, runs tests, commits, pushes, and opens a PR. A separate reviewer agent (optionally a different model) verifies the PR — runs the project's tests, inspects the diff — and either merges it or posts specific feedback, which loops back to the working agent. The cycle repeats until merge.

```
issue → agent works in worktree → PR → reviewer verdicts →
  APPROVE → merge → done
  CHANGES REQUESTED → feedback → agent resumes → new push → re-review → ...
```

## Isolation model

| What | Per-issue? |
|---|---|
| Git worktree | `.issue_attack/worktrees/issue-<n>` — isolated checkout, discarded on merge |
| Branch | `agent/issue-<n>` — never pushes to base, never force-pushes |
| pi session | own session id, own process, own model |
| Supervisor | own process, monitors the agent, enforces safety |

Agents cannot push to the base branch, force-push, merge/close PRs, edit the issue, touch repo settings/secrets, or use sudo. A command-safety filter intercepts every bash call and aborts the run on violations. All activity is attributed (`[agent]` prefix, `Co-authored-by` trailer).

## Feedback channels

- **Issue comments** — steered to a running agent within ~30s (👀 marks delivery)
- **`steer <n> <msg>`** — same, from the CLI
- **`checkin <n>`** — ask a running agent how it's going; reply prints in your terminal (no GitHub comment)
- **PR review feedback** — reviewer comments on the PR are picked up by `resume` and the fleet's PR-watch loop, automatically re-engaging the agent
- **`BLOCKED.md`** — when an agent needs human input, it writes what it needs; answer in the issue, then `resume`

## Dependencies

Issues that depend on other issues can be gated with `depends-N` labels:

```bash
gh issue edit 7 --add-label depends-3       # issue 7 waits for issue 3
gh issue edit 8 --add-label depends-3,depends-5  # waits for both
```

The fleet won't claim a dependent issue until all its dependencies are closed.
When a dependency closes (merged PR closes the issue), dependent issues become
claimable on the next poll cycle — no manual unblocking.

`ia list` shows gated issues in a separate "waiting on dependencies" table.

## Multi-machine

State (worktrees, sessions, logs) is per-machine. Coordination is via GitHub: issues are claimed with labels + assignees, PRs are shared. Run `ia attack` on as many machines as you want — each picks up different issues. `ia checkin --host user@box` crosses machines via SSH.

## Requirements

- `pi` on PATH, authenticated — [install pi](https://pi.dev)
- `gh` on PATH, authenticated with push access — [install gh](https://cli.github.com)
- `fzf` on PATH — `brew install fzf` / `apt install fzf` (model picker)
- Node.js >= 22 (npm channel only; binary install doesn't need Node)

## Install

```bash
npm install -g issue-attack       # npm
curl -fsSL https://raw.githubusercontent.com/robtandy/issue_attack/main/scripts/install.sh | sh
                                  # binary (no Node needed), macOS + Linux
```

One-off: `npx issue-attack@latest doctor`

## Onboarding a repository

```bash
cd your-repo
issue-attack init
```

`init` verifies prerequisites, creates `.issue_attack/config.json`, adds GitHub labels, updates `.gitignore`, and prompts for a model via a typeahead picker (fzf). The model is verified with a live call before saving — broken credentials fail immediately, not mid-run.

```bash
gh issue edit 12 --add-label issue-attack-ready     # mark work
issue-attack attack --max 3 --watch                  # run the fleet
issue-attack review --watch                          # review PRs (another terminal)
```

## Commands

| Command | Purpose |
|---|---|
| `init` | Set up repo (one-time) |
| `doctor` | Verify everything works |
| `run <n>[,...]` | Work issues sequentially — each waits for PR merge or feedback |
| `attack [--max N] [--watch]` | Fleet: concurrent agents, polls for new issues, watches PRs for feedback |
| `review [--watch]` | AI reviewer verdicts PRs: feedback or approve+merge |
| `resume <n>` | Continue a blocked/stopped/feedback-received agent |
| `checkin <n>` | Ask a running agent how it's going (local, replies print in terminal) |
| `steer <n> <msg>` | Send guidance to a running agent |
| `stop <n>` | Stop a running agent |
| `status` / `log <n>` | Fleet overview / detailed run log |
| `cleanup [--purge]` | Reclaim worktree disk space |
| `page init` | Live dashboard on GitHub Pages |

Shorthand: `ia` works everywhere (`ia attack --max 3 --watch`).

## Configuration

`.issue_attack/config.json` (created by `init`). Key settings:

- `model` — **required**. Agents run on this model; verified with a live call before every run (`--no-verify` to skip). Thinking level as a `:suffix` (`"sonnet:high"`).
- `reviewModel` — reviewer model (defaults to `model`). Use a stronger model for review than for work.
- `maxConcurrent` — fleet size (default: 3)
- `label` — which issues are claimable (default: `issue-attack-ready`)
- `cleanupWorktreeOnMerge` — reclaim worktree when PR merges (default: `true`). Worktrees hold multi-GB build dirs for compiled projects; `resume` recreates them from the branch.

`ia doctor` shows all effective settings and verifies the model live.

## Architecture

`issue-attack` is a supervisor, not an agent. It claims issues (GitHub labels + assignees), spawns one [pi](https://pi.dev) session per issue in a detached worktree, and monitors its event stream over a JSONL RPC protocol. The agent works unattended under a strict contract (smallest correct change, run tests, open PR or write BLOCKED.md). The supervisor verifies outcomes from git/GitHub state — not from the agent's self-report — and enforces a command safety filter on every bash call.

Two agentic loops: workers (implement issues) and reviewers (verify PRs). Both are supervised; neither merges, comments, or pushes directly. All irreversible actions are supervisor-side.

Full architecture: [DESIGN.md](DESIGN.md)

## Safety

- Workers never push to the base branch, force-push, merge/close PRs, edit issues, or touch secrets/workflows
- Command policy blocks dangerous operations (recursive `rm` on absolute paths, `sudo`, force-push, unauthorized `gh` mutations)
- Agents cannot edit or comment on PRs other than their own
- Every run leaves an audit trail: local event log, pi session, issue thread
- This is a tripwire, not a sandbox — scope `gh` and `pi` credentials accordingly

## Attribution

- Commits: `Co-authored-by: issue-attack <issue-attack@users.noreply.github.com>`
- PRs: `[agent]` prefix, footer with model + thinking level
- Use a dedicated account: `ia account my-bot-account`

## Development

```bash
npm test          # zero dependencies, node --test
node bin/issue-attack.js doctor
```

No build step. Plain ESM, zero runtime dependencies.

## Releasing

```bash
scripts/release.sh              # bump patch, tag, push, watch CI, verify npm
```

CI runs tests, cross-compiles standalone binaries (macOS arm64/x64, Linux x64/arm64), publishes to npm via [trusted publishing](https://docs.npmjs.com/trusted-publishers/) (OIDC — no stored tokens), and attaches binaries with checksums to a GitHub Release.

## License

MIT
