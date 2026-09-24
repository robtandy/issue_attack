// Command-line interface. Hand-rolled arg parsing, zero dependencies.

import { readFileSync, existsSync, mkdirSync, appendFileSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { c, printTable, fmtMoney, fmtDuration, toolSummary } from "./ui.js";
import { loadConfig, DEFAULTS, dirs } from "./config.js";
import * as gh from "./gh.js";
import * as git from "./git.js";
import * as stateMod from "./state.js";
import { AgentRunner, attackFleet } from "./runner.js";
import * as statusPage from "./status-page.js";
import { exec, must, which } from "./exec.js";
import VERSION from "./version.js";

const HELP = `issue_attack ${VERSION} — autonomous agents that work GitHub issues and open PRs

Usage: issue_attack <command> [args] [options]

Commands:
  init                      Set up config, labels and gitignore entries for this repo
  account [login]           Show or pin the GitHub account used for this repo
  doctor                    Verify prerequisites (git, gh, pi, labels, config)
  list [--label L]          Show claimable issues (default label: issue-attack-ready)
  new <title> [--body <text> | --body-file <path>] [--label a,b] [--no-ready]
                            Create an issue (labeled issue-attack-ready by default);
                            reads body from stdin if not provided and stdin is piped
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
  page init                 Publish the fleet status dashboard to GitHub Pages
                            (page publish / page url also available)

Options (common):
  --root <dir>              Operate on this repository instead of the cwd
  --repo <owner/name>       Target a different GitHub repository
  --model <id>              Model for this run, e.g. sonnet:high
  --label <name>            Issue label that marks work as claimable
  --max <n>                 Max concurrent agents (attack)
  --fresh                   Ignore prior session/worktree, start over (run)

Typical flow:
  issue_attack init
  gh issue edit 12 --add-label issue-attack-ready     # mark an issue as attackable
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
      // kebab-case flags map to camelCase spec keys (--body-file → bodyFile)
      name = name.replace(/-([a-z])/g, (m) => m[1].toUpperCase());
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

async function context(opts, { tryAccounts = false } = {}) {
  const root = await git.resolveRoot(process.cwd(), opts.root);
  if (!root) {
    throw new Error("not inside a git repository — run issue_attack from a repo, or pass --root");
  }
  const config = { ...loadConfig(root), ...pickSet(opts, ["model"]) };

  // Pinned GitHub account: resolve its token once and export GH_TOKEN for
  // every gh call in this process tree — supervisor, workers and their gh
  // commands all use the account this repo is bound to. This must happen
  // BEFORE repo resolution: private repos are invisible to the default gh
  // account (e.g. an enterprise-managed one), which would otherwise leave
  // repoInfo null here.
  if (config.ghAccount) {
    const { code, stdout, stderr } = await exec("gh", ["auth", "token", "--user", config.ghAccount]);
    if (code !== 0) {
      throw new Error(
        `repo is pinned to GitHub account "${config.ghAccount}" but that account is not logged in ` +
        `(${stderr.trim()}). Run \`gh auth login\` for it, or \`issue_attack account <login>\` to re-pin.`
      );
    }
    process.env.GH_TOKEN = stdout.trim();
    console.log(c.dim(`using GitHub account ${c.bold(config.ghAccount)} (pinned for this repo)`));
  }

  const repoInfo = await gh.repoInfo(root, opts.repo, tryAccounts);
  if (!repoInfo) {
    throw new Error(
      `could not resolve the GitHub repository at ${root} — the current gh account cannot see it. ` +
      `Check \`gh auth status\`, or pin the right account with \`issue_attack account <login>\`.`
    );
  }
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
  // For init, resolve the repo with multi-account fallback, bypassing the pinned account check
  const root = await git.resolveRoot(process.cwd(), opts.root);
  if (!root) {
    throw new Error("not inside a git repository — run issue_attack from a repo, or pass --root");
  }
  const repoInfo = await gh.repoInfo(root, opts.repo, true);
  const config = { ...loadConfig(root), ...pickSet(opts, ["model"]) };
  const d = dirs(root);
  for (const dir of [d.base, d.worktrees, d.sessions, d.logs, d.inbox, d.stop]) {
    mkdirSync(dir, { recursive: true });
  }

  const cfgFile = d.config;
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

  // Pin this repo to the GitHub account that owns it (set once, re-runnable).
  if (!config.ghAccount) {
    const login = await gh.currentUser();
    const cfg = loadConfig(root);
    cfg.ghAccount = login;
    writeFileSync(dirs(root).config, JSON.stringify(cfg, null, 2) + "\n");
    out(`${c.green("pinned GitHub account:")} ${c.bold(login)} ${c.dim("(change with: issue_attack account <login>)")}`);
    // Clear the repo cache so doctor and other commands resolve the account fresh
    gh.clearRepoCache();
  }

  out(`\nNext: label an issue as ${c.cyan(config.label)} and run ${c.bold("issue_attack attack")}.`);
  out(`For a live dashboard: ${c.bold("issue_attack page init")}.`);
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

      // Account pinning
      const cfg = loadConfig(root);
      let effLogin = "?";
      try {
        if (cfg.ghAccount) {
          const t = await exec("gh", ["auth", "token", "--user", cfg.ghAccount]);
          if (t.code === 0) process.env.GH_TOKEN = t.stdout.trim();
          else ok("account", `pinned "${cfg.ghAccount}" is not logged in — run gh auth login`, true);
        }
        effLogin = (await gh.currentUser()).trim();
        ok("account", cfg.ghAccount
          ? `pinned ${cfg.ghAccount}, effective ${effLogin}`
            : `not pinned — using gh's active account (${effLogin}); pin with \`issue_attack account <login>\``,
          !cfg.ghAccount);
      } catch (err) {
        ok("account", `unresolvable: ${err.message}`, true);
      }

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

