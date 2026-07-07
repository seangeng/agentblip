import type { SlackStatus, StatusReadResponse } from "@agentblip/core";

export interface Sink {
  name: string;
  /** Pushes a pre-formatted status; null clears the Slack status. */
  push(status: SlackStatus | null): Promise<void>;
  /**
   * Reads the status currently on the Slack profile so the ownership guard
   * can decide whether a push would clobber something we didn't set.
   * `readable: false` = the token can't read (missing users.profile:read) —
   * callers fall back to legacy blind pushes. Throws on transient failures.
   */
  getStatus(): Promise<StatusReadResponse>;
}

/**
 * A failure retrying can never fix (e.g. revoked device token) — the pusher
 * halts instead of hammering the sink forever.
 */
export class PermanentSinkError extends Error {}
