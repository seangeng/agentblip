import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { watch } from "chokidar";
import { z } from "zod";
import type { SessionEvent } from "@agentblip/core";

export const CODEX_NOTIFY_LINE = 'notify = ["agentblip", "hook", "codex"]';
const MAX_ACTIVITY_LEN = 60;

export function codexConfigPath(): string {
  return path.join(os.homedir(), ".codex", "config.toml");
}

export function codexSessionsDir(): string {
  return path.join(os.homedir(), ".codex", "sessions");
}

const notifySchema = z.looseObject({ type: z.string() });

function pickString(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}

/** Maps the JSON argument Codex passes to its notify hook. Only turn completion maps. */
export function mapNotifyArg(argvJson: string, fallbackNow = Date.now()): SessionEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(argvJson) as unknown;
  } catch {
    return null;
  }
  const parsed = notifySchema.safeParse(raw);
  if (!parsed.success || parsed.data.type !== "agent-turn-complete") return null;
  const data = parsed.data as Record<string, unknown>;
  const sessionId =
    pickString(data["thread-id"]) ?? pickString(data["turn-id"]) ?? "codex";
  const message = pickString(data["last-assistant-message"]);
  const collapsed = message?.replace(/\s+/g, " ").trim();
  const activity =
    collapsed && collapsed.length > MAX_ACTIVITY_LEN
      ? `${collapsed.slice(0, MAX_ACTIVITY_LEN - 1)}…`
      : collapsed;
  return {
    source: "codex",
    sessionId: sessionId.slice(0, 128),
    kind: "idle",
    activity: activity || undefined,
    ts: fallbackNow,
  };
}

export type CodexInstallResult = "installed" | "already-installed" | "manual";

/**
 * Adds the agentblip notify hook to ~/.codex/config.toml. If a notify key
 * already exists we never rewrite it — the user gets manual instructions.
 */
export function installCodexNotify(configPath = codexConfigPath()): CodexInstallResult {
  let text = "";
  if (fs.existsSync(configPath)) text = fs.readFileSync(configPath, "utf8");
  if (/^\s*notify\s*=/m.test(text)) {
    return text.includes("agentblip") ? "already-installed" : "manual";
  }
  const block = `# agentblip: surface Codex turns in your Slack status\n${CODEX_NOTIFY_LINE}\n`;
  // `notify` must be top-level TOML: if the file has [table] sections, appending
  // would land the key inside the last table — prepend instead.
  const next = /^\s*\[/m.test(text)
    ? `${block}\n${text}`
    : text
      ? `${text.replace(/\n*$/, "\n")}\n${block}`
      : block;
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, next);
  return "installed";
}

export function isCodexNotifyInstalled(configPath = codexConfigPath()): boolean {
  try {
    const text = fs.readFileSync(configPath, "utf8");
    return /^\s*notify\s*=.*agentblip/m.test(text);
  } catch {
    return false;
  }
}

export interface CodexWatcher {
  close(): Promise<void>;
}

/**
 * Watches the Codex sessions dir: rollout .jsonl writes mean a session is
 * actively working. Turn completion (idle) arrives via the notify hook.
 */
export function createCodexWatcher(
  dir: string,
  onEvent: (event: SessionEvent) => void,
): CodexWatcher {
  const watcher = watch(dir, { ignoreInitial: true, persistent: true });
  const emit = (file: string): void => {
    if (!file.endsWith(".jsonl")) return;
    onEvent({
      source: "codex",
      sessionId: path.basename(file, ".jsonl").slice(0, 128),
      kind: "working",
      ts: Date.now(),
    });
  };
  watcher.on("add", emit);
  watcher.on("change", emit);
  watcher.on("error", () => {
    // transient fs errors must never take the daemon down
  });
  return { close: () => watcher.close() };
}
