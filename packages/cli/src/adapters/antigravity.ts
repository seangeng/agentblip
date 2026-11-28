import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@workmesh/core";

/**
 * Antigravity watcher adapter (SPEC §62): polls `~/.gemini/antigravity/conversation_summaries.db`
 * strictly read-only via `sqlite3` and tails the last chunk of each live conversation's
 * `brain/<id>/.system_generated/logs/transcript.jsonl` to surface live Antigravity (Gemini)
 * sessions, subagent counts, workspace repos, and rich activity in Workmesh, Workmesh.app,
 * Slack (`agentblip`), Workmesh Cloud Board, and `studio-pixbar`.
 *
 * Degrades cleanly to a no-op when Antigravity is not installed.
 */

export interface AntigravityWatcher {
  stop(): void;
}

export interface AntigravityWatcherOptions {
  dir?: string;
  intervalMs?: number;
  activeWindowMs?: number;
  idleWindowMs?: number;
  onEvent: (event: SessionEvent) => void;
  log?: (message: string) => void;
}

export function defaultAntigravityDir(home = os.homedir()): string {
  return path.join(home, ".gemini", "antigravity");
}

export interface RawAntigravityRow {
  conversation_id: string;
  title?: string;
  step_count?: number;
  last_modified_time?: string;
  workspace_uris?: string;
  status?: string;
  agent_name?: string;
  parent_conversation_id?: string;
  nesting_depth?: number;
  not_fully_idle?: number | boolean;
  killed?: number | boolean;
}

function queryAntigravityDb(dbPath: string): Promise<RawAntigravityRow[]> {
  return new Promise((resolve) => {
    const sql =
      "SELECT conversation_id, title, step_count, last_modified_time, workspace_uris, status, " +
      "agent_name, parent_conversation_id, nesting_depth, not_fully_idle, killed " +
      "FROM conversation_summaries WHERE killed = 0 ORDER BY last_modified_time DESC LIMIT 50;";
    execFile("sqlite3", ["-readonly", "-json", dbPath, sql], { timeout: 2500, maxBuffer: 1024 * 1024 }, (err, stdout) => {
      if (err || !stdout.trim()) {
        resolve([]);
        return;
      }
      try {
        const parsed = JSON.parse(stdout) as unknown;
        resolve(Array.isArray(parsed) ? (parsed as RawAntigravityRow[]) : []);
      } catch {
        resolve([]);
      }
    });
  });
}

/** Parse SQLite/RFC3339 timestamps such as `2026-11-28 17:01:56.133406+00:00`. */
export function parseAntigravityTime(raw: string | undefined): number {
  if (!raw) return 0;
  const iso = raw.includes("T") ? raw : raw.replace(" ", "T");
  const ms = Date.parse(iso);
  return Number.isFinite(ms) ? ms : 0;
}

/** Extract the first local filesystem directory from Antigravity's `workspace_uris` JSON array. */
export function parseWorkspaceCwd(raw: string | undefined): string | undefined {
  if (!raw) return undefined;
  let list: unknown;
  try {
    list = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (!Array.isArray(list)) return undefined;
  for (const item of list) {
    if (typeof item !== "string" || !item.trim()) continue;
    const s = item.trim();
    if (s.startsWith("file://")) {
      try {
        const u = new URL(s);
        const decoded = decodeURIComponent(u.pathname);
        if (decoded) return decoded;
      } catch {
        // try next
      }
    } else if (path.isAbsolute(s)) {
      return s;
    }
  }
  return undefined;
}

/** Check whether `annotations/<id>.pbtxt` marks a conversation as archived. */
function isArchivedAnnotation(baseDir: string, id: string): boolean {
  const file = path.join(baseDir, "annotations", `${id}.pbtxt`);
  try {
    const text = fs.readFileSync(file, "utf8");
    return /\barchived\s*:\s*true\b/.test(text);
  } catch {
    return false;
  }
}

const TOOL_ACTIVITY: Record<string, string> = {
  run_command: "running commands",
  edit_file: "editing files",
  write_file: "editing files",
  read_file: "reading code",
  search_web: "searching the web",
  invoke_subagent: "delegating to subagents",
  run_workflow: "running a workflow",
  call_mcp_tool: "using tools",
  ask_question: "needs my input",
};

export interface TranscriptHint {
  activity?: string;
  waiting?: boolean;
}

/**
 * Inspect only the tail (last 24 KB) of `brain/<id>/.system_generated/logs/transcript.jsonl`
 * to extract the latest `update_focus` phrase or tool-call activity without loading large files.
 */
export function readAntigravityActivity(baseDir: string, id: string): TranscriptHint {
  const file = path.join(baseDir, "brain", id, ".system_generated", "logs", "transcript.jsonl");
  let fd: number | undefined;
  try {
    const stat = fs.statSync(file);
    if (stat.size <= 0) return {};
    const bytes = Math.min(stat.size, 24 * 1024);
    const buf = Buffer.allocUnsafe(bytes);
    fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, bytes, stat.size - bytes);
    const lines = buf.toString("utf8").split("\n").filter(Boolean);
    // Walk newest-first to find the latest PLANNER_RESPONSE with tool calls or focus.
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i]!;
      if (!line.includes("PLANNER_RESPONSE")) continue;
      let obj: Record<string, unknown>;
      try {
        obj = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      if (obj.type !== "PLANNER_RESPONSE") continue;
      const calls = Array.isArray(obj.tool_calls) ? (obj.tool_calls as Array<{ name?: string; args?: Record<string, unknown> }>) : [];
      let focus: string | undefined;
      let toolAct: string | undefined;
      let waiting = false;
      for (const c of calls) {
        const name = typeof c?.name === "string" ? c.name : "";
        if (name === "ask_question") waiting = true;
        if (name === "update_focus" && c.args && typeof c.args.focus === "string") {
          let raw = c.args.focus.trim();
          if (raw.startsWith('"') && raw.endsWith('"')) {
            try {
              raw = JSON.parse(raw) as string;
            } catch {
              raw = raw.slice(1, -1);
            }
          }
          if (raw) focus = raw.slice(0, 90);
        } else if (name && TOOL_ACTIVITY[name] && !toolAct) {
          toolAct = TOOL_ACTIVITY[name];
        }
      }
      if (waiting) return { activity: "needs my input", waiting: true };
      if (focus) return { activity: focus };
      if (toolAct) return { activity: toolAct };
      return { activity: "thinking" };
    }
  } catch {
    // Transcript absent or rotating.
  } finally {
    if (fd !== undefined) {
      try {
        fs.closeSync(fd);
      } catch {
        // ignore
      }
    }
  }
  return {};
}

