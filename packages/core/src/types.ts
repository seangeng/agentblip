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
   * Informational fingerprint of session state, surfaced on the daemon's
   * /state endpoint. The pusher dedups on the formatted status text/emoji, not
   * on this — two different session sets can format to the same Slack status.
   */
  signature: string;
}
