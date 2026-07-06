import type { SessionState } from "./events";

export interface AgentSession {
  key: string; // `${source}:${sessionId}`
  source: string;
  sessionId: string;
  state: SessionState;
  activity?: string;
  project?: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms of last event
}

export interface StatusSnapshot {
  /** Sessions sorted by updatedAt descending (most recent first). */
  sessions: AgentSession[];
  working: number;
  waiting: number;
  idle: number;
  total: number;
  /** Activity label of the most recently updated working session, if any. */
  latestActivity?: string;
  /**
   * Stable fingerprint of everything that affects the formatted status.
   * The daemon pushes to Slack only when this changes.
   */
  signature: string;
}