async function cmdPage(opts, positionals) {
  const { root, repoInfo, config } = await context(opts);
  const action = positionals[0] ?? "init";
  const repo = repoInfo.nameWithOwner;

  if (action === "init") {
    out(`publishing dashboard to ${c.cyan(config.statusBranch)}…`);
    const first = await statusPage.publishStatus(root, repoInfo, config, { force: true }).catch((err) => ({
      error: err.message,
    }));
    if (first?.error) throw new Error(`publish failed: ${first.error}`);
    out(`  ${c.green("pushed")} dashboard + status.json + deploy workflow`);

    const en = await statusPage.enablePages(root, repo, config.statusBranch, { force: !!opts.force });
    if (en.ok) {
      out(`  ${c.green("pages enabled")} ${en.created ? "(new site)" : "(converted to Actions deploys)"}`);
    } else if (en.needsForce) {
      throw new Error(en.error);
    } else {
      out(`  ${c.yellow("pages:")} ${en.error}`);
    }

    // The first push predated the Pages site; publish again so the workflow
    // (shipped on the status branch) triggers a clean first deploy.
    await statusPage.publishStatus(root, repoInfo, config, { force: true }).catch(() => {});

    let url = null;
    for (let i = 0; i < 5 && !url; i++) {
      url = await statusPage.pageUrl(root, repo);
      if (!url) await new Promise((r) => setTimeout(r, 2000));
    }
    if (url) {
      out(`\n${c.green("status page:")} ${c.bold(url)}`);
      out(c.dim("first deploy can take a minute; the page auto-refreshes every 5s"));
    } else {
      out(c.yellow("\nPages URL not ready yet — re-run `issue_attack page url` in a minute."));
    }
    out(`\nWhile agents run, status refreshes every ${config.statusPublishMinutes}m;`);
    out(`comment on any issue to steer its live agent (${config.commentSteerSeconds}s pickup).`);
  } else if (action === "publish") {
    const res = await statusPage.publishStatus(root, repoInfo, config, { force: true });
    if (res?.error) throw new Error(res.error);
    if (res?.pushed) out(c.green(`published (${res.agents} agents) at ${res.at}`));
    else out(`skipped: ${res?.skipped ?? "unknown"}`);
  } else if (action === "url") {
    const url = await statusPage.pageUrl(root, repo);
    if (url) out(url);
    else throw new Error(`GitHub Pages is not enabled for ${repo} — run \`issue_attack page init\``);
  } else {
    throw new Error(`unknown page action: ${action} (use init, publish, or url)`);
  }
}

async function cmdNew(opts, positionals) {
  // Read body from stdin early, before context() call, to ensure stdin is in original state
  let body = opts.body ?? "";
  if (!body && opts.bodyFile) {
    // --body-file takes precedence
    body = opts.bodyFile === "-" ? readFileSync(0, "utf8") : readFileSync(opts.bodyFile, "utf8");
  } else if (!body) {
    // No --body or --body-file provided; check if stdin is piped
    if (!process.stdin.isTTY) {
      // stdin is not a TTY (i.e., is piped or redirected), so try to read from it
      body = readFileSync(0, "utf8");
    }
  }

  const { root, repoInfo, config } = await context(opts);
  const title = positionals.join(" ").trim();
  if (!title) throw new Error("usage: issue_attack new <title> [--body <text> | --body-file <path>] [--label a,b] [--no-ready]");

  const labels = [];
  if (!opts.noReady) labels.push(config.label);
  if (opts.label) {
    labels.push(...String(opts.label).split(",").map((s) => s.trim()).filter(Boolean));
  }
  if (!opts.noReady) {
    await gh.ensureLabel(root, repoInfo.nameWithOwner, config.label, "5319e7", "ready for an issue_attack agent to pick up");
  }

  const issue = await gh.createIssue(root, repoInfo.nameWithOwner, { title, body, labels });
  out(`${c.green("created:")} ${issue.html_url}`);
  if (!opts.noReady) {
    out(c.dim(`labeled ${c.cyan(config.label)} — run an agent with: issue_attack run ${issue.number} (or \`attack\`)`));
  } else {
    out(c.dim(`mark it ready when you are: gh issue edit ${issue.number} --add-label ${config.label}`));
  }
}

