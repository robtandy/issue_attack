// Minimal pi RPC client: spawns `pi --mode rpc` and speaks the JSONL protocol.
//
// Protocol notes (pi docs: rpc.md / json.md):
// - Strict LF framing; Node's readline is unsuitable (splits on U+2028/2029),
//   so we buffer and split on "\n" ourselves.
// - Commands carry ids; responses repeat them. Events arrive interleaved.
// - `agent_settled` means no automatic work remains for the run.

import { spawn, ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";

/** One JSONL record from the pi event stream (event or response). */
export interface PiRecord {
  type: string;
  id?: string;
  success?: boolean;
  data?: unknown;
  command?: string;
  error?: string;
  usage?: Record<string, unknown>;
  isStreaming?: boolean;
  pendingMessageCount?: number;
  /** set_state / message responses: the session's effective model. */
  model?: PiModel;
  /** message_update events carrying a text delta. */
  assistantMessageEvent?: { type: string; delta?: string };
  /** tool_execution_start events. */
  toolName?: string;
  args?: { command?: string; [key: string]: unknown };
  /** message_end events. */
  message?: { role?: string; content?: Array<{ type?: string; text?: string }> };
  [key: string]: unknown;
}

/** A configured pi model, as listed by get_available_models. */
export interface PiModel {
  id: string;
  name?: string;
  provider?: string;
}

export interface PiState {
  isStreaming?: boolean;
  pendingMessageCount?: number;
  model?: PiModel;
  [key: string]: unknown;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
  timer: NodeJS.Timeout;
}

export interface PiClientOptions {
  bin?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  onRecord?: (rec: PiRecord) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (info: { code: number | null; signal: string | null }) => void;
}

export interface ExitInfo {
  code: number | null;
  signal: string | null;
}

export class PiClient {
  bin: string;
  args: string[];
  cwd?: string;
  env: Record<string, string>;
  onRecord?: (rec: PiRecord) => void;
  onStderr?: (chunk: string) => void;
  onExit?: (info: ExitInfo) => void;

  child: ChildProcess | null = null;
  private buf = "";
  private pending = new Map<string, PendingRequest>();
  settledCount = 0;
  lastUsage: Record<string, unknown> | null = null;
  exitInfo: ExitInfo | null = null;

  constructor(opts: PiClientOptions = {}) {
    this.bin = opts.bin ?? "pi";
    this.args = opts.args ?? [];
    this.cwd = opts.cwd;
    this.env = opts.env ?? {};
    this.onRecord = opts.onRecord;
    this.onStderr = opts.onStderr;
    this.onExit = opts.onExit;
  }

  async start(): Promise<void> {
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

      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => this.feed(chunk));
      child.stderr!.setEncoding("utf8");
      child.stderr!.on("data", (chunk: string) => this.onStderr?.(chunk));

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

  private feed(chunk: string): void {
    this.buf += chunk;
    let idx;
    while ((idx = this.buf.indexOf("\n")) !== -1) {
      let line = this.buf.slice(0, idx);
      this.buf = this.buf.slice(idx + 1);
      if (line.endsWith("\r")) line = line.slice(0, -1);
      line = line.trim();
      if (!line) continue;
      let rec: PiRecord;
      try {
        rec = JSON.parse(line) as PiRecord;
      } catch {
        continue; // tolerate partial noise; strict framing means this is a bug guard
      }
      this.handle(rec);
    }
  }

  private handle(rec: PiRecord): void {
    this.onRecord?.(rec);

    if (rec.type === "response" && rec.id && this.pending.has(rec.id)) {
      const p = this.pending.get(rec.id)!;
      this.pending.delete(rec.id);
      clearTimeout(p.timer);
      if (rec.success) p.resolve(rec.data ?? {});
      else
        p.reject(
          new Error(`pi command '${rec.command}' failed: ${rec.error ?? "unknown error"}`)
        );
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
  send(command: Record<string, unknown>, timeoutMs = 60_000): Promise<unknown> {
    if (this.exitInfo) return Promise.reject(new Error("pi process exited"));
    const id = randomUUID();
    const json = JSON.stringify({ id, ...command });
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`pi command timed out after ${timeoutMs}ms: ${command.type}`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child!.stdin!.write(json + "\n", (err) => err && reject(err));
    });
  }

  async getState(): Promise<PiState> {
    return (await this.send({ type: "get_state" }, 30_000)) as PiState;
  }

  /** Send a user message; steers when mid-run, starts/continues when idle. */
  async message(text: string): Promise<unknown> {
    const st = await this.getState();
    if (st.isStreaming) {
      return this.send({ type: "prompt", message: text, streamingBehavior: "steer" });
    }
    return this.send({ type: "prompt", message: text });
  }

  /** Send guidance that must not interrupt the current run. */
  async followUp(text: string): Promise<unknown> {
    return this.send({ type: "follow_up", message: text });
  }

  async abort(): Promise<unknown> {
    return this.send({ type: "abort" }, 300_000);
  }

  async stats(): Promise<Record<string, unknown>> {
    return (await this.send({ type: "get_session_stats" }, 60_000)) as Record<string, unknown>;
  }

  /** Switch the (possibly resumed) session to a specific model. */
  async setModel(provider: string, modelId: string): Promise<unknown> {
    return this.send({ type: "set_model", provider, modelId }, 15_000);
  }

  /** Set reasoning level: off|minimal|low|medium|high|xhigh|max. */
  async setThinkingLevel(level: string): Promise<unknown> {
    return this.send({ type: "set_thinking_level", level }, 15_000);
  }

  /** All configured models ({id, name, provider, ...}). */
  async availableModels(): Promise<PiModel[]> {
    const data = (await this.send({ type: "get_available_models" }, 30_000)) as {
      models?: PiModel[];
    };
    return data?.models ?? [];
  }

  async lastAssistantText(): Promise<string | null> {
    const data = (await this.send({ type: "get_last_assistant_text" }, 30_000)) as {
      text?: string;
    };
    return data?.text ?? null;
  }

  /** Graceful shutdown: close stdin, escalate to SIGTERM/SIGKILL. */
  async close(): Promise<ExitInfo | null> {
    if (!this.child || this.exitInfo) return this.exitInfo;
    const child = this.child;
    const exited = new Promise<ExitInfo | null>((resolve) => child.once("exit", resolve));
    try {
      child.stdin!.end();
    } catch {
      /* already closed */
    }
    const term = setTimeout(() => child.kill("SIGTERM"), 5_000);
    const kill = setTimeout(() => child.kill("SIGKILL"), 15_000);
    const info = await Promise.race([exited, sleep(20_000).then(() => null)]);
    clearTimeout(term);
    clearTimeout(kill);
    return info ?? this.exitInfo;
  }

  kill(): void {
    try {
      this.child?.kill("SIGKILL");
    } catch {
      /* noop */
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
