# Contributing to issue_attack

Thanks for hacking on this! Here's what you need to know.

## Prerequisites

- **Node.js >= 22** — check with `node --version`
- **git** — for worktree isolation
- **gh** — GitHub CLI, authenticated (`gh auth login` with push access)
- **pi** — the agent harness, installed and authenticated (`pi --version`, then `/login` if needed)

See the [main README](README.md#requirements) for installation details.

## Running the CLI from a checkout

No build step. From the repo root:

```bash
node bin/issue_attack.js help
node bin/issue_attack.js doctor
node bin/issue_attack.js run 12
```

Plain ESM, zero runtime dependencies. Just Node, git, and gh.

## Running tests

```bash
npm test
```

Tests live in `tests/` and use Node's built-in test runner. To run a single
test file:

```bash
node --test tests/policy.test.mjs
```

Add tests when you add or change behavior.

## Philosophy

- **No build step** — `bin/` and `lib/` are plain Node 22+ ESM.
- **Zero runtime dependencies** — keep it light. Config, strings, file I/O,
  shell commands, and pi RPC are all we need.
- **Unopinionated** — this tool is a supervisor, not a framework. All the
  agent intelligence lives in pi (the harness) and the worker contract
  (the system prompt injected into each run).

## Code organization

- `bin/issue_attack.js` — entry point
- `lib/cli.js` — command dispatcher and handlers
- `lib/runner.js` — the supervisor's core loop (claim, spawn, monitor, post)
- `lib/pi-client.js` — pi RPC wrapper
- `lib/gh.js` — GitHub API (issues, PRs, comments)
- `lib/git.js` — git operations (worktrees, branches)
- `lib/policy.js` — command tripwire and safety rules
- `lib/config.js` — `.issue_attack/config.json` loader
- `lib/prompt.js` — worker system prompt and context assembly

## Understanding the system

Read [DESIGN.md](DESIGN.md) for the full picture: goals, architecture, failure
modes, the worker contract, and the safety model. It's detailed and worth your
time if you're changing the supervisor loop or the worker prompt.

## Submitting a change

Keep commits small and reviewable. Reference the issue in your commit message
(`issue #5: …`). Add or update tests. Run `npm test` before pushing.

When you open a PR, include:
- What changed and why
- How you verified it (tests, manual steps)
- Any assumptions or trade-offs

That's it. We'll take it from there.
