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

/** Slack returns this when the token predates the users.profile:read scope. */
export const SLACK_MISSING_SCOPE_ERROR = "missing_scope";

export interface SlackProfileGetBody {
  ok: boolean;
  error?: string;
  profile?: SlackProfileFields;
}

export type ProfileGetOutcome =
  | { readable: true; status: SlackStatus | null }
  | { readable: false } // missing users.profile:read scope
  | { error: string }; // any other Slack failure

/**
 * Interprets a users.profile.get response body. Shared by the relay Worker and
 * the CLI direct sink so the missing_scope → legacy mapping lives in one place.
 */
export function interpretProfileGet(data: SlackProfileGetBody): ProfileGetOutcome {
  if (!data.ok) {
    if (data.error === SLACK_MISSING_SCOPE_ERROR) return { readable: false };
    return { error: data.error ?? "unknown_error" };
  }
  return { readable: true, status: fromSlackProfile(data.profile) };
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
