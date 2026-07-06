import { Hono } from "hono";
import {
  DEVICE_TOKEN_PREFIX,
  pairPollRequestSchema,
  statusUpdateRequestSchema,
  type PairPollResponse,
  type PairStartResponse,
} from "@agentblip/core";
import type { Env } from "../env";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  pairCode,
  randomHex,
  sha256hex,
  timingSafeEqualHex,
} from "../lib/crypto";
import {
  DEVICE_PROVISIONAL_TTL_SEC,
  PAIR_DELIVERED_TTL_SEC,
  PAIR_TTL_SEC,
  deleteDeviceRecord,
  deletePairState,
  getDeviceRecord,
  getPairCodeForDevice,
  getPairRecord,
  getPairState,
  putDeviceRecord,
  putPairDeviceIndex,
  putPairRecord,
  putPairState,
  type DeviceRecord,
  type KVStore,
} from "../lib/kv";
import { rateLimit } from "../lib/ratelimit";
import { oauthExchange, setStatus } from "../lib/slack";

const PAIR_START_LIMIT_PER_MIN = 5;
const STATUS_LIMIT_PER_MIN = 30;
/** lastSeenAt is refreshed at most hourly to avoid hot KV writes. */
const LAST_SEEN_REFRESH_MS = 3_600_000;

/** Slack errors that mean the stored xoxp token is permanently dead. */
const SLACK_REVOKED_ERRORS = new Set(["invalid_auth", "token_revoked", "account_inactive"]);

/** Pair codes are generated uppercase-only (crypto.ts); normalize human input the same way. */
function normalizePairCode(raw: string | undefined): string {
  return (
    raw
      ?.trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "") ?? ""
  );
}

/** Resolve a `Bearer ab_…` header to its device record, or null when invalid. */
async function authDevice(
  store: KVStore,
  header: string | undefined,
): Promise<{ tokenHash: string; device: DeviceRecord } | null> {
  if (!header?.startsWith("Bearer ")) return null;
  const token = header.slice("Bearer ".length).trim();
  if (!token.startsWith(DEVICE_TOKEN_PREFIX)) return null;
  const tokenHash = await sha256hex(token);
  const device = await getDeviceRecord(store, tokenHash);
  return device ? { tokenHash, device } : null;
}

export const api = new Hono<{ Bindings: Env }>();

api.get("/health", (c) => c.json({ ok: true, service: "agentblip" }));

api.post("/pair/start", async (c) => {
  const ip = c.req.header("CF-Connecting-IP") ?? "unknown";
  const allowed = await rateLimit(c.env.STORE, "pairstart", ip, PAIR_START_LIMIT_PER_MIN);
  if (!allowed) return c.json({ error: "rate_limited" }, 429);

  const code = pairCode();
  const deviceId = randomHex(16);
  const pollSecret = randomHex(32);

  await putPairRecord(c.env.STORE, code, {
    deviceId,
    pollSecretHash: await sha256hex(pollSecret),
    status: "pending",
  });
  await putPairDeviceIndex(c.env.STORE, deviceId, code);

  const res: PairStartResponse = {
    code,
    deviceId,
    pollSecret,
    verifyUrl: `${c.env.BASE_URL}/pair?code=${code}`,
    expiresInSec: PAIR_TTL_SEC,
  };
  return c.json(res);
});

api.post("/pair/poll", async (c) => {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const parsed = pairPollRequestSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);
  const { deviceId, pollSecret } = parsed.data;

  const expired: PairPollResponse = { status: "expired" };
  const code = await getPairCodeForDevice(c.env.STORE, deviceId);
  if (!code) return c.json(expired);
  const record = await getPairRecord(c.env.STORE, code);
  if (!record) return c.json(expired);

  // Wrong secret is indistinguishable from an expired pairing — no oracle.
  const secretHash = await sha256hex(pollSecret);
  if (!timingSafeEqualHex(secretHash, record.pollSecretHash)) return c.json(expired);

  if (record.status === "pending") {
    const pending: PairPollResponse = { status: "pending" };
    return c.json(pending);
  }

  // Near-single-use handover: the first complete poll re-puts the record with
  // a short grace TTL instead of deleting it, so a dropped response (CLI
  // timeout, wifi blip) can be retried; after the grace it expires for good.
  // Replay by anyone else is still blocked by the timing-safe pollSecret check
  // above, and re-polls don't refresh the TTL (deliveredAt is already set).
  const complete: PairPollResponse = {
    status: "complete",
    deviceToken: record.deviceToken,
    team: record.team,
  };
  if (record.deliveredAt === undefined) {
    const delivered = { ...record, deliveredAt: Date.now() };
    await putPairRecord(c.env.STORE, code, delivered, PAIR_DELIVERED_TTL_SEC);
    await putPairDeviceIndex(c.env.STORE, deviceId, code, PAIR_DELIVERED_TTL_SEC);
  }
  return c.json(complete);
});

// OAuth responses carry codes/state in URLs — never let them be cached.
api.use("/slack/*", async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
});

