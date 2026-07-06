import type { SlackStatus } from "@agentblip/core";

export interface Sink {
  name: string;
  /** Pushes a pre-formatted status; null clears the Slack status. */
  push(status: SlackStatus | null): Promise<void>;
}

/**
 * A failure retrying can never fix (e.g. revoked device token) — the pusher
 * halts instead of hammering the sink forever.
 */
export class PermanentSinkError extends Error {}
