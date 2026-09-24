# issue-attack

Autonomous AI agents that pick up GitHub issues, work them independently, and open pull requests.

Each agent runs in its own isolated git worktree on branch `agent/issue-<n>`, works unattended, and opens a PR (`Closes #<n>`) when finished. Issues can be steered live via comments, and agents write `BLOCKED.md` when they need input.

## Requirements

- `pi` on PATH, authenticated — [install pi](https://pi.dev)
- `gh` on PATH, authenticated with push access to your repo
- A git repository with a GitHub remote
- Node.js >= 22 — only needed for the npm install channel; the binary install doesn't use Node

## Install

**npm** (requires Node >= 22):

```bash
npm install -g issue-attack
```

Or a one-off, no global install:

```bash
npx issue-attack@latest doctor
```

**Binary** (no Node needed) — installs `ia` and `issue-attack` into `~/.local/bin`:

```bash
curl -fsSL https://raw.githubusercontent.com/robtandy/issue_attack/main/scripts/install.sh | sh
```

Override the destination with `INSTALL_DIR=/usr/local/bin`. Binaries for macOS (arm64, x64) and Linux (x64, arm64) are also on the [releases page](https://github.com/robtandy/issue_attack/releases), each with a `.sha256` checksum.

From a checkout:

```bash
git clone https://github.com/robtandy/issue_attack
cd issue_attack && npm link
```

Whichever you choose, verify your setup with `issue-attack doctor`.

## Onboarding a New Repository

To start using issue-attack on a repository:

```bash
cd your-repo
issue-attack init                  # set up labels, config, and pin your account
issue-attack doctor                # verify everything is ready
```

That's it! You now have:
- `.issue_attack/config.json` — local configuration (your account, labels, budgets)
- Labels added to your repo (`issue-attack-ready`, `issue-attack-claimed`, etc.)
- A git hook in future worktrees to add commit attribution

## Using issue-attack

Create an issue and let agents work on it:

```bash
# Create a new issue (auto-labeled as ready for agents)
issue-attack new "Fix the config loader" --body "Details…"

# Run agents: 3 at a time, in watch mode (polling for new issues)
issue-attack attack --max 3 --watch

# Or work a single issue in the foreground
issue-attack run 12
```

When agents finish, they open PRs. If blocked, they comment on the issue with exactly what they need — answer there, then:

```bash
issue-attack resume 12             # agent picks up where it left off
```

## Common Commands

| Command | Purpose |
|---|---|
| `init` | Set up repo (one-time) |
| `doctor` | Verify everything is ready |
| `new <title> [--body t]` | Create an issue for agents |
| `run <issue#>` | Work one issue (foreground) |
| `attack [--max N] [--watch]` | Run a fleet of agents |
| `resume <issue#>` | Continue a blocked agent |
| `stop <issue#>` | Stop a running agent |
| `status` | See all running and completed agents |
| `log <issue#>` | View a run's detailed log |

Full command reference: `issue-attack help`

## Advanced Topics

### Accounts

To pin a GitHub account for a repo (useful for multiple accounts):

```bash
issue-attack account robtandy      # pin this repo to always use this account
issue-attack account               # show current pin
```

### The Blocked Loop

When an agent can't proceed, it writes `BLOCKED.md` on the issue with what it needs. You answer in the issue comments, then:

```bash
issue-attack resume 12             # agent continues from where it stopped
```

### Live Steering

Steer a running agent via command or by commenting on the issue (picked up within ~30s):

```bash
issue-attack steer 12 "use an env var instead of hardcoding the DB"
```

### Configuration

Configuration lives in `.issue_attack/config.json` (created by `init`). Key settings:

- `label`: issues with this label are claimable (default: `issue-attack-ready`)
- `maxConcurrent`: fleet size (default: 3)
- `timeBudgetMinutes`: wall-clock budget per run (default: 45)
- `costBudgetUsd`: model cost budget per run (default: 5.0)
- `model`: AI model to use (default: auto-selected by pi)

Run `issue-attack doctor` to see all effective settings.

### Status Dashboard

Publish a live GitHub Pages dashboard showing all agent runs:

```bash
issue-attack page init      # one-time setup
issue-attack page url       # get the dashboard URL
```

The dashboard shows each agent's status, cost, and current action, updating as they work.

### Full Command Reference

```
issue-attack init [--repo r]        set up a repo (one-time)
issue-attack doctor                 verify everything is ready
issue-attack account [login]        show or pin the GitHub account
issue-attack list [--label L]       show claimable issues
issue-attack new <title> [--body t] create an issue
issue-attack run <issue#> [opts]    work one issue (foreground)
issue-attack attack [opts]          run a fleet (background)
  --max N                           max concurrent agents
  --watch                           keep polling for new issues
  --label L                         custom label (default: issue-attack-ready)
issue-attack resume <issue#>        continue a blocked agent
issue-attack status [--json]        show all runs and outcomes
issue-attack steer <n> <msg>        live guidance to a running agent
issue-attack stop <issue#> [--wait] stop a running agent
issue-attack log <issue#> [--raw]   view a run's log
issue-attack cleanup [--purge]      clean up worktrees
issue-attack page init/publish/url  manage the dashboard
```

Use `ia` as a shorthand: `ia attack --max 3 --watch`

Exit codes: `0` for success/blocked/stopped, `1` for failed/timeout/skipped (scriptable).

## How It Works

`issue-attack` is a supervisor that claims issues, spawns isolated agents in git
worktrees, and monitors their progress. Each agent:

- runs on branch `agent/issue-<n>` in its own worktree
- has a **strict contract** in its system prompt: understand the issue, implement
  the smallest correct change, verify, commit, push, open a PR — or write `BLOCKED.md`
- works unattended with no human input
- is constrained by time/cost budgets and a command safety filter
- can be steered live via `steer` or issue comments
- publishes its event stream so the supervisor can monitor and enforce budgets

When finished: you get a PR (`Closes #<n>`) or a `BLOCKED.md` comment if the
agent needs input.

For full architecture and safety details, see [DESIGN.md](DESIGN.md).

## Attribution

All issue-attack activity is clearly marked:

- **Agent commits** are tagged with `Co-authored-by: issue-attack`
- **PRs** get the `[agent]` prefix and `issue-attack` label
- **Supervisor comments** are self-describing

To use a distinct GitHub account for all agent activity, pin it:

```bash
issue-attack account my-bot-account
```

## Safety

Workers are confined to their branch and worktree and never push to the base
branch, force-push, edit the issue itself, or touch secrets. They have a command
safety filter and hard budgets (time, cost). Scope your `gh` and `pi` credentials
accordingly (a dedicated account or fine-grained PAT is recommended).

Every run leaves a complete audit trail: local event log, pi session, and the
issue thread. This is a tripwire, not a sandbox — read
[DESIGN.md#safety--trust-model](DESIGN.md#safety--trust-model) for details.

## Development

```bash
npm test                        # node --test, zero dependencies
node bin/issue-attack.js doctor
```

No build step, zero runtime dependencies. `bin/` + `lib/` are plain ESM
Node 22+ — the source itself is what the npm package distributes.

One discipline: **keep the code bundleable**. The release pipeline compiles
the CLI into standalone binaries by embedding the module graph, and runtime
file reads break inside them (they resolve to the bundler's virtual
filesystem). So:

- package metadata: `import pkg from "../package.json" with { type: "json" }`
  (see `lib/version.js`) — never `readFileSync` relative to `import.meta.url`
- assets: the `loadHtml()` pattern in `lib/status-page.js` (embedded copy
  first, file fallback for unbundled execution)

CI smoke-tests a compiled binary, but only startup paths. After touching
less-common paths (e.g. status publishing), pre-flight locally:

```bash
bun build --compile --outfile /tmp/ia-test bin/issue-attack.js && /tmp/ia-test --version
```

## Releasing

Tags drive everything. On a clean main with green tests:

```bash
npm version patch               # bumps package.json and creates the v-tag
git push --follow-tags origin main
```

The [release workflow](.github/workflows/release.yml) then runs the tests,
cross-compiles standalone binaries (macOS arm64/x64, Linux x64/arm64),
smoke-tests one, attaches them with `.sha256` checksums to a GitHub Release,
and publishes the npm package.

- **npm publish** uses [trusted publishing](https://docs.npmjs.com/trusted-publishers/)
  (OIDC): CI proves its identity to npm with short-lived tokens — no access
  tokens stored anywhere. One-time bootstrap, because npm can't link a trusted
  publisher until the package name exists:
  1. `npm login`, then `npm publish` once locally — this claims the name
  2. npmjs.com → package → Settings → Trusted publishing → link this
     repository (`robtandy/issue_attack`) and workflow file `release.yml`,
     with publish allowed
- **Binary users** update by re-running the `curl ... install.sh | sh`
  one-liner from [Install](#install).
- Tag names must match `package.json` (`v0.3.1` ↔ `0.3.1`) — `npm version`
  guarantees this, and the workflow enforces it. The npm step skips versions
  already on npm, so re-tagging to re-ship binaries is safe.

## License

MIT
