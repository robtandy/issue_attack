# Contributing to issue_attack

Thanks for hacking on this! Here's what you need to know.

## Prerequisites

- **Node.js >= 22** — check with `node --version`
- **git** — for worktree isolation
- **gh** — GitHub CLI, authenticated (`gh auth login` with push access)
- **pi** — the agent harness, installed and authenticated (`pi --version`, then `/login` if needed)

See the [main README](README.md#requirements) for installation details.

## Running the CLI from a checkout

TypeScript, compiled with `tsc`. From the repo root:

```bash
npm install        # installs the dev-only toolchain and compiles src/ → dist/
npm run build      # recompile after edits (or `npm test` to build + test)
node dist/bin/issue-attack.js help
node dist/bin/issue-attack.js doctor
node dist/bin/issue-attack.js run 12
```

Zero runtime dependencies — TypeScript and `@types/node` are dev-only, and
`tsc` must pass with no errors (CI and `npm test` enforce it).

## Running tests

```bash
npm test
```

Tests live in `tests/` and use Node's built-in test runner; they import the
compiled output from `dist/`, so build first. To run a single test file:

```bash
npm run build && node --test tests/policy.test.mjs
```

Add tests when you add or change behavior.

## Philosophy

- **TypeScript, like pi** — sources in `src/` (`src/bin/`, `src/lib/`), compiled
  by `tsc` to plain ESM JavaScript in `dist/`. Keep the build error-free.
- **Zero runtime dependencies** — keep it light. Config, strings, file I/O,
  shell commands, and pi RPC are all we need.
- **Bundleable** — the compiled module graph gets embedded in standalone
  binaries; import assets/package metadata at build time, never via runtime
  `readFileSync` relative to `import.meta.url`.
- **Unopinionated** — this tool is a supervisor, not a framework. All the
  agent intelligence lives in pi (the harness) and the worker contract
  (the system prompt injected into each run).

## Code organization

- `src/bin/issue-attack.ts` — entry point
- `src/lib/cli.ts` — command dispatcher and handlers
- `src/lib/runner.ts` — the supervisor's core loop (claim, spawn, monitor, post)
- `src/lib/pi-client.ts` — pi RPC wrapper
- `src/lib/gh.ts` — GitHub API (issues, PRs, comments)
- `src/lib/git.ts` — git operations (worktrees, branches)
- `src/lib/policy.ts` — command tripwire and safety rules
- `src/lib/config.ts` — `.issue_attack/config.json` loader
- `src/lib/prompt.ts` — worker system prompt and context assembly
- `src/lib/status-page.ts` — fleet dashboard publishing
- `src/lib/state.ts` — local run registry and control channel
- `dist/` — compiled JavaScript (gitignored; what runs and ships)

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
