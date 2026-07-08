import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { SessionEvent } from "@agentblip/core";

/**
 * Claude Code writes a per-workflow `journal.jsonl` under
 *   ~/.claude/projects/<slug>/<session>/subagents/workflows/<wf>/journal.jsonl
 * with a `started` line when an agent spawns and a `result` line when it
 * finishes. Live agents = started − result. Hooks can't see this count, so we
 * watch the journals and report the fleet — every agentblip + ultracode user
 * gets accurate "N agents working" with no setup. This depends on Claude Code's
 * internal layout (undocumented), so everything here degrades to a no-op if the
 * dir or format isn't what we expect.
 */

export function claudeProjectsDir(): string {
  return path.join(os.homedir(), ".claude", "projects");
}

/** Journals untouched for longer than this can't be a live workflow. */
const ACTIVE_MTIME_MS = 15 * 60 * 1000;
/** Keep a workflow's session for this long after it drops to 0 agents (rides out inter-phase dips). */
const END_GRACE_MS = 20_000;
const DEFAULT_POLL_MS = 4000;

/** started − result across a journal = currently-running agents. Pure. */
export function liveAgentCount(journalText: string): number {
  let started = 0;
  let result = 0;
  for (const line of journalText.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    try {
      const o = JSON.parse(t) as { type?: string };
      if (o.type === "started") started++;
      else if (o.type === "result") result++;
    } catch {
      // a partial trailing line mid-write — ignore
    }
  }
  return Math.max(0, started - result);
}

/** Targeted walk of the known layout — never a blind recursive watch. */
export function findActiveJournals(
  projectsDir: string,
  nowMs: number,
): Array<{ wfId: string; file: string }> {
  const out: Array<{ wfId: string; file: string }> = [];
  const readDir = (p: string): string[] => {
    try {
      return fs.readdirSync(p);
    } catch {
      return [];
    }
  };
  for (const proj of readDir(projectsDir)) {
    const sessionsBase = path.join(projectsDir, proj);
    for (const sess of readDir(sessionsBase)) {
      const wfBase = path.join(sessionsBase, sess, "subagents", "workflows");
      for (const wf of readDir(wfBase)) {
        const file = path.join(wfBase, wf, "journal.jsonl");
        try {
          const stat = fs.statSync(file);
          if (stat.isFile() && nowMs - stat.mtimeMs <= ACTIVE_MTIME_MS) {
            out.push({ wfId: wf, file });
          }
        } catch {
          // no journal yet in this wf dir
        }
      }
    }
  }
  return out;
}

export interface WfState {
  agents: number;
  /** When the workflow first hit 0 live agents (for the end grace). */
  zeroSince?: number;
}

/**
 * Pure reconciliation: given the current per-workflow live counts, mutate the
 * tracked state and return the events to emit. Testable without fs or timers.
 */
export function stepWorkflows(
  active: Map<string, WfState>,
  journals: Array<{ wfId: string; count: number }>,
  nowMs: number,
): SessionEvent[] {
  const events: SessionEvent[] = [];
  const seen = new Set<string>();

  for (const { wfId, count } of journals) {
    seen.add(wfId);
    const st = active.get(wfId) ?? { agents: 0 };
    if (count > 0) {
      st.zeroSince = undefined;
      // Re-send the count when it changes; otherwise heartbeat so a long,
      // steady phase doesn't hit the daemon's stale sweep.
      events.push(
        st.agents === count
          ? { source: "workflow", sessionId: wfId, kind: "heartbeat", ts: nowMs }
          : {
              source: "workflow",
              sessionId: wfId,
              kind: "working",
              agents: count,
              activity: "running a workflow",
              ts: nowMs,
            },
      );
      st.agents = count;
      active.set(wfId, st);
    } else {
      st.agents = 0;
      st.zeroSince ??= nowMs;
      active.set(wfId, st);
    }
  }

  for (const [wfId, st] of active) {
    const gone = !seen.has(wfId);
    const graceExpired =
      st.zeroSince !== undefined && nowMs - st.zeroSince > END_GRACE_MS;
    if (gone || graceExpired) {
      events.push({ source: "workflow", sessionId: wfId, kind: "end", ts: nowMs });
      active.delete(wfId);
    }
  }
  return events;
}

export interface WorkflowWatcher {
  close(): Promise<void>;
}

/**
 * Polls the workflow journals and reports the live agent fleet. Polling (not an
 * fs watch) keeps cost bounded and avoids holding watches over the whole
 * ~/.claude/projects tree.
 */
export function createWorkflowWatcher(
  projectsDir: string,
  onEvent: (event: SessionEvent) => void,
  log: (message: string) => void = () => {},
  opts: { pollMs?: number; now?: () => number } = {},
): WorkflowWatcher {
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const now = opts.now ?? (() => Date.now());
  const active = new Map<string, WfState>();

  const tick = (): void => {
    try {
      const journals = findActiveJournals(projectsDir, now()).map(({ wfId, file }) => {
        try {
          return { wfId, count: liveAgentCount(fs.readFileSync(file, "utf8")) };
        } catch {
          return { wfId, count: 0 };
        }
      });
      for (const event of stepWorkflows(active, journals, now())) onEvent(event);
    } catch (err) {
      log(`workflow watcher error: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const timer = setInterval(tick, pollMs);
  timer.unref?.(); // don't keep the process alive on our account
  tick();

  return {
    close: () => {
      clearInterval(timer);
      return Promise.resolve();
    },
  };
}
