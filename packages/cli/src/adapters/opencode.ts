import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";

/**
 * OpenCode adapter: polls `~/.local/share/opencode/opencode.db` read-only via `sqlite3`
 * so OpenCode sessions (e.g. DeepSeek API runs) automatically appear in Workmesh, Slack
 * (`agentblip`), and `studio-pixbar` with zero extra native dependencies.
 */

export interface OpenCodeWatcher {
  stop(): void;
}

export interface OpenCodeWatcherOptions {
  dbPath?: string;
  intervalMs?: number;
  activeWindowMs?: number;
  onEvent: (event: SessionEvent) => void;
  log?: (message: string) => void;
}

export function defaultOpenCodeDbPath(home = os.homedir()): string {
  return path.join(home, ".local", "share", "opencode", "opencode.db");
}

interface RawOpenCodeRow {
  id: string;
  directory?: string;
  title?: string;
  model?: string;
  time_created?: number;
  time_updated?: number;
  time_busy?: number;
  time_idle?: number;
  time_archived?: number | null;
}

function queryOpenCodeDb(dbPath: string): Promise<RawOpenCodeRow[] | null> {
  return new Promise((resolve) => {
    const sql =
      "SELECT id, directory, title, model, time_created, time_updated, time_busy, time_idle, time_archived " +
      "FROM session_v2 WHERE time_archived IS NULL ORDER BY time_updated DESC LIMIT 20;";
    execFile(
      "sqlite3",
      ["-readonly", "-json", "-cmd", ".timeout 1000", dbPath, sql],
      { timeout: 3000, maxBuffer: 512 * 1024 },
      (err, stdout) => {
        if (err) {
          resolve(null);
          return;
        }
        if (!stdout.trim()) {
          resolve([]);
          return;
        }
        try {
          const parsed = JSON.parse(stdout) as unknown;
          resolve(Array.isArray(parsed) ? (parsed as RawOpenCodeRow[]) : null);
        } catch {
          resolve(null);
        }
      },
    );
  });
}

function modelLabel(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  try {
    const p = JSON.parse(raw) as { id?: string; providerID?: string };
    if (p?.id) return p.id;
  } catch {
    // plain string
  }
  return raw;
}

export function createOpenCodeWatcher(opts: OpenCodeWatcherOptions): OpenCodeWatcher {
  const dbPath = opts.dbPath ?? defaultOpenCodeDbPath();
  const intervalMs = opts.intervalMs ?? 5000;
  const activeWindowMs = opts.activeWindowMs ?? 3 * 60_000;
  const seen = new Map<string, { state: "working" | "idle"; updatedAt: number }>();
  let stopped = false;
  let inFlight = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    if (!fs.existsSync(dbPath)) return;
    inFlight = true;
    try {
      const rows = await queryOpenCodeDb(dbPath);
      if (rows === null) return;
      const now = Date.now();
      const alive = new Set<string>();
      for (const r of rows) {
        if (!r?.id) continue;
        const updated = Number(r.time_updated || 0);
        const busy = Number(r.time_busy || 0);
        const idle = Number(r.time_idle || 0);
        const isWorking = busy > idle && now - Math.max(busy, updated) < activeWindowMs;
        const isRecent = now - updated < 30 * 60_000;
        if (!isWorking && !isRecent) continue;
        alive.add(r.id);
        const state: "working" | "idle" = isWorking ? "working" : "idle";
        const prev = seen.get(r.id);
        if (prev && prev.state === state && prev.updatedAt === updated) continue;
        seen.set(r.id, { state, updatedAt: updated });
        const model = modelLabel(r.model);
        const project = r.directory ? path.basename(r.directory) : undefined;
        const activity = isWorking
          ? (r.title ? r.title.slice(0, 80) : model ? `running ${model}` : "working")
          : undefined;
        opts.onEvent({
          source: "opencode",
          sessionId: r.id,
          kind: isWorking ? "working" : "idle",
          ...(r.directory ? { cwd: r.directory } : {}),
          ...(project ? { project } : {}),
          ...(r.title ? { name: r.title.slice(0, 80) } : {}),
          ...(activity ? { activity } : {}),
          ts: updated || now,
        });
      }
      for (const [id] of seen) {
        if (!alive.has(id)) {
          seen.delete(id);
          opts.onEvent({ source: "opencode", sessionId: id, kind: "end", ts: now });
        }
      }
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void tick(), intervalMs);
  timer.unref?.();
  void tick();

  return {
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
