// Command-line interface. Hand-rolled arg parsing, zero dependencies.

import { readFileSync, existsSync, mkdirSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { c, printTable, fmtMoney, fmtDuration, toolSummary } from "./ui.js";
import { loadConfig, DEFAULTS, dirs } from "./config.js";
import * as gh from "./gh.js";
import * as git from "./git.js";
import * as stateMod from "./state.js";
import { AgentRunner, attackFleet } from "./runner.js";
import { exec, must, which } from "./exec.js";

const VERSION = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version;

const HELP = `issue_attack ${VERSION} — autonomous agents that work GitHub issues and open PRs

Usage: issue_attack <command> [args] [options]

Commands:
  init                      Set up config, labels and gitignore entries for this repo
  doctor                    Verify prerequisites (git, gh, pi, labels, config)
  list [--label L]          Show claimable issues (default label: agent-ready)
  run <issue#>              Attack one issue in the foreground (streams the agent)
  attack [--max N] [--watch] [--label L]
                            Attack up to N issues concurrently; --watch keeps polling
  resume <issue#>           Resume a blocked/failed/timeout run with fresh issue comments
  status [--json]           Show local fleet status
  steer <issue#> <message>  Send live guidance to a running agent
  stop <issue#> [--wait]    Stop a running agent (releases the issue claim)
  log <issue#> [--raw]      Show the run log for an issue
  cleanup [--issue N] [--purge]
                            Remove worktrees of finished runs; --purge also drops
                            sessions, logs, local branches and state entries

Options (common):
  --root <dir>              Operate on this repository instead of the cwd
  --repo <owner/name>       Target a different GitHub repository
  --model <id>              Model for this run, e.g. sonnet:high
  --label <name>            Issue label that marks work as claimable
  --max <n>                 Max concurrent agents (attack)
  --fresh                   Ignore prior session/worktree, start over (run)

Typical flow:
  issue_attack init
  gh issue edit 12 --add-label agent-ready     # mark an issue as attackable
  issue_attack attack --max 3 --watch

Config: .issue_attack/config.json (created by init; see README for all fields).`;

// ---- arg parsing -------------------------------------------------------------

function parseArgs(argv, spec) {
  const opts = {};
  const positionals = [];
  for (const key of Object.keys(spec)) {
    if (spec[key].default !== undefined) opts[key] = spec[key].default;
  }
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok === "-h" || tok === "--help") return { opts, positionals, help: true };
    if (tok.startsWith("-")) {
      const bare = tok.replace(/^--?/, "");
      const eq = bare.indexOf("=");
      let name = eq === -1 ? bare : bare.slice(0, eq);
      let inlineVal = eq === -1 ? null : bare.slice(eq + 1);
      const def = spec[name];
      if (!def) throw new Error(`unknown option: ${tok} (see --help)`);
      if (def.type === "bool") {
        opts[name] = true;
      } else {
        const val = inlineVal !== null ? inlineVal : argv[++i];
        if (val === undefined) throw new Error(`option ${tok} requires a value`);
        opts[name] = def.type === "number" ? Number(val) : val;
        if (def.type === "number" && !Number.isFinite(opts[name])) {
          throw new Error(`option ${tok} must be a number`);
        }
      }
    } else {
      positionals.push(tok);
    }
  }
  return { opts, positionals, help: false };
}

const out = (msg = "") => console.log(msg);

// ---- shared context ----------------------------------------------------------

async function context(opts) {
  const root = await git.resolveRoot(process.cwd(), opts.root);
  if (!root) {
    throw new Error("not inside a git repository — run issue_attack from a repo, or pass --root");
  }
  const repoInfo = await gh.repoInfo(root, opts.repo);
  const config = { ...loadConfig(root), ...pickSet(opts, ["model"]) };
  return { root, repoInfo, config };
}

function pickSet(obj, keys) {
  const r = {};
  for (const k of keys) if (obj[k] !== undefined && obj[k] !== null) r[k] = obj[k];
  return r;
}

function requireIssue(positionals) {
  const n = Number(positionals[0]);
  if (!Number.isInteger(n) || n <= 0) throw new Error("expected an issue number, e.g. issue_attack run 12");
  return n;
}

// ---- commands ----------------------------------------------------------------

