import type { SlackStatus } from "@agentblip/core";

export interface Sink {
  name: string;
  /** Pushes a pre-formatted status; null clears the Slack status. */
  push(status: SlackStatus | null): Promise<void>;
}
