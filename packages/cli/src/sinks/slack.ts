import type { SlackStatus } from "@agentblip/core";
import type { Sink } from "./types";

const SLACK_API = "https://slack.com/api/users.profile.set";
const PUSH_TIMEOUT_MS = 10_000;

/** Direct sink: sets the Slack status with the user's own token, no relay. */
export function createSlackSink(token: string): Sink {
  return {
    name: "slack",
    async push(status: SlackStatus | null): Promise<void> {
      const profile = status
        ? {
            status_text: status.text,
            status_emoji: status.emoji,
            status_expiration: status.expirationSec,
          }
        : { status_text: "", status_emoji: "", status_expiration: 0 };
      const res = await fetch(SLACK_API, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ profile }),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (!res.ok) throw new Error(`Slack API HTTP ${res.status}`);
      const data = (await res.json()) as { ok: boolean; error?: string };
      if (!data.ok) {
        throw new Error(`users.profile.set failed: ${data.error ?? "unknown error"}`);
      }
    },
  };
}