async function cmdAccount(opts, positionals) {
  const setTo = positionals[0];
  const root = await git.resolveRoot(process.cwd(), opts.root);
  if (!root) throw new Error("not inside a git repository — or pass --root");

  if (setTo) {
    const { code, stderr } = await exec("gh", ["auth", "token", "--user", setTo]);
    if (code !== 0) {
      throw new Error(`"${setTo}" is not logged in — run \`gh auth login\` first (${stderr.trim()})`);
    }
    const cfgFile = dirs(root).config;
    const cfg = loadConfig(root);
    cfg.ghAccount = setTo;
    writeFileSync(cfgFile, JSON.stringify(cfg, null, 2) + "\n");
    out(`${c.green("pinned this repo to GitHub account:")} ${c.bold(setTo)}`);
    out(c.dim("All issue_attack commands (and the agents they spawn) will now use this account."));
    return;
  }

  // Show mode is tolerant of a broken pin so it can always help you fix it.
  const config = loadConfig(root);
  let broken = false;
  if (config.ghAccount) {
    const { code, stdout } = await exec("gh", ["auth", "token", "--user", config.ghAccount]);
    if (code !== 0) {
      broken = true;
    } else {
      process.env.GH_TOKEN = stdout.trim(); // reflect the pin in the check below
    }
  }
  const effective = await gh.currentUser().catch(() => c.red("unresolvable"));
  out(`pinned:    ${config.ghAccount ?? c.dim("(none — uses gh's active account)")}${broken ? c.red(" (not logged in!)") : ""}`);
  out(`effective: ${effective}`);
  if (!config.ghAccount) {
    out(c.dim("\nPin one with: issue_attack account <login> — recommended when you have"));
    out(c.dim("multiple accounts (e.g. enterprise + personal) so agents always use the right one."));
  }
}

function clip(s, n) {
  const str = String(s ?? "");
  return str.length > n ? str.slice(0, n - 1) + "…" : str;
}

// ---- dispatch ----------------------------------------------------------------

const COMMANDS = {
  init: { fn: cmdInit, spec: { root: { type: "string" }, repo: { type: "string" } } },
  doctor: { fn: cmdDoctor, spec: { root: { type: "string" }, repo: { type: "string" } } },
  list: {
    fn: cmdList,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      label: { type: "string" }, limit: { type: "number" },
    },
  },
  run: {
    fn: cmdRun,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      model: { type: "string" }, fresh: { type: "bool" },
    },
  },
  attack: {
    fn: cmdAttack,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      label: { type: "string" }, max: { type: "number" }, watch: { type: "bool" },
      poll: { type: "number" }, limit: { type: "number" }, model: { type: "string" },
    },
  },
  resume: {
    fn: cmdRun,
    spec: {
      root: { type: "string" }, repo: { type: "string" }, model: { type: "string" },
    },
    extra: { mode: "resume" },
  },
  status: { fn: cmdStatus, spec: { root: { type: "string" }, repo: { type: "string" }, json: { type: "bool" } } },
  steer: {
    fn: cmdSteer,
    spec: { root: { type: "string" }, repo: { type: "string" } },
  },
  stop: {
    fn: cmdStop,
    spec: { root: { type: "string" }, repo: { type: "string" }, wait: { type: "bool" } },
  },
  log: {
    fn: cmdLog,
    spec: { root: { type: "string" }, repo: { type: "string" }, raw: { type: "bool" }, lines: { type: "number" } },
  },
  cleanup: {
    fn: cmdCleanup,
    spec: { root: { type: "string" }, repo: { type: "string" }, issue: { type: "number" }, purge: { type: "bool" } },
  },
  page: { fn: cmdPage, spec: { root: { type: "string" }, repo: { type: "string" }, force: { type: "bool" } } },
  new: {
    fn: cmdNew,
    spec: {
      root: { type: "string" }, repo: { type: "string" },
      body: { type: "string" }, bodyFile: { type: "string" },
      label: { type: "string" }, noReady: { type: "bool" },
    },
  },
  account: { fn: cmdAccount, spec: { root: { type: "string" }, repo: { type: "string" } } },
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
