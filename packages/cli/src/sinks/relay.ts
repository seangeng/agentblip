import type { SlackStatus, StatusUpdateRequest } from "@agentblip/core";
import type { Sink } from "./types";

const PUSH_TIMEOUT_MS = 10_000;

export function createRelaySink(
  relayUrl: string,
  deviceToken: string,
  log: (message: string) => void = console.error,
): Sink {
  const endpoint = new URL("/api/status", relayUrl).toString();
  return {
    name: "relay",
    async push(status: SlackStatus | null): Promise<void> {
      const body: StatusUpdateRequest = { status };
      const res = await fetch(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${deviceToken}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(PUSH_TIMEOUT_MS),
      });
      if (res.status === 401) {
        log("device unlinked or token revoked — run `agentblip setup` to pair again");
        throw new Error("relay rejected device token (401)");
      }
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
    },
  };
}
