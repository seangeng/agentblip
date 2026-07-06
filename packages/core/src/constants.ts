/** Default port the local daemon listens on (loopback only). */
export const DEFAULT_DAEMON_PORT = 4519;

/** Slack caps status text at 100 characters. */
export const SLACK_STATUS_MAX_LEN = 100;

/** Rolling status expiration — Slack auto-clears if the daemon dies. */
export const DEFAULT_STATUS_TTL_SEC = 300;

/** Minimum interval between Slack pushes (users.profile.set is Tier 3, ~50/min). */
export const DEFAULT_DEBOUNCE_MS = 10_000;

/** A "working" session with no events for this long is demoted to idle. */
export const DEFAULT_WORKING_STALE_MS = 3 * 60_000;

/**
 * A "waiting" session is expected to be silent (agent blocked on the human),
 * so it gets a much longer leash before demotion.
 */
export const DEFAULT_WAITING_STALE_MS = 30 * 60_000;

/** Idle sessions are evicted after this long without events. */
export const DEFAULT_IDLE_EVICT_MS = 15 * 60_000;

/** Device tokens issued by the relay: ab_<64 hex>. Plaintext shown once, SHA-256 stored. */
export const DEVICE_TOKEN_PREFIX = "ab_";

/** Human display names for well-known agent sources. */
export const SOURCE_DISPLAY_NAMES: Record<string, string> = {
  "claude-code": "claude",
  codex: "codex",
  "gemini-cli": "gemini",
  cursor: "cursor",
  opencode: "opencode",
};

export function displayName(source: string): string {
  return SOURCE_DISPLAY_NAMES[source] ?? source;
}