async function cmdInit(opts) {
  const { root, repoInfo, config } = await context(opts);
  const d = dirs(root);
  for (const dir of [d.base, d.worktrees, d.sessions, d.logs, d.inbox, d.stop]) {
    mkdirSync(dir, { recursive: true });
  }

  const cfgFile = dirs(root).config;
  if (existsSync(cfgFile)) {
    out(`${c.dim("config exists:")} ${cfgFile}`);
  } else {
    writeFileSync(cfgFile, JSON.stringify(DEFAULTS, null, 2) + "\n");
    out(`${c.green("created config:")} ${cfgFile}`);
  }

  const gitignore = join(root, ".gitignore");
  const marker = ".issue_attack/";
  if (existsSync(gitignore)) {
    const cur = readFileSync(gitignore, "utf8");
    if (!cur.split("\n").some((l) => l.trim() === marker)) {
      appendFileSync(gitignore, `\n# issue_attack runtime state (worktrees, sessions, logs)\n${marker}\n`);
      out(`${c.green("updated:")} .gitignore`);
    }
  } else {
    writeFileSync(gitignore, `${marker}\n`);
    out(`${c.green("created:")} .gitignore`);
  }

  out(`ensuring labels on ${repoInfo.nameWithOwner}…`);
  await gh.ensureLabel(root, repoInfo.nameWithOwner, config.claimedLabel, "d4c5f9", "claimed by an issue_attack agent");
  await gh.ensureLabel(root, repoInfo.nameWithOwner, config.blockedLabel, "fbca04", "issue_attack agent is blocked, needs maintainer input");
  await gh.ensureLabel(root, repoInfo.nameWithOwner, config.doneLabel, "0e8a16", "resolved by an issue_attack agent");
  await gh.ensureLabel(root, repoInfo.nameWithOwner, config.prLabel, "1d76db", "opened by an issue_attack agent");
  out(c.green("labels ready."));

  out(`\nNext: label an issue as ${c.cyan(config.label)} and run ${c.bold("issue_attack attack")}.`);
}

async function cmdDoctor(opts) {
  const rows = [];
  const ok = (name, detail, warn = false) => rows.push([warn ? c.yellow("warn") : c.green("ok"), name, detail]);

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  ok("node", `v${process.versions.node}${nodeMajor < 22 ? " (need >= 22!)" : ""}`, nodeMajor < 22);

  const hasPi = await which("pi");
  if (hasPi) {
    let ver = "?";
    try {
      ver = (await must("pi", ["--version"], { timeoutMs: 15_000 })).trim();
    } catch {}
    ok("pi", ver);
  } else {
    ok("pi", "not found on PATH (workers need it)", true);
  }

  const hasGh = await which("gh");
  if (!hasGh) {
    ok("gh", "not found on PATH", true);
  } else {
    ok("gh auth", (await gh.ghAuthOk(process.cwd())) ? "authenticated" : "not authenticated (run gh auth login)", !(await gh.ghAuthOk(process.cwd())));
  }

  let root = null;
  try {
    root = await git.resolveRoot(process.cwd(), opts.root);
  } catch {}
  if (!root) {
    ok("repo", "not inside a git repository", true);
  } else {
    try {
      const repoInfo = await gh.repoInfo(root, opts.repo);
      const config = loadConfig(root);
      ok("repo", `${repoInfo.nameWithOwner} (default branch: ${repoInfo.defaultBranch})`);

      if (existsSync(dirs(root).config)) ok("config", dirs(root).config);
      else ok("config", "missing — run `issue_attack init`", true);

      let labels = [];
      try {
        labels = JSON.parse(await must("gh", ["label", "list", "-R", repoInfo.nameWithOwner, "--json", "name", "--limit", "100"], { cwd: root }));
      } catch {}
      const names = new Set(labels.map((l) => l.name));
      for (const [label, why] of [
        [config.claimedLabel, "claim mutex"],
        [config.blockedLabel, "blocked flag"],
        [config.doneLabel, "done flag"],
        [config.prLabel, "PR marker"],
      ]) {
        ok(`label ${label}`, names.has(label) ? "present" : `missing — run \`issue_attack init\``, !names.has(label));
      }

      if (hasPi) {
        try {
          const { stdout } = await exec("pi", ["--list-models"], { timeoutMs: 30_000 });
          const count = stdout.trim().split("\n").filter(Boolean).length;
          ok("pi models", count ? `${count} configured` : "none — run pi and /login", count === 0);
        } catch {
          ok("pi models", "could not list (run pi and /login)", true);
        }
      }
    } catch (err) {
      ok("repo", `gh could not resolve the repo: ${err.message}`, true);
    }
  }

  printTable(rows, ["status", "check", "detail"]);
}

