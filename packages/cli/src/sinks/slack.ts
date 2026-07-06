import {
  SLACK_PROFILE_SET_URL,
  toSlackProfile,
  type SlackStatus,
} from "@agentblip/core";
import type { Sink } from "./types";

const PUSH_TIMEOUT_MS = 10_000;

/** Direct sink: sets the Slack status with the user's own token, no relay. */
export function createSlackSink(token: string): Sink {
  return {
    name: "slack",
    async push(status: SlackStatus | null): Promise<void> {
      const res = await fetch(SLACK_PROFILE_SET_URL, {
        method: "POST",
        headers: {
          "content-type": "application/json; charset=utf-8",
          authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ profile: toSlackProfile(status) }),
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
