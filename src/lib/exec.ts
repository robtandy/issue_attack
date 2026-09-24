// Subprocess helper: spawn, capture stdout/stderr, optional stdin, timeout.

import { spawn } from "node:child_process";

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface ExecOptions {
  cwd?: string;
  input?: string;
  timeoutMs?: number;
  env?: Record<string, string>;
}

export async function exec(
  cmd: string,
  args: string[],
  opts: ExecOptions = {}
): Promise<ExecResult> {
  const { cwd, input, timeoutMs = 120_000, env } = opts;
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      env: env ? { ...process.env, ...env } : process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, timeoutMs);

    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (c: string) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c: string) => (stderr += c));

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on("error", (err: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code: number | null, signal: string | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) {
        reject(new Error(`${cmd} timed out after ${timeoutMs}ms`));
      } else {
        resolve({ code: code ?? -1, stdout, stderr });
      }
    });
  });
}

/** Run a command; reject with stderr message on nonzero exit. Returns stdout. */
export async function must(cmd: string, args: string[], opts: ExecOptions = {}): Promise<string> {
  const { code, stdout, stderr } = await exec(cmd, args, opts);
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${code}):\n${stderr.trim() || stdout.trim()}`
    );
  }
  return stdout;
}

/** Binary-existence check. */
export async function which(bin: string): Promise<boolean> {
  const { code } = await exec("/bin/sh", ["-c", `command -v ${bin} >/dev/null 2>&1`], {
    timeoutMs: 5_000,
  });
  return code === 0;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