api.get("/slack/install", async (c) => {
  const code = normalizePairCode(c.req.query("code"));

  // Soft same-origin check: a cross-site navigation (install link embedded in
  // another site/webmail) is bounced to /pair so a human confirms the code
  // there — the /pair form submit is same-origin and passes. Direct
  // navigations (CLI-printed links, address bar) send Sec-Fetch-Site: none or
  // nothing and are allowed.
  // Residual risk (accepted): the pairing code alone binds whoever completes
  // Slack OAuth to the CLI that started pairing, so a phisher holding a
  // pending code can still lure a victim through /pair into authorizing it.
  // The primary mitigation lives on /pair (no auto-submit + warning copy),
  // bounded by the 15-minute code TTL.
  if (c.req.header("Sec-Fetch-Site") === "cross-site") {
    return c.redirect(code ? `/pair?code=${code}` : "/pair");
  }

  const record = code ? await getPairRecord(c.env.STORE, code) : null;
  if (!code || !record || record.status !== "pending") {
    return c.redirect("/pair?error=expired");
  }

  const nonce = randomHex(32);
  await putPairState(c.env.STORE, nonce, code);

  const authorize = new URL("https://slack.com/oauth/v2/authorize");
  authorize.searchParams.set("client_id", c.env.SLACK_CLIENT_ID);
  authorize.searchParams.set("user_scope", "users.profile:write");
  authorize.searchParams.set("redirect_uri", `${c.env.BASE_URL}/api/slack/callback`);
  authorize.searchParams.set("state", nonce);
  return c.redirect(authorize.toString());
});

api.get("/slack/callback", async (c) => {
  const state = c.req.query("state");
  const oauthCode = c.req.query("code");

  const pairingCode = state ? await getPairState(c.env.STORE, state) : null;
  if (!state || !pairingCode) return c.redirect("/pair?error=state");
  await deletePairState(c.env.STORE, state); // CSRF nonce is single-use

  const record = await getPairRecord(c.env.STORE, pairingCode);
  if (!record || record.status !== "pending") return c.redirect("/pair?error=expired");
  if (!oauthCode) return c.redirect("/pair?error=slack");

  const exchange = await oauthExchange({
    clientId: c.env.SLACK_CLIENT_ID,
    clientSecret: c.env.SLACK_CLIENT_SECRET,
    code: oauthCode,
    redirectUri: `${c.env.BASE_URL}/api/slack/callback`,
  });
  if (!exchange.ok) return c.redirect("/pair?error=slack");

  const deviceToken = `${DEVICE_TOKEN_PREFIX}${randomHex(64)}`;
  const now = Date.now();
  // Provisional until the CLI proves it holds the token (first authenticated
  // /status promotes it): if setup is abandoned before the poll completes, the
  // record self-expires instead of orphaning an encrypted xoxp in KV forever.
  await putDeviceRecord(
    c.env.STORE,
    await sha256hex(deviceToken),
    {
      slackUserId: exchange.slackUserId,
      teamId: exchange.teamId,
      teamName: exchange.teamName,
      encToken: await aesGcmEncrypt(exchange.accessToken, c.env.TOKEN_ENCRYPTION_KEY),
      createdAt: now,
      lastSeenAt: now,
      provisional: true,
    },
    DEVICE_PROVISIONAL_TTL_SEC,
  );

  await putPairRecord(c.env.STORE, pairingCode, {
    ...record,
    status: "complete",
    deviceToken,
    team: exchange.teamName,
  });

  return c.redirect(`/pair?done=1&team=${encodeURIComponent(exchange.teamName)}`);
});

api.post("/status", async (c) => {
  const auth = await authDevice(c.env.STORE, c.req.header("authorization"));
  if (!auth) return c.json({ error: "invalid_token" }, 401);
  const { tokenHash, device } = auth;

  const allowed = await rateLimit(c.env.STORE, "status", tokenHash, STATUS_LIMIT_PER_MIN);
  if (!allowed) return c.json({ error: "rate_limited" }, 429);

  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "invalid_request" }, 400);
  }
  const parsed = statusUpdateRequestSchema.safeParse(raw);
  if (!parsed.success) return c.json({ error: "invalid_request" }, 400);

  let xoxp: string;
  try {
    xoxp = await aesGcmDecrypt(device.encToken, c.env.TOKEN_ENCRYPTION_KEY);
  } catch {
    return c.json({ error: "internal" }, 500);
  }

  const result = await setStatus(xoxp, parsed.data.status);
  if (!result.ok) {
    if (SLACK_REVOKED_ERRORS.has(result.error)) {
      await deleteDeviceRecord(c.env.STORE, tokenHash);
      return c.json({ error: "slack_revoked" }, 401);
    }
    if (result.error === "ratelimited") return c.json({ error: "ratelimited" }, 429);
    return c.json({ error: "slack_error", detail: result.error }, 502);
  }

  const now = Date.now();
  // First authenticated use promotes a provisional record to permanent (re-put
  // without TTL or flag); afterwards lastSeenAt is refreshed at most hourly.
  if (device.provisional || now - device.lastSeenAt >= LAST_SEEN_REFRESH_MS) {
    const permanent: DeviceRecord = { ...device, lastSeenAt: now };
    delete permanent.provisional;
    await putDeviceRecord(c.env.STORE, tokenHash, permanent);
  }
  return c.json({ ok: true });
});

api.post("/unlink", async (c) => {
  const auth = await authDevice(c.env.STORE, c.req.header("authorization"));
  if (!auth) return c.json({ error: "invalid_token" }, 401);

  try {
    const xoxp = await aesGcmDecrypt(auth.device.encToken, c.env.TOKEN_ENCRYPTION_KEY);
    await setStatus(xoxp, null); // best-effort clear; failure still unlinks
  } catch {
    // undecryptable token — proceed with the unlink regardless
  }
  await deleteDeviceRecord(c.env.STORE, auth.tokenHash);
  return c.json({ ok: true });
});
