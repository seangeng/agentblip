import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";

/**
 * Grok Bot watcher adapter (SPEC §62): monitors `~/.grokbot/local-exec-daemon.json`
 * (written by `Grok Bot.app` on macOS) and optional `~/agent-bus/inbox/` Grok dispatches
 * so active Grok Bot work appears in Workmesh, Workmesh.app, Slack (`agentblip`), and
 * `studio-pixbar`. Degrades cleanly to a no-op when Grok Bot is not installed or stopped.
 */

export interface GrokWatcher {
  stop(): void;
}

export interface GrokWatcherOptions {
  dir?: string;
  intervalMs?: number;
  freshWindowMs?: number;
  idleWindowMs?: number;
  onEvent: (event: SessionEvent) => void;
  log?: (message: string) => void;
}

export function defaultGrokDir(home = os.homedir()): string {
  return path.join(home, ".grokbot");
}

interface GrokDaemonState {
  pid?: number;
  startedAt?: number;
  servingAt?: number;
  inflightCount?: number;
}

function pidAlive(pid: number | undefined): boolean {
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function readGrokDaemonState(dir: string): GrokDaemonState | undefined {
  const file = path.join(dir, "local-exec-daemon.json");
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return parsed && typeof parsed === "object" ? (parsed as GrokDaemonState) : undefined;
  } catch {
    return undefined;
  }
}

export function createGrokWatcher(opts: GrokWatcherOptions): GrokWatcher {
  const dir = opts.dir ?? defaultGrokDir();
  const intervalMs = opts.intervalMs ?? 5000;
  const freshWindowMs = opts.freshWindowMs ?? 3 * 60_000;
  const idleWindowMs = opts.idleWindowMs ?? 15 * 60_000;
  const heartbeatIntervalMs = 60_000;
  const sessionId = "grok-bot";
  let prev: { kind: "working" | "idle"; inflight: number; lastEmitMs: number } | undefined;
  let stopped = false;
  let loggedStart = false;

  const tick = (): void => {
    if (stopped) return;
    const state = readGrokDaemonState(dir);
    if (!state) {
      if (prev) {
        prev = undefined;
        opts.onEvent({ source: "grok", sessionId, kind: "end", ts: Date.now() });
      }
      return;
    }
    if (!loggedStart) {
      loggedStart = true;
      opts.log?.(`watching Grok Bot state in ${dir}`);
    }
    const now = Date.now();
    const servingAt = typeof state.servingAt === "number" ? state.servingAt : 0;
    const inflight = typeof state.inflightCount === "number" && state.inflightCount > 0 ? Math.floor(state.inflightCount) : 0;
    const alive = pidAlive(state.pid) && (servingAt === 0 || now - servingAt <= idleWindowMs);

    if (!alive) {
      if (prev) {
        prev = undefined;
        opts.onEvent({ source: "grok", sessionId, kind: "end", ts: now });
      }
      return;
    }

    const isWorking = inflight > 0 && (servingAt === 0 || now - servingAt <= freshWindowMs);
    const kind: "working" | "idle" = isWorking ? "working" : "idle";
    const changed = !prev || prev.kind !== kind || prev.inflight !== inflight;
    const needsHeartbeat = isWorking && prev !== undefined && now - prev.lastEmitMs >= heartbeatIntervalMs;
    if (!changed && !needsHeartbeat) return;

    prev = { kind, inflight, lastEmitMs: now };
    opts.onEvent({
      source: "grok",
      sessionId,
      kind,
      name: "Grok Bot",
      project: "grok-bot",
      ...(isWorking
        ? {
            activity: inflight > 1 ? `running ${inflight} local tools` : "running local tool",
            ...(inflight > 1 ? { agents: inflight } : {}),
          }
        : {}),
      ts: isWorking ? now : servingAt || now,
    });
  };

  const timer = setInterval(tick, intervalMs);
  timer.unref?.();
  tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
