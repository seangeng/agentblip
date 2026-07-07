import type { SlackStatus } from "./events";

export const SLACK_PROFILE_SET_URL = "https://slack.com/api/users.profile.set";
export const SLACK_PROFILE_GET_URL = "https://slack.com/api/users.profile.get";

export interface SlackProfileFields {
  status_text?: string;
  status_emoji?: string;
  status_expiration?: number;
}

/** users.profile.get → SlackStatus; null when the profile has no status set. */
export function fromSlackProfile(
  profile: SlackProfileFields | undefined,
): SlackStatus | null {
  const text = profile?.status_text ?? "";
  const emoji = profile?.status_emoji ?? "";
  if (text === "" && emoji === "") return null;
  return { text, emoji, expirationSec: profile?.status_expiration || 0 };
}

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