async function cmdList(opts) {
  const { root, repoInfo, config } = await context(opts);
  const { state } = stateMod.reconcile(root);
  const label = opts.label ?? config.label;
  const issues = await gh.listIssues(root, repoInfo.nameWithOwner, label, opts.limit ?? 100);

  const rows = [];
  for (const it of issues) {
    const labels = (it.labels ?? []).map((l) => l.name);
    if (labels.includes(config.claimedLabel)) continue;
    if ((it.assignees ?? []).length > 0) continue;
    const entry = stateMod.getEntry(state, it.number);
    if (entry?.status === "running") continue;
    if (entry && ["succeeded", "blocked", "timeout"].includes(entry.status)) continue;
    rows.push([String(it.number), clip(it.title, 60), labels.join(",") || c.dim("-")]);
  }
  if (!rows.length) {
    out(`No claimable issues${label ? ` labeled ${c.cyan(label)}` : ""}.`);
    out(`Mark work with: ${c.bold(`gh issue edit <n> --add-label ${label}`)}`);
  } else {
    printTable(rows, ["issue", "title", "labels"]);
    out(`\nAttack with: ${c.bold(`issue_attack attack --label ${label}`)}`);
  }

  const blocked = Object.values(state.runs).filter((e) => e.status === "blocked");
  if (blocked.length) {
    out(`\n${c.yellow("Blocked (awaiting your reply, then `issue_attack resume <n>`):")}`);
    for (const e of blocked) out(`  #${e.issue} — ${e.endedAt ?? ""}`);
  }
}

async function cmdRun(opts, positionals, { mode = "run" } = {}) {
  const { root, repoInfo, config } = await context(opts);
  const issue = requireIssue(positionals);
  const { state } = stateMod.reconcile(root);
  const entry = stateMod.getEntry(state, issue);
  if (entry?.status === "running" && stateMod.isPidAlive(entry.supervisorPid)) {
    throw new Error(`#${issue} is already running (pid ${entry.supervisorPid}) — use \`issue_attack steer ${issue} "…"\` or \`issue_attack stop ${issue}\``);
  }

  let effectiveMode = mode;
  if (entry && mode === "run" && !opts.fresh) {
    out(`${c.dim(`existing ${entry.status} run found — resuming its session/worktree (use --fresh to start over)`)}`);
    effectiveMode = "resume";
  }
  if (opts.fresh) effectiveMode = "fresh";

  const runner = new AgentRunner({
    root, repoInfo, config, issue, mode: effectiveMode,
    model: opts.model ?? null,
    streamText: true,
    onLine: (m) => out(m),
  });

  let interrupted = 0;
  const onSigint = () => {
    interrupted++;
    if (interrupted > 1) process.exit(130);
    out(c.yellow("\nstop requested — finishing up (Ctrl-C again to force)…"));
    runner.requestStop();
  };
  process.on("SIGINT", onSigint);

  try {
    const result = await runner.run();
    process.exitCode = ["succeeded", "blocked", "stopped"].includes(result.kind) ? 0 : 1;
  } finally {
    process.removeListener("SIGINT", onSigint);
  }
}

async function cmdAttack(opts) {
  const { root, repoInfo, config } = await context(opts);
  const max = opts.max ?? config.maxConcurrent;
  await attackFleet({
    root,
    repoInfo,
    config,
    max,
    label: opts.label ?? config.label,
    watch: !!opts.watch,
    pollSeconds: opts.poll ?? config.pollSeconds,
    limit: opts.limit,
    model: opts.model ?? null,
    out,
  });
}

async function cmdStatus(opts) {
  const { root } = await context(opts);
  const { state } = stateMod.reconcile(root);
  const entries = Object.values(state.runs).sort((a, b) => b.issue - a.issue);
  if (opts.json) {
    out(JSON.stringify(state, null, 2));
    return;
  }
  if (!entries.length) {
    out("No runs recorded yet.");
    return;
  }
  const rows = entries.map((e) => [
    `#${e.issue}`,
    e.status === "running" ? c.green(e.status) : e.status,
    String(e.attempts ?? 1),
    clip(e.branch ?? "-", 30),
    e.prUrl ? clip(e.prUrl.replace("https://github.com/", ""), 40) : c.dim("-"),
    e.cost != null ? fmtMoney(e.cost) : c.dim("-"),
    e.endedAt ?? e.startedAt ?? "",
  ]);
  printTable(rows, ["issue", "status", "att", "branch", "PR", "cost", "ended"]);
}

