import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { watch } from "chokidar";
import { z } from "zod";
import type { SessionEvent } from "@agentblip/core";

const MAX_ACTIVITY_LEN = 60;

/**
 * Absolute notify invocation: GUI-launched agents don't inherit the login-shell
 * PATH, so a bare `agentblip` may not resolve. import.meta.url is the bundled
 * CLI entry (dist/index.js) at runtime; JSON strings are valid TOML strings.
 */
export function codexNotifyLine(): string {
  const entry = fileURLToPath(import.meta.url);
  return `notify = [${JSON.stringify(process.execPath)}, ${JSON.stringify(entry)}, "hook", "codex"]`;
}

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
  const block = `# agentblip: surface Codex turns in your Slack status\n${codexNotifyLine()}\n`;
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

const UUID_RE = /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/**
 * Rollout files are `rollout-<timestamp>-<uuid>.jsonl` while the notify hook
 * keys sessions by the bare thread uuid — extract the trailing uuid so both
 * paths land on the same `codex:<uuid>` session. Falls back to the basename.
 */
export function rolloutSessionId(file: string): string {
  const base = path.basename(file, ".jsonl");
  return (UUID_RE.exec(base)?.[0] ?? base).slice(0, 128);
}

/** Rollouts silent for longer than this can't be a live session. */
const MAX_ROLLOUT_AGE_MS = 48 * 60 * 60 * 1000;

/**
 * chokidar `ignored` filter: Codex keeps every rollout ever under YYYY/MM/DD,
 * so skip stale files instead of holding an fs watch per historical session
 * (months of use would exhaust inotify/fd limits).
 */
export function isIgnoredRollout(file: string, stats?: fs.Stats): boolean {
  if (!stats?.isFile()) return false;
  if (!file.endsWith(".jsonl")) return true;
  return Date.now() - stats.mtimeMs > MAX_ROLLOUT_AGE_MS;
}

/**
 * Watches the Codex sessions dir: rollout .jsonl writes mean a session is
 * actively working. Turn completion (idle) arrives via the notify hook.
 */
export function createCodexWatcher(
  dir: string,
  onEvent: (event: SessionEvent) => void,
  log: (message: string) => void = () => {},
): CodexWatcher {
  const watcher = watch(dir, {
    ignoreInitial: true,
    persistent: true,
    ignored: isIgnoredRollout,
  });
  const emit = (file: string): void => {
    if (!file.endsWith(".jsonl")) return;
    onEvent({
      source: "codex",
      sessionId: rolloutSessionId(file),
      kind: "working",
      ts: Date.now(),
    });
  };
  watcher.on("add", emit);
  watcher.on("change", emit);
  watcher.on("error", (err) => {
    // transient fs errors must never take the daemon down — but say so
    log(`codex watcher error: ${err instanceof Error ? err.message : String(err)}`);
  });
  return { close: () => watcher.close() };
}
