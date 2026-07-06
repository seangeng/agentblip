import type { SlackStatus, StatusUpdateRequest } from "@agentblip/core";
import { PermanentSinkError } from "./types";
import type { Sink } from "./types";

const PUSH_TIMEOUT_MS = 10_000;

export function createRelaySink(relayUrl: string, deviceToken: string): Sink {
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
        // permanent: the relay deleted this device — retrying can't fix it
        throw new PermanentSinkError(
          "device unlinked or token revoked — run `agentblip setup` to pair again",
        );
      }
      if (!res.ok) throw new Error(`relay responded ${res.status}`);
    },
  };
}
