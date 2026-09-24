// Subprocess helper: spawn, capture stdout/stderr, optional stdin, timeout.

import { spawn } from "node:child_process";

/**
 * @param {string} cmd
 * @param {string[]} args
 * @param {{cwd?: string, input?: string, timeoutMs?: number, env?: Record<string,string>}} opts
 * @returns {Promise<{code: number, stdout: string, stderr: string}>}
 */
export async function exec(cmd, args, opts = {}) {
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
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (c) => (stderr += c));

    if (input !== undefined) {
      child.stdin.write(input);
    }
    child.stdin.end();

    child.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code, signal) => {
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
export async function must(cmd, args, opts = {}) {
  const { code, stdout, stderr } = await exec(cmd, args, opts);
  if (code !== 0) {
    throw new Error(
      `${cmd} ${args.join(" ")} failed (exit ${code}):\n${stderr.trim() || stdout.trim()}`
    );
  }
  return stdout;
}

/** Binary-existence check. */
export async function which(bin) {
  const { code } = await exec("/bin/sh", ["-c", `command -v ${bin} >/dev/null 2>&1`], {
    timeoutMs: 5_000,
  });
  return code === 0;
}

export function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}