async function cmdSteer(opts, positionals) {
  const { root } = await context(opts);
  const issue = requireIssue(positionals);
  const message = positionals.slice(1).join(" ").trim();
  if (!message) throw new Error("usage: issue_attack steer <issue#> <message>");
  const { state } = stateMod.reconcile(root);
  const entry = stateMod.getEntry(state, issue);
  if (!entry || entry.status !== "running" || !stateMod.isPidAlive(entry.supervisorPid)) {
    throw new Error(`#${issue} has no live agent — start one with \`issue_attack run ${issue}\` or \`attack\``);
  }
  stateMod.writeSteer(root, issue, message);
  out(`${c.green("steer queued:")} "${message}"`);
  out(c.dim(`The agent will receive it after its current tool call completes.`));
}

async function cmdStop(opts, positionals) {
  const { root, repoInfo, config } = await context(opts);
  const issue = requireIssue(positionals);
  const { state } = stateMod.reconcile(root);
  const entry = stateMod.getEntry(state, issue);
  if (!entry) throw new Error(`no run recorded for #${issue}`);

  if (entry.status === "running" && stateMod.isPidAlive(entry.supervisorPid)) {
    stateMod.setStop(root, issue);
    out(`${c.yellow("stop signal sent to agent on #")} ${issue}${opts.wait ? " — waiting…" : ""}`);
    if (opts.wait) {
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 1000));
        const e2 = stateMod.getEntry(stateMod.loadState(root), issue);
        if (e2.status !== "running") {
          out(`${c.green("stopped:")} final status: ${e2.status}`);
          return;
        }
      }
      out(c.yellow("still stopping after 90s — try `issue_attack stop --force` or kill the pid"));
    }
  } else {
    // Dead supervisor or stale claim: release and mark stopped.
    if (entry.status === "running") {
      if (entry.piPid) {
        try {
          process.kill(entry.piPid, "SIGTERM");
        } catch {}
      }
    }
    const runner = new AgentRunner({ root, repoInfo, config, issue, mode: "resume" });
    await runner.releaseClaim({ removeLabels: [config.claimedLabel] });
    const st = stateMod.loadState(root);
    stateMod.setEntry(st, issue, { status: "stopped", endedAt: new Date().toISOString(), piPid: null });
    stateMod.saveState(root, st);
    out(`${c.green("released claim on #")}${issue}`);
  }
}

async function cmdLog(opts, positionals) {
  const { root } = await context(opts);
  const issue = requireIssue(positionals);
  const file = join(dirs(root).logs, `issue-${issue}.jsonl`);
  if (!existsSync(file)) throw new Error(`no log for #${issue} (${file})`);
  const lines = readFileSync(file, "utf8").split("\n").filter(Boolean);
  const tail = lines.slice(-(opts.lines ?? 60));
  for (const line of tail) {
    if (line.startsWith("#")) {
      out(c.bold(line));
      continue;
    }
    if (opts.raw) {
      out(line);
      continue;
    }
    try {
      const rec = JSON.parse(line);
      if (rec.type === "message_update") continue;
      if (rec.type === "tool_execution_start") out(`  → ${rec.toolName} ${c.dim(toolSummary(rec))}`);
      else if (rec.type === "tool_execution_end") {
        if (rec.isError) out(c.red(`  ✗ ${rec.toolName} failed`));
      } else if (rec.type === "agent_settled") out(c.dim("  · settled"));
      else if (rec.type === "message_end" && rec.message?.role === "assistant") {
        const text = (rec.message.content ?? []).filter((b) => b.type === "text").map((b) => b.text).join(" ");
        if (text) out(`  💬 ${clip(text, 160)}`);
      } else if (rec.type === "auto_retry_start") out(c.yellow(`  ↻ retry ${rec.attempt}/${rec.maxAttempts}`));
    } catch {
      out(line);
    }
  }
  out(c.dim(`\nfull log: ${file}`));
}

