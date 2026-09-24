// Minimal pi RPC client: spawns `pi --mode rpc` and speaks the JSONL protocol.
//
// Protocol notes (pi docs: rpc.md / json.md):
// - Strict LF framing; Node's readline is unsuitable (splits on U+2028/2029),
//   so we buffer and split on "\n" ourselves.
// - Commands carry ids; responses repeat them. Events arrive interleaved.
// - `agent_settled` means no automatic work remains for the run.

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";

export class PiClient {
  /**
   * @param {{bin?: string, args?: string[], cwd?: string, env?: Record<string,string>,
   *          onRecord?: (rec: any) => void, onExit?: (info: {code: number|null, signal: string|null}) => void}} opts
   */
  constructor(opts = {}) {
    this.bin = opts.bin ?? "pi";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env ?? {};
    this.onRecord = opts.onRecord ?? null;
    this.onStderr = opts.onStderr ?? null;
    this.onExit = opts.onExit ?? null;

    this.child = null;
    this.buf = "";
    this.pending = new Map(); // id -> {resolve, reject, timer}
    this.settledCount = 0;
    this.lastUsage = null;
    this.exitInfo = null;
  }

  async start() {
    if (this.exitInfo) throw new Error("pi process already exited");
    return new Promise((resolve, reject) => {
      const child = spawn(this.bin, ["--mode", "rpc", ...this.args], {
        cwd: this.cwd,
        env: { ...process.env, ...this.env },
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.child = child;

      const failTimer = setTimeout(() => {
        if (this.exitInfo || child.exitCode !== null) return;
        reject(new Error(`pi (${this.bin}) did not spawn within 20s`));
        this.kill();
      }, 20_000);

      child.on("error", (err) => {
        clearTimeout(failTimer);
        reject(new Error(`failed to start pi (${this.bin}): ${err.message}`));
      });
      child.on("spawn", () => {
        clearTimeout(failTimer);
        resolve();
      });

      child.stdout.setEncoding("utf8");
      child.stdout.on("data", (chunk) => this.#feed(chunk));
      child.stderr.setEncoding("utf8");
      child.stderr.on("data", (chunk) => this.onStderr?.(chunk));

      child.on("exit", (code, signal) => {
        this.exitInfo = { code, signal };
        const err = new Error(`pi exited unexpectedly (code=${code} signal=${signal})`);
        for (const { reject: rj, timer } of this.pending.values()) {
          clearTimeout(timer);
          rj(err);
        }
        this.pending.clear();
        this.onExit?.(this.exitInfo);
      });
    });
  }

  #feed(chunk) {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = line.trim();
      if (!line) continue;
      let rec;
      try {
        rec = JSON.parse(line);
      } catch {
        continue; // tolerate partial noise; strict framing means this is a bug guard
      }
      this.#handle(rec);
    }
  }

  #handle(rec) {
    this.onRecord?.(rec);

    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id);
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      if (rec.success) p.resolve(rec.data ?? {});
      else p.reject(new Error(`pi command '${rec.command}' failed: ${rec.error ?? "unknown error"}`));
      return;
    }

    switch (rec.type) {
      case "agent_settled":
        this.settledCount++;
        break;
      case "message_update":
        if (rec.usage) this.lastUsage = rec.usage;
        break;
      default:
        break;
    }
  }

  /** Send a command; resolves with its response data. */
  send(command, timeoutMs = 60_000) {
    if (this.exitInfo) return Promise.reject(new Error("pi process exited"));
    const id = randomUUID();
    const json = JSON.stringify({ id, ...command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out after ${timeoutMs}ms: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(json + "\n", (err) => err && reject(err));
    });
  }

  async getState() {
    return this.send({ type: "get_state" }, 30_000);
  }

  /** Send a user message; steers when mid-run, starts/continues when idle. */
  async message(text) {
    const st = await this.getState();
    if (st.isStreaming) {
      return this.send({ type: "prompt", message: text, streamingBehavior: "steer" });
    }
    return this.send({ type: "prompt", message: text });
  }

  /** Send guidance that must not interrupt the current run. */
  async followUp(text) {
    return this.send({ type: "follow_up", message: text });
  }

  async abort() {
    return this.send({ type: "abort" }, 300_000);
  }

  async stats() {
    return this.send({ type: "get_session_stats" }, 60_000);
  }

  /** Switch the (possibly resumed) session to a specific model. */
  async setModel(provider, modelId) {
    return this.send({ type: "set_model", provider, modelId }, 15_000);
  }

  /** Set reasoning level: off|minimal|low|medium|high|xhigh|max. */
  async setThinkingLevel(level) {
    return this.send({ type: "set_thinking_level", level }, 15_000);
  }

  /** All configured models ({id, name, provider, ...}). */
  async availableModels() {
    const data = await this.send({ type: "get_available_models" }, 30_000);
    return data?.models ?? [];
  }

  async lastAssistantText() {
    const data = await this.send({ type: "get_last_assistant_text" }, 30_000);
    return data?.text ?? null;
  }

  /** Graceful shutdown: close stdin, escalate to SIGTERM/SIGKILL. */
  async close() {
    if (!this.child || this.exitInfo) return this.exitInfo;
    const exited = new Promise((resolve) => this.child.once("exit", resolve));
    try {
      this.child.stdin.end();
    } catch {
      /* already closed */
    }
    const term = setTimeout(() => this.child.kill("SIGTERM"), 5_000);
    const kill = setTimeout(() => this.child.kill("SIGKILL"), 15_000);
    const info = await Promise.race([exited, sleep(20_000).then(() => null)]);
    clearTimeout(term);
    clearTimeout(kill);
    return info ?? this.exitInfo;
  }

  kill() {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
