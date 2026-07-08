import type { SessionState } from "./events";

export interface AgentSession {
  key: string; // `${source}:${sessionId}`
  source: string;
  sessionId: string;
  state: SessionState;
  activity?: string;
  project?: string;
  /** Concurrent agents this session represents (default 1; orchestrator-reported). */
  agents: number;
  /** Orchestrator phase label, if any. */
  phase?: string;
  startedAt: number; // epoch ms
  updatedAt: number; // epoch ms of last event
}

export interface StatusSnapshot {
  /** Sessions sorted by updatedAt descending (most recent first). */
  sessions: AgentSession[];
  /** Number of working *sessions* (not agents). */
  working: number;
  waiting: number;
  idle: number;
  total: number;
  /**
   * Total concurrent agents across working sessions (sum of each session's
   * `agents`). Equals `working` unless an orchestrator reported fan-out. This
   * is the number shown as "N agents working".
   */
  agentCount: number;
  /** Activity label of the most recently updated working session, if any. */
  latestActivity?: string;
  /** Phase of the most recently updated working session, if any. */
  latestPhase?: string;
  /**
   * Informational fingerprint of session state, surfaced on the daemon's
   * /state endpoint. The pusher dedups on the formatted status text/emoji, not
   * on this — two different session sets can format to the same Slack status.
   */
  signature: string;
}
