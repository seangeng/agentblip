import type { SlackStatus } from "./events";

export const SLACK_PROFILE_SET_URL = "https://slack.com/api/users.profile.set";

export interface SlackProfilePayload {
  status_text: string;
  status_emoji: string;
  status_expiration: number;
}

/** users.profile.set profile body — `status: null` clears the Slack status. */
export function toSlackProfile(status: SlackStatus | null): SlackProfilePayload {
  return status
    ? {
        status_text: status.text,
        status_emoji: status.emoji,
        status_expiration: status.expirationSec,
      }
    : { status_text: "", status_emoji: "", status_expiration: 0 };
}
