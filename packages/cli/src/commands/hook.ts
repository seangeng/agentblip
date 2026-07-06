import { sessionEventSchema } from "@agentblip/core";
import type { SessionEvent } from "@agentblip/core";
import { mapHookInput } from "../adapters/claude-code";
import { mapNotifyArg } from "../adapters/codex";
import { loadConfigSafe } from "../lib/config";
import { ensureDaemon, postEvent } from "../lib/daemon-client";

const STDIN_TIMEOUT_MS = 1000;

function readStdin(timeoutMs: number): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve("");
      return;
    }
    let data = "";
    const timer = setTimeout(() => resolve(data), timeoutMs);
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk: string) => {
      data += chunk;
    });
    process.stdin.on("end", () => {
      clearTimeout(timer);
      resolve(data);
    });
    process.stdin.on("error", () => {
      clearTimeout(timer);
      resolve(data);
    });
  });
}

/**
 * Adapter entrypoint installed into agent hooks. It must NEVER break the host
 * agent session: every error is swallowed and the process always exits 0.
 */
export async function runHook(source: string, payload?: string): Promise<void> {
  try {
    let event: SessionEvent | null = null;
    if (source === "claude-code") {
      const raw = await readStdin(STDIN_TIMEOUT_MS);
      if (!raw.trim()) return;
      event = mapHookInput(JSON.parse(raw) as unknown);
    } else if (source === "codex") {
      const raw = payload ?? (await readStdin(STDIN_TIMEOUT_MS));
      if (!raw.trim()) return;
      event = mapNotifyArg(raw);
    } else {
      // custom source: payload/stdin is a raw SessionEvent JSON
      const raw = payload ?? (await readStdin(STDIN_TIMEOUT_MS));
      if (!raw.trim()) return;
      const parsed = sessionEventSchema.safeParse(JSON.parse(raw) as unknown);
      event = parsed.success ? parsed.data : null;
    }
    if (!event) return;
    const config = loadConfigSafe();
    if (!(await ensureDaemon(config))) return;
    await postEvent(config.port, event);
  } catch {
    // swallow everything — exit 0 below
  } finally {
    process.exit(0);
  }
}