export function createAntigravityWatcher(opts: AntigravityWatcherOptions): AntigravityWatcher {
  const baseDir = opts.dir ?? defaultAntigravityDir();
  const dbPath = path.join(baseDir, "conversation_summaries.db");
  const intervalMs = opts.intervalMs ?? 4000;
  const activeWindowMs = opts.activeWindowMs ?? 10 * 60_000;
  const idleWindowMs = opts.idleWindowMs ?? 15 * 60_000;
  const heartbeatIntervalMs = 60_000;
  const seen = new Map<
    string,
    { kind: "working" | "waiting" | "idle"; modifiedMs: number; stepCount: number; agents: number; lastEmitMs: number }
  >();
  let stopped = false;
  let inFlight = false;
  let loggedStart = false;

  const tick = async (): Promise<void> => {
    if (stopped || inFlight) return;
    if (!fs.existsSync(dbPath)) return;
    if (!loggedStart) {
      loggedStart = true;
      opts.log?.(`watching Antigravity sessions in ${dbPath}`);
    }
    inFlight = true;
    try {
      const rows = await queryAntigravityDb(dbPath);
      const now = Date.now();

      // Count active child subagents per parent conversation.
      const activeChildren = new Map<string, number>();
      for (const r of rows) {
        const depth = Number(r.nesting_depth || 0);
        const parent = (r.parent_conversation_id || "").trim();
        if (depth <= 0 || !parent) continue;
        const modMs = parseAntigravityTime(r.last_modified_time);
        const running =
          (r.status === "CASCADE_RUN_STATUS_RUNNING" || Number(r.not_fully_idle || 0) === 1) &&
          (modMs === 0 || now - modMs <= activeWindowMs);
        if (running) {
          activeChildren.set(parent, (activeChildren.get(parent) ?? 0) + 1);
        }
      }

      const alive = new Set<string>();
      for (const r of rows) {
        const id = (r.conversation_id || "").trim();
        if (!id) continue;
        // Subagents roll into their parent's `agents` count rather than cluttering top-level rows.
        if (Number(r.nesting_depth || 0) > 0 && (r.parent_conversation_id || "").trim()) continue;
        const modMs = parseAntigravityTime(r.last_modified_time);
        const isRunningFlag = r.status === "CASCADE_RUN_STATUS_RUNNING" || Number(r.not_fully_idle || 0) === 1;
        const isWorking = isRunningFlag && (modMs === 0 || now - modMs <= activeWindowMs);
        const isRecent = modMs > 0 && now - modMs <= idleWindowMs;
        if (!isWorking && !isRecent) continue;
        if (!isWorking && isArchivedAnnotation(baseDir, id)) continue;

        alive.add(id);
        const subCount = activeChildren.get(id) ?? 0;
        const agents = 1 + subCount;
        const stepCount = Number(r.step_count || 0);
        const hint = isWorking ? readAntigravityActivity(baseDir, id) : {};
        const kind: "working" | "waiting" | "idle" = !isWorking ? "idle" : hint.waiting ? "waiting" : "working";

        const prev = seen.get(id);
        const changed =
          !prev ||
          prev.kind !== kind ||
          prev.modifiedMs !== modMs ||
          prev.stepCount !== stepCount ||
          prev.agents !== agents;
        const needsHeartbeat = isWorking && prev !== undefined && now - prev.lastEmitMs >= heartbeatIntervalMs;
        if (!changed && !needsHeartbeat) continue;

        seen.set(id, { kind, modifiedMs: modMs, stepCount, agents, lastEmitMs: now });
        const cwd = parseWorkspaceCwd(r.workspace_uris);
        const project = cwd ? path.basename(cwd) : undefined;
        const title = (r.title || "").trim().slice(0, 80) || undefined;
        const activity = isWorking ? (hint.activity ?? title ?? "thinking") : undefined;

        opts.onEvent({
          source: "antigravity",
          sessionId: id,
          kind,
          ...(cwd ? { cwd } : {}),
          ...(project ? { project } : {}),
          ...(title ? { name: title } : {}),
          ...(activity ? { activity } : {}),
          ...(agents > 1 ? { agents } : {}),
          // While running, stamp `now` so SessionStore never prematurely demotes long model/tool turns.
          ts: isWorking ? now : modMs || now,
        });
      }

      for (const [id] of seen) {
        if (!alive.has(id)) {
          seen.delete(id);
          opts.onEvent({ source: "antigravity", sessionId: id, kind: "end", ts: now });
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
