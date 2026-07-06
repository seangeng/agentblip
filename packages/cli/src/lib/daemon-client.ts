import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { SessionEvent, SlackStatus, StatusSnapshot } from "@agentblip/core";
import type { Config } from "./config";
import { readDaemonSecret } from "./daemon-auth";
import { logFilePath, spawnLockPath, startFailedMarkerPath, stateDir } from "./paths";
import { sleep } from "./ui";

export const REQUEST_TIMEOUT_MS = 1500;
const SPAWN_LOCK_STALE_MS = 15_000;
const START_WAIT_MS = 5000;
/** After a failed autostart, don't re-spawn (5s of dead hook time) for this long. */
export const START_FAILURE_COOLDOWN_MS = 60_000;

export interface DaemonState {
  snapshot: StatusSnapshot;
  formatted: SlackStatus | null;
  paused: boolean;
  lastError?: string;
}

export interface DaemonHealth {
  ok: boolean;
  pid: number;
  uptimeSec: number;
  lastError?: string;
}

async function daemonFetch<T>(
  port: number,
  pathname: string,
  method: "GET" | "POST" = "GET",
  body?: unknown,
): Promise<T> {
  // Re-read per request: a restarted daemon rotates its secret.
  const secret = readDaemonSecret();
  const res = await fetch(`http://127.0.0.1:${port}${pathname}`, {
    method,
    headers: {
      ...(secret === undefined ? {} : { authorization: `Bearer ${secret}` }),
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) {
    let detail = "";
    try {
      const parsed = (await res.json()) as { error?: string };
      if (parsed.error) detail = `: ${parsed.error}`;
    } catch {
      // non-JSON error body
    }
    throw new Error(`daemon responded ${res.status} for ${method} ${pathname}${detail}`);
  }
  return (await res.json()) as T;
}

export function postEvent(port: number, event: SessionEvent): Promise<{ ok: boolean }> {
  return daemonFetch(port, "/event", "POST", event);
}

export function getState(port: number): Promise<DaemonState> {
  return daemonFetch(port, "/state");
}

export function pauseDaemon(port: number): Promise<{ ok: boolean; paused: boolean }> {
  return daemonFetch(port, "/pause", "POST");
}

export function resumeDaemon(port: number): Promise<{ ok: boolean; paused: boolean }> {
  return daemonFetch(port, "/resume", "POST");
}

export function getHealth(port: number): Promise<DaemonHealth> {
  return daemonFetch(port, "/health");
}

export async function isDaemonUp(port: number): Promise<boolean> {
  try {
    return (await getHealth(port)).ok;
  } catch {
    return false;
  }
}

function acquireSpawnLock(): boolean {
  const lock = spawnLockPath();
  fs.mkdirSync(path.dirname(lock), { recursive: true });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(lock, "wx");
      fs.writeSync(fd, String(process.pid));
      fs.closeSync(fd);
      return true;
    } catch {
      try {
        const age = Date.now() - fs.statSync(lock).mtimeMs;
        if (age > SPAWN_LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue; // stale lock removed — retry the exclusive open
        }
      } catch {
        continue; // lock vanished between open and stat — retry
      }
      return false; // fresh lock held by another process
    }
  }
  return false;
}

function releaseSpawnLock(): void {
  try {
    fs.unlinkSync(spawnLockPath());
  } catch {
    // already gone
  }
}

async function waitForHealth(port: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonUp(port)) return true;
    await sleep(250);
  }
  return false;
}

function recordStartFailure(): void {
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), `${Date.now()}\n`);
  } catch {
    // best effort — worst case hooks keep retrying
  }
}

function clearStartFailure(): void {
  try {
    fs.unlinkSync(startFailedMarkerPath());
  } catch {
    // already gone
  }
}

/** True while a recent failed autostart means re-spawning would just burn 5s. */
export function inStartFailureCooldown(now = Date.now()): boolean {
  try {
    const ts = Number.parseInt(
      fs.readFileSync(startFailedMarkerPath(), "utf8").trim(),
      10,
    );
    return Number.isFinite(ts) && now - ts < START_FAILURE_COOLDOWN_MS;
  } catch {
    return false;
  }
}

/**
 * Cheap pre-flight: a daemon whose sink can't be created dies instantly in
 * createSink — don't spawn one just to watch it crash for 5 seconds.
 */
export function sinkConfigured(config: Config): boolean {
  if (config.mode === "relay") return Boolean(config.deviceToken);
  if (config.mode === "slack") return Boolean(config.slackToken);
  return true;
}

/**
 * Spawns `agentblip start` detached, logging to the state dir. A lockfile
 * guards against concurrent hooks racing to start multiple daemons. Failed
 * starts leave a cooldown marker so hooks stop re-spawning a crashing daemon.
 */
export async function spawnDetachedDaemon(config: Config): Promise<boolean> {
  if (!acquireSpawnLock()) return waitForHealth(config.port, START_WAIT_MS);
  let up = false;
  try {
    fs.mkdirSync(stateDir(), { recursive: true });
    const out = fs.openSync(logFilePath(), "a");
    // import.meta.url is the bundled CLI entry (dist/index.js) at runtime.
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "start"], {
      detached: true,
      stdio: ["ignore", out, out],
    });
    child.on("error", () => {});
    child.unref();
    fs.closeSync(out);
    up = await waitForHealth(config.port, START_WAIT_MS);
    return up;
  } finally {
    if (up) clearStartFailure();
    else recordStartFailure();
    releaseSpawnLock();
  }
}

/** Returns true when the daemon is reachable, auto-starting it if configured. */
export async function ensureDaemon(config: Config): Promise<boolean> {
  if (await isDaemonUp(config.port)) return true;
  if (!config.autoStartDaemon) return false;
  if (!sinkConfigured(config)) return false;
  if (inStartFailureCooldown()) return false;
  return spawnDetachedDaemon(config);
}
