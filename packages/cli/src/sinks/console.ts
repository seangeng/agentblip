import type { SlackStatus, StatusReadResponse } from "@agentblip/core";
import type { Sink } from "./types";

/** Dry-run sink: logs what would be sent to Slack. */
export function createConsoleSink(log: (message: string) => void = console.log): Sink {
  return {
    name: "console",
    push(status: SlackStatus | null): Promise<void> {
      if (status) {
        const expires = status.expirationSec
          ? ` (expires ${new Date(status.expirationSec * 1000).toLocaleTimeString()})`
          : "";
        log(`[console sink] would set: ${status.emoji} "${status.text}"${expires}`);
      } else {
        log("[console sink] would clear status");
      }
      return Promise.resolve();
    },
    getStatus(): Promise<StatusReadResponse> {
      // Dry run: there is no real Slack profile behind this sink, so there is
      // nothing to read. readable:false routes the pusher down the legacy
      // blind-push path (which here only logs) — the ownership guard is
      // deliberately inert in dry-run rather than acting on made-up data.
      return Promise.resolve({ readable: false, status: null });
    },
  };
}
