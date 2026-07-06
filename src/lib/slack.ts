import {
  SLACK_PROFILE_SET_URL,
  toSlackProfile,
  type SlackStatus,
} from "@agentblip/core";

/** Slack Web API calls get a hard 5s budget so a slow Slack can't hang the Worker. */
const SLACK_TIMEOUT_MS = 5_000;

export type OauthExchangeResult =
  | {
      ok: true;
      accessToken: string; // xoxp user token
      slackUserId: string;
      teamId: string;
      teamName: string;
    }
  | { ok: false; error: string };

export type SetStatusResult = { ok: true } | { ok: false; error: string };

interface SlackOauthResponse {
  ok: boolean;
  error?: string;
  authed_user?: { id?: string; access_token?: string };
  team?: { id?: string; name?: string };
}

/** POST oauth.v2.access — exchanges the callback `code` for a user token. */
export async function oauthExchange(params: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<OauthExchangeResult> {
  const body = new URLSearchParams({
    client_id: params.clientId,
    client_secret: params.clientSecret,
    code: params.code,
    redirect_uri: params.redirectUri,
  });

  let data: SlackOauthResponse;
  try {
    const res = await fetch("https://slack.com/api/oauth.v2.access", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    data = (await res.json()) as SlackOauthResponse;
  } catch {
    return { ok: false, error: "network_error" };
  }

  const accessToken = data.authed_user?.access_token;
  const slackUserId = data.authed_user?.id;
  if (!data.ok || !accessToken || !slackUserId) {
    return { ok: false, error: data.error ?? "missing_user_token" };
  }
  return {
    ok: true,
    accessToken,
    slackUserId,
    teamId: data.team?.id ?? "",
    teamName: data.team?.name ?? "",
  };
}

/** POST users.profile.set — `status: null` clears the Slack status entirely. */
export async function setStatus(
  xoxpToken: string,
  status: SlackStatus | null,
): Promise<SetStatusResult> {
  const profile = toSlackProfile(status);

  try {
    const res = await fetch(SLACK_PROFILE_SET_URL, {
      method: "POST",
      headers: {
        authorization: `Bearer ${xoxpToken}`,
        "content-type": "application/json; charset=utf-8",
      },
      body: JSON.stringify({ profile }),
      signal: AbortSignal.timeout(SLACK_TIMEOUT_MS),
    });
    const data = (await res.json()) as { ok: boolean; error?: string };
    return data.ok ? { ok: true } : { ok: false, error: data.error ?? "unknown_error" };
  } catch {
    return { ok: false, error: "network_error" };
  }
}
