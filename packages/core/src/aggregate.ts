import type { SessionEvent, SessionState } from "./events";
import type { AgentSession, StatusSnapshot } from "./types";
import {
  DEFAULT_IDLE_EVICT_MS,
  DEFAULT_WAITING_STALE_MS,
  DEFAULT_WORKING_STALE_MS,
} from "./constants";

export interface SessionStoreOptions {
  /** ms after which a silent "working" session is demoted to idle. */
  workingStaleMs?: number;
  /** ms after which a silent "waiting" session is demoted to idle (agents blocked on the human are quiet by design, so this is much longer). */
  waitingStaleMs?: number;
  /** ms after which a silent idle session is evicted entirely. */
  idleEvictMs?: number;
}

/** Events stamped further in the future than this are treated as clock skew. */
const TS_SKEW_TOLERANCE_MS = 30_000;
/** Anything before this (2001-01-01) is a broken clock, not a real timestamp. */
const TS_MIN_PLAUSIBLE_MS = 978_307_200_000;

const KIND_TO_STATE: Record<string, SessionState | undefined> = {
  start: "idle",
  working: "working",
  waiting: "waiting",
  idle: "idle",
  // heartbeat: keep current state; end: remove
};

/**
 * In-memory session registry for the daemon. Pure logic, no timers —
 * callers invoke sweep() on their own cadence.
 */
export class SessionStore {
  private sessions = new Map<string, AgentSession>();
  private readonly workingStaleMs: number;
  private readonly waitingStaleMs: number;
  private readonly idleEvictMs: number;

  constructor(opts: SessionStoreOptions = {}) {
    this.workingStaleMs = opts.workingStaleMs ?? DEFAULT_WORKING_STALE_MS;
    this.waitingStaleMs = opts.waitingStaleMs ?? DEFAULT_WAITING_STALE_MS;
    this.idleEvictMs = opts.idleEvictMs ?? DEFAULT_IDLE_EVICT_MS;
  }

  apply(event: SessionEvent, receivedAt = Date.now()): void {
    // Clamp client-supplied timestamps: a future-skewed ts would block all
    // later events and outlive every sweep threshold.
    let ts = event.ts ?? receivedAt;
    if (ts > receivedAt + TS_SKEW_TOLERANCE_MS || ts < TS_MIN_PLAUSIBLE_MS) {
      ts = receivedAt;
    }
    const key = `${event.source}:${event.sessionId}`;

    if (event.kind === "end") {
      this.sessions.delete(key);
      return;
    }

    const existing = this.sessions.get(key);
    const nextState =
      event.kind === "heartbeat"
        ? (existing?.state ?? "idle")
        : (KIND_TO_STATE[event.kind] ?? "idle");

    if (existing && ts < existing.updatedAt) return; // drop out-of-order events

    this.sessions.set(key, {
      key,
      source: event.source,
      sessionId: event.sessionId,
      state: nextState,
      // "working" events without a label keep the previous label (tool chatter
      // often arrives label-less between richer events).
      activity: event.activity ?? (nextState === "working" ? existing?.activity : undefined),
      project: event.project ?? existing?.project,
      startedAt: existing?.startedAt ?? ts,
      updatedAt: ts,
    });
  }

  /** Demote stale working/waiting sessions, evict long-idle ones. */
  sweep(now = Date.now()): void {
    for (const [key, s] of this.sessions) {
      const silentFor = now - s.updatedAt;
      const staleAfter =
        s.state === "working" ? this.workingStaleMs : this.waitingStaleMs;
      if (s.state !== "idle" && silentFor > staleAfter) {
        this.sessions.set(key, { ...s, state: "idle", activity: undefined });
      } else if (s.state === "idle" && silentFor > this.idleEvictMs) {
        this.sessions.delete(key);
      }
    }
  }

  snapshot(): StatusSnapshot {
    const sessions = [...this.sessions.values()].sort(
      (a, b) => b.updatedAt - a.updatedAt,
    );
    const working = sessions.filter((s) => s.state === "working").length;
    const waiting = sessions.filter((s) => s.state === "waiting").length;
    const idle = sessions.filter((s) => s.state === "idle").length;
    const latestActivity = sessions.find(
      (s) => s.state === "working" && s.activity,
    )?.activity;

    return {
      sessions,
      working,
      waiting,
      idle,
      total: sessions.length,
      latestActivity,
      signature: sessions
        .map((s) => `${s.key}=${s.state}:${s.activity ?? ""}:${s.project ?? ""}`)
        .sort()
        .join("|"),
    };
  }

  clear(): void {
    this.sessions.clear();
  }
}