async function cmdCleanup(opts, positionals) {
  const { root, repoInfo, config } = await context(opts);
  const { state } = stateMod.reconcile(root);
  let targets = Object.values(state.runs).filter((e) => e.status !== "running");
  if (opts.issue) {
    const issue = requireIssue(positionals.length ? positionals : [opts.issue]);
    targets = targets.filter((e) => e.issue === issue);
    if (!targets.length) throw new Error(`no finished run recorded for #${issue} (running runs must be stopped first)`);
  } else if (positionals.length) {
    targets = targets.filter((e) => e.issue === requireIssue(positionals));
  }
  if (!targets.length) {
    out("Nothing to clean.");
    return;
  }

  for (const e of targets) {
    out(`#${e.issue} [${e.status}]`);
    // Worktree
    if (e.worktree && existsSync(e.worktree)) {
      const dirty = await git.isDirty(e.worktree);
      if (dirty && !opts.purge) {
        out(`  ${c.yellow("worktree kept (uncommitted changes) — use --purge to discard")}`);
      } else {
        try {
          await git.removeWorktree(root, e.worktree, dirty && opts.purge);
          out(`  ${c.green("worktree removed")}`);
        } catch (err) {
          out(`  ${c.yellow("worktree:")} ${err.message}`);
        }
      }
    }
    if (opts.purge) {
      // Local branch (never the remote; keep it while a PR is open)
      try {
        const prs = await gh.prsForBranch(root, repoInfo.nameWithOwner, e.branch);
        if (prs.some((p) => p.state === "OPEN")) {
          out(`  ${c.yellow(`branch kept: open PR ${prs[0].url}`)}`);
        } else if (e.branch) {
          await git.deleteLocalBranch(root, e.branch);
          out(`  ${c.green("branch removed locally")}`);
        }
      } catch (err) {
        out(`  ${c.yellow("branch:")} ${err.message}`);
      }
      for (const p of [
        join(dirs(root).sessions, `issue-${e.issue}`),
        join(dirs(root).logs, `issue-${e.issue}.jsonl`),
      ]) {
        if (existsSync(p)) {
          rmSync(p, { recursive: true, force: true });
          out(`  ${c.green("removed")} ${p.replace(root + "/", "")}`);
        }
      }
    }
  }

  if (opts.purge) {
    const st = stateMod.loadState(root);
    for (const e of targets) {
      if ((st.runs[e.issue]?.status ?? "running") !== "running") delete st.runs[e.issue];
    }
    stateMod.saveState(root, st);
    out(c.green("state entries purged."));
  } else {
    out(c.dim("Branches, sessions and state kept — use --purge to drop them too."));
  }
}

function clip(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ---- dispatch ----------------------------------------------------------------

const COMMANDS = {
  init: { fn: () => cmdInit, spec: { root: { type: "string" }, repo: { type: "string" } } },
  doctor: { fn: () => cmdDoctor, spec: { root: { type: "string" }, repo: { type: "string" } } },
  list: {
    fn: () => cmdList,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      label: { type: "string" }, limit: { type: "number" },
    },
  },
  run: {
    fn: () => cmdRun,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      model: { type: "string" }, fresh: { type: "bool" },
    },
  },
  attack: {
    fn: () => cmdAttack,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      label: { type: "string" }, max: { type: "number" }, watch: { type: "bool" },
      poll: { type: "number" }, limit: { type: "number" }, model: { type: "string" },
    },
  },
  resume: {
    fn: () => cmdRun,
    spec: {
      root: { type: "string" }, repo: { type: "string" }, model: { type: "string" },
    },
    extra: { mode: "resume" },
  },
  status: { fn: () => cmdStatus, spec: { root: { type: "string" }, repo: { type: "string" }, json: { type: "bool" } } },
  steer: {
    fn: () => cmdSteer,
    spec: { root: { type: "string" }, repo: { type: "string" } },
  },
  stop: {
    fn: () => cmdStop,
    spec: { root: { type: "string" }, repo: { type: "string" }, wait: { type: "bool" } },
  },
  log: {
    fn: () => cmdLog,
    spec: { root: { type: "string" }, repo: { type: "string" }, raw: { type: "bool" }, lines: { type: "number" } },
  },
  cleanup: {
    fn: () => cmdCleanup,
    spec: { root: { type: "string" }, repo: { type: "string" }, issue: { type: "number" }, purge: { type: "bool" } },
  },
};

export async function main(argv) {
  const [name, ...rest] = argv;
  if (!name || name === "help" || name === "--help" || name === "-h") {
    out(HELP);
    return;
  }
  if (name === "version" || name === "--version" || name === "-v") {
    out(`issue_attack ${VERSION}`);
    return;
  }
  const cmd = COMMANDS[name];
  if (!cmd) {
    out(`${c.red(`unknown command: ${name}`)}\n`);
    out(HELP);
    process.exitCode = 1;
    return;
  }
  let parsed;
  try {
    parsed = parseArgs(rest, cmd.spec);
  } catch (err) {
    out(`${c.red(err.message)}\n\n${HELP}`);
    process.exitCode = 1;
    return;
  }
  if (parsed.help) {
    out(HELP);
    return;
  }
  await cmd.fn(parsed.opts, parsed.positionals, cmd.extra ?? {});
}
