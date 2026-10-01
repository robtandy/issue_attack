// Live model verification: a minimal pi RPC session making a one-word call
// through the exact machinery workers use — same spawn shape, same set_model,
// same credential pipeline. Catches broken credentials (missing CLI, expired
// logins, gpg-homedir mismatches, wrong auth headers), unresolvable models,
// and provider outages BEFORE a run claims an issue and burns attempts.
// Cost: one tiny completion.

import { PiClient } from "./pi-client.js";
import { parseModelSpec, resolveModelSpec, finalErrorFromAgentEnd } from "./runner.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Verify a model spec end-to-end with a minimal live call.
 * @returns {{ok: boolean, error?: string|null, text?: string|null}}
 */
export async function verifyModelWorks({ bin = "pi", cwd, modelSpec, timeoutMs = 45_000 } = {}) {
  const client = new PiClient({
    bin,
    args: ["--mode", "rpc", "--no-session", "-ne", "--model", modelSpec],
    cwd,
    env: {
      PI_SKIP_VERSION_CHECK: "1",
      // Providers commonly tag requests with $PI_CLIENT_SESSION_ID. pi injects
      // it for real sessions, but this probe deliberately runs --no-session
      // (no session files) — provide a synthetic id so env-referencing
      // provider headers resolve. (Without this, the probe false-negatives
      // on exactly the providers that tag requests.)
      PI_CLIENT_SESSION_ID: "ia-model-verify",
    },
  });
  let agentError = null;
  client.onRecord = (rec) => {
    const e = finalErrorFromAgentEnd(rec);
    if (e) agentError = e;
  };
  try {
    await client.start();

    // Apply the spec explicitly, exactly like the workers do — also
    // validates that the spec resolves in pi's catalog.
    const { modelPart, level } = parseModelSpec(modelSpec);
    const models = await client.availableModels();
    const resolved = resolveModelSpec(modelPart, models);
    if (!resolved) return { ok: false, error: `no configured model matches "${modelPart}"` };
    await client.setModel(resolved.provider, resolved.id);
    if (level) await client.setThinkingLevel(level).catch(() => {});

    // The effective thinking level: explicit suffix, else pi's default for
    // this model (reported by get_state) — so announcements always show
    // what will actually run, even when the spec doesn't pin a level.
    const st0 = await client.getState().catch(() => null);
    const effectiveThinking = level ?? st0?.thinkingLevel ?? null;

    await client.message("Reply with exactly: OK");
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await sleep(1_500);
      if (agentError) return { ok: false, error: agentError };
      if (client.exitInfo) return { ok: false, error: `pi exited unexpectedly (code=${client.exitInfo.code})` };
      if (client.settledCount > 0) {
        const st = await client.getState().catch(() => null);
        if (!st || (!st.isStreaming && (st.pendingMessageCount ?? 0) === 0)) {
          const text = await client.lastAssistantText().catch(() => null);
          if (text && text.trim()) {
            return { ok: true, text, model: `${resolved.provider}/${resolved.id}`, thinking: effectiveThinking };
          }
          return { ok: false, error: "model call settled without any output" };
        }
      }
    }
    await client.abort().catch(() => {});
    return { ok: false, error: "model verification timed out" };
  } finally {
    await client.close().catch(() => {});
  }
}
