import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  pairStartResponseSchema,
  statusReadResponseSchema,
  type PairPollResponse,
} from "@agentblip/core";
import type { Env } from "../env";
import { aesGcmDecrypt, aesGcmEncrypt, sha256hex } from "../lib/crypto";
import {
  DEVICE_PROVISIONAL_TTL_SEC,
  PAIR_DELIVERED_TTL_SEC,
  getDeviceRecord,
  putDeviceRecord,
  type DeviceRecord,
  type KVStore,
} from "../lib/kv";
import { api } from "./index";

const BASE64_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));

function createKv() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const writes = new Map<string, number>();
  const kv: KVStore = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
      writes.set(key, (writes.get(key) ?? 0) + 1);
    },
    async delete(key) {
      data.delete(key);
      ttls.delete(key);
    },
  };
  return { kv, data, ttls, writes };
}

function makeEnv(kv: KVStore): Env {
  return {
    STORE: kv as unknown as KVNamespace,
    BASE_URL: "https://agentblip.com",
    SLACK_CLIENT_ID: "client-id",
    SLACK_CLIENT_SECRET: "client-secret",
    TOKEN_ENCRYPTION_KEY: BASE64_KEY,
  };
}

// --- fetch mock (all Slack traffic goes through global fetch) ---

interface RecordedFetch {
  url: string;
  init: RequestInit;
}
let fetchCalls: RecordedFetch[] = [];
let slackResponder: (url: string, init: RequestInit) => unknown = () => ({ ok: true });

beforeEach(() => {
  fetchCalls = [];
  slackResponder = () => ({ ok: true });
  vi.stubGlobal(
    "fetch",
    async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url =
        typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      const recorded = init ?? {};
      fetchCalls.push({ url, init: recorded });
      return new Response(JSON.stringify(slackResponder(url, recorded)), {
        headers: { "content-type": "application/json" },
      });
    },
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// --- helpers ---

const jsonInit = (body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json", ...headers },
  body: JSON.stringify(body),
});

async function seedDevice(
  kv: KVStore,
  xoxp = "xoxp-seeded",
  overrides: Partial<DeviceRecord> = {},
  ttlSec?: number,
) {
  const token = `ab_${"a".repeat(64)}`;
  const tokenHash = await sha256hex(token);
  await putDeviceRecord(
    kv,
    tokenHash,
    {
      slackUserId: "U123",
      teamId: "T123",
      teamName: "Acme",
      encToken: await aesGcmEncrypt(xoxp, BASE64_KEY),
      createdAt: Date.now(),
      lastSeenAt: Date.now(),
      ...overrides,
    },
    ttlSec,
  );
  return { token, tokenHash };
}

describe("GET /health", () => {
  it("reports the service", async () => {
    const env = makeEnv(createKv().kv);
    const res = await api.request("/health", {}, env);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, service: "agentblip" });
  });
});

describe("pair flow", () => {
  it("start → install → callback → poll delivers the token, grace re-poll, then expired", async () => {
    const { kv, data, ttls, writes } = createKv();
    const env = makeEnv(kv);

    // 1. CLI starts pairing
    const startRes = await api.request(
      "/pair/start",
      { method: "POST", headers: { "CF-Connecting-IP": "1.2.3.4" } },
      env,
    );
    expect(startRes.status).toBe(200);
    const start = pairStartResponseSchema.parse(await startRes.json());
    expect(start.verifyUrl).toBe(`https://agentblip.com/pair?code=${start.code}`);
    expect(start.expiresInSec).toBe(900);
    expect(start.deviceId).toMatch(/^[0-9a-f]{16}$/);
    expect(start.pollSecret).toMatch(/^[0-9a-f]{32}$/);

    // 2. Poll while pending
    const pendingRes = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: start.pollSecret }),
      env,
    );
    expect(((await pendingRes.json()) as PairPollResponse).status).toBe("pending");

    // 3. Browser hits install → 302 to Slack authorize with a state nonce
    const installRes = await api.request(`/slack/install?code=${start.code}`, {}, env);
    expect(installRes.status).toBe(302);
    const authorizeUrl = new URL(installRes.headers.get("location") ?? "");
    expect(authorizeUrl.origin + authorizeUrl.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(authorizeUrl.searchParams.get("client_id")).toBe("client-id");
    expect(authorizeUrl.searchParams.get("user_scope")).toBe(
      "users.profile:write,users.profile:read",
    );
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(
      "https://agentblip.com/api/slack/callback",
    );
    const state = authorizeUrl.searchParams.get("state");
    expect(state).toMatch(/^[0-9a-f]{32}$/);

    // 4. Slack redirects back; exchange succeeds
    slackResponder = (url) =>
      url.includes("oauth.v2.access")
        ? {
            ok: true,
            authed_user: { id: "U777", access_token: "xoxp-from-slack" },
            team: { id: "T777", name: "Acme Inc" },
          }
        : { ok: true };
    const cbRes = await api.request(`/slack/callback?code=slack-code&state=${state}`, {}, env);
    expect(cbRes.status).toBe(302);
    expect(cbRes.headers.get("location")).toBe("/pair?done=1&team=Acme%20Inc");

    const exchangeCall = fetchCalls.find((f) => f.url.includes("oauth.v2.access"));
    expect(exchangeCall).toBeDefined();
    const exchangeBody = new URLSearchParams(String(exchangeCall?.init.body));
    expect(exchangeBody.get("code")).toBe("slack-code");
    expect(exchangeBody.get("client_id")).toBe("client-id");
    expect(exchangeBody.get("client_secret")).toBe("client-secret");
    expect(exchangeBody.get("redirect_uri")).toBe("https://agentblip.com/api/slack/callback");

    // 5. Poll → complete, token delivered exactly once
    const completeRes = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: start.pollSecret }),
      env,
    );
    const complete = (await completeRes.json()) as PairPollResponse;
    expect(complete.status).toBe("complete");
    expect(complete.team).toBe("Acme Inc");
    expect(complete.deviceToken).toMatch(/^ab_[0-9a-f]{64}$/);

    // Device record exists under sha256(token) with the xoxp encrypted at rest,
    // provisional (with a self-expiry TTL) until the first authenticated /status
    const tokenHash = await sha256hex(complete.deviceToken ?? "");
    const device = await getDeviceRecord(kv, tokenHash);
    expect(device?.slackUserId).toBe("U777");
    expect(device?.teamName).toBe("Acme Inc");
    expect(device?.encToken).not.toContain("xoxp-from-slack");
    expect(await aesGcmDecrypt(device?.encToken ?? "", BASE64_KEY)).toBe("xoxp-from-slack");
    expect(device?.provisional).toBe(true);
    expect(ttls.get(`device:${tokenHash}`)).toBe(DEVICE_PROVISIONAL_TTL_SEC);

    // Delivery re-put the pair record + index with the short grace TTL
    expect(ttls.get(`pair:${start.code}`)).toBe(PAIR_DELIVERED_TTL_SEC);
    expect(ttls.get(`pairdev:${start.deviceId}`)).toBe(PAIR_DELIVERED_TTL_SEC);
    const pairWritesAfterDelivery = writes.get(`pair:${start.code}`);

    // 6. Re-poll within the grace window (dropped response) → same token again,
    // without re-putting the record (the grace TTL is not refreshed)
    const againRes = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: start.pollSecret }),
      env,
    );
    const again = (await againRes.json()) as PairPollResponse;
    expect(again.status).toBe("complete");
    expect(again.deviceToken).toBe(complete.deviceToken);
    expect(writes.get(`pair:${start.code}`)).toBe(pairWritesAfterDelivery);

    // A wrong pollSecret still can't replay the delivered token
    const replay = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: "f".repeat(32) }),
      env,
    );
    expect(((await replay.json()) as PairPollResponse).status).toBe("expired");

    // 7. After the grace TTL lapses (simulated — the mock ignores TTLs) → expired
    data.delete(`pair:${start.code}`);
    data.delete(`pairdev:${start.deviceId}`);
    const expiredRes = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: start.pollSecret }),
      env,
    );
    expect(((await expiredRes.json()) as PairPollResponse).status).toBe("expired");
  });

  it("rate-limits pair/start to 5/min per IP", async () => {
    const env = makeEnv(createKv().kv);
    const init = { method: "POST", headers: { "CF-Connecting-IP": "9.9.9.9" } };
    for (let i = 0; i < 5; i++) {
      expect((await api.request("/pair/start", init, env)).status).toBe(200);
    }
    expect((await api.request("/pair/start", init, env)).status).toBe(429);
    // a different IP is unaffected
    const other = { method: "POST", headers: { "CF-Connecting-IP": "8.8.8.8" } };
    expect((await api.request("/pair/start", other, env)).status).toBe(200);
  });

  it("poll returns expired for unknown devices and wrong secrets", async () => {
    const env = makeEnv(createKv().kv);
    const unknown = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: "feedfacefeedface", pollSecret: "0".repeat(32) }),
      env,
    );
    expect(((await unknown.json()) as PairPollResponse).status).toBe("expired");

    const startRes = await api.request("/pair/start", { method: "POST" }, env);
    const start = pairStartResponseSchema.parse(await startRes.json());
    const wrongSecret = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: "f".repeat(32) }),
      env,
    );
    expect(((await wrongSecret.json()) as PairPollResponse).status).toBe("expired");
  });

  it("poll rejects malformed bodies", async () => {
    const env = makeEnv(createKv().kv);
    const res = await api.request("/pair/poll", jsonInit({ deviceId: "x" }), env);
    expect(res.status).toBe(400);
  });

  it("install redirects to /pair?error=expired for unknown or missing codes", async () => {
    const env = makeEnv(createKv().kv);
    const res = await api.request("/slack/install?code=NOTREAL1", {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pair?error=expired");
    const noCode = await api.request("/slack/install", {}, env);
    expect(noCode.headers.get("location")).toBe("/pair?error=expired");
  });

  it("install normalizes the pairing code (case, whitespace, separators) before lookup", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const startRes = await api.request("/pair/start", { method: "POST" }, env);
    const start = pairStartResponseSchema.parse(await startRes.json());

    // lowercase, padded, dashed — the way a human might type it with JS disabled
    const messy = ` ${start.code.slice(0, 4).toLowerCase()}-${start.code.slice(4).toLowerCase()} `;
    const res = await api.request(`/slack/install?code=${encodeURIComponent(messy)}`, {}, env);
    expect(res.status).toBe(302);
    const authorizeUrl = new URL(res.headers.get("location") ?? "");
    expect(authorizeUrl.hostname).toBe("slack.com");

    // the state nonce maps to the normalized code, so the callback completes
    const state = authorizeUrl.searchParams.get("state");
    slackResponder = (url) =>
      url.includes("oauth.v2.access")
        ? {
            ok: true,
            authed_user: { id: "U777", access_token: "xoxp-from-slack" },
            team: { id: "T777", name: "Acme Inc" },
          }
        : { ok: true };
    const cbRes = await api.request(`/slack/callback?code=slack-code&state=${state}`, {}, env);
    expect(cbRes.headers.get("location")).toBe("/pair?done=1&team=Acme%20Inc");

    const pollRes = await api.request(
      "/pair/poll",
      jsonInit({ deviceId: start.deviceId, pollSecret: start.pollSecret }),
      env,
    );
    expect(((await pollRes.json()) as PairPollResponse).status).toBe("complete");
  });

  it("install bounces cross-site navigations to /pair for human confirmation", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const startRes = await api.request("/pair/start", { method: "POST" }, env);
    const start = pairStartResponseSchema.parse(await startRes.json());

    const crossSite = await api.request(
      `/slack/install?code=${start.code}`,
      { headers: { "Sec-Fetch-Site": "cross-site" } },
      env,
    );
    expect(crossSite.status).toBe(302);
    expect(crossSite.headers.get("location")).toBe(`/pair?code=${start.code}`);

    // the /pair form submit is same-origin and proceeds to Slack
    const sameOrigin = await api.request(
      `/slack/install?code=${start.code}`,
      { headers: { "Sec-Fetch-Site": "same-origin" } },
      env,
    );
    expect(new URL(sameOrigin.headers.get("location") ?? "").hostname).toBe("slack.com");
  });

  it("marks install and callback responses uncacheable", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const startRes = await api.request("/pair/start", { method: "POST" }, env);
    const start = pairStartResponseSchema.parse(await startRes.json());

    const installRes = await api.request(`/slack/install?code=${start.code}`, {}, env);
    expect(installRes.headers.get("cache-control")).toBe("no-store");

    const cbRes = await api.request(`/slack/callback?code=x&state=${"0".repeat(32)}`, {}, env);
    expect(cbRes.headers.get("cache-control")).toBe("no-store");
  });

  it("callback rejects a missing/unknown state nonce", async () => {
    const env = makeEnv(createKv().kv);
    const res = await api.request(`/slack/callback?code=x&state=${"0".repeat(32)}`, {}, env);
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("/pair?error=state");
  });

  it("callback redirects to /pair?error=slack when the exchange fails, and the nonce is single-use", async () => {
    const env = makeEnv(createKv().kv);
    const startRes = await api.request("/pair/start", { method: "POST" }, env);
    const start = pairStartResponseSchema.parse(await startRes.json());
    const installRes = await api.request(`/slack/install?code=${start.code}`, {}, env);
    const state = new URL(installRes.headers.get("location") ?? "").searchParams.get("state");

    slackResponder = () => ({ ok: false, error: "invalid_code" });
    const cbRes = await api.request(`/slack/callback?code=bad&state=${state}`, {}, env);
    expect(cbRes.headers.get("location")).toBe("/pair?error=slack");

    // nonce was consumed even though the exchange failed
    const replay = await api.request(`/slack/callback?code=bad&state=${state}`, {}, env);
    expect(replay.headers.get("location")).toBe("/pair?error=state");
  });
});

describe("POST /status", () => {
  const status = { text: "claude agent working", emoji: ":robot_face:", expirationSec: 0 };

  it("401s without a token, with a malformed token, and with an unknown token", async () => {
    const env = makeEnv(createKv().kv);
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong_prefix" },
      { authorization: `Bearer ab_${"b".repeat(64)}` },
    ];
    for (const headers of attempts) {
      const res = await api.request("/status", jsonInit({ status }, headers), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(fetchCalls).toHaveLength(0); // Slack never called
  });

  it("sets the Slack status with the decrypted xoxp token", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv, "xoxp-live");

    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });

    const call = fetchCalls.find((f) => f.url.includes("users.profile.set"));
    expect(call).toBeDefined();
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer xoxp-live");
    expect(JSON.parse(String(call?.init.body))).toEqual({
      profile: {
        status_text: "claude agent working",
        status_emoji: ":robot_face:",
        status_expiration: 0,
      },
    });
  });

  it("clears the status when status is null", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv);

    const res = await api.request(
      "/status",
      jsonInit({ status: null }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    const call = fetchCalls.find((f) => f.url.includes("users.profile.set"));
    expect(JSON.parse(String(call?.init.body))).toEqual({
      profile: { status_text: "", status_emoji: "", status_expiration: 0 },
    });
  });

  it("400s on invalid bodies without calling Slack", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv);
    const auth = { authorization: `Bearer ${token}` };

    const bad = await api.request("/status", jsonInit({ status: { text: 5 } }, auth), env);
    expect(bad.status).toBe(400);
    const notJson = await api.request(
      "/status",
      { method: "POST", headers: auth, body: "not json" },
      env,
    );
    expect(notJson.status).toBe(400);
    expect(fetchCalls).toHaveLength(0);
  });

  it("deletes the device and 401s slack_revoked when Slack reports a dead token", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    slackResponder = () => ({ ok: false, error: "token_revoked" });
    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "slack_revoked" });
    expect(await getDeviceRecord(kv, tokenHash)).toBeNull();
  });

  it("maps Slack ratelimited to 429 and other errors to 502", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv);
    const auth = { authorization: `Bearer ${token}` };

    slackResponder = () => ({ ok: false, error: "ratelimited" });
    expect((await api.request("/status", jsonInit({ status }, auth), env)).status).toBe(429);

    slackResponder = () => ({ ok: false, error: "fatal_error" });
    const res = await api.request("/status", jsonInit({ status }, auth), env);
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "slack_error", detail: "fatal_error" });
  });

  it("rate-limits at 30/min per device", async () => {
    const { kv, data } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    // seed the counter at the limit (both adjacent buckets to dodge minute rollover)
    const bucket = Math.floor(Date.now() / 60_000);
    data.set(`rl:status:${tokenHash}:${bucket}`, "30");
    data.set(`rl:status:${tokenHash}:${bucket + 1}`, "30");

    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(429);
    expect(fetchCalls).toHaveLength(0);
  });

  it("promotes a provisional device record to permanent on first authenticated use", async () => {
    const { kv, ttls } = createKv();
    const env = makeEnv(kv);
    // fresh lastSeenAt: promotion must happen regardless of the hourly refresh
    const { token, tokenHash } = await seedDevice(
      kv,
      "xoxp-live",
      { provisional: true },
      DEVICE_PROVISIONAL_TTL_SEC,
    );
    expect(ttls.get(`device:${tokenHash}`)).toBe(DEVICE_PROVISIONAL_TTL_SEC);

    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);

    const device = await getDeviceRecord(kv, tokenHash);
    expect(device?.provisional).toBeUndefined();
    expect(JSON.stringify(device)).not.toContain("provisional");
    expect(ttls.get(`device:${tokenHash}`)).toBeUndefined(); // re-put without TTL
  });

  it("does not rewrite a permanent record when lastSeenAt is fresh", async () => {
    const { kv, writes } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);
    expect(writes.get(`device:${tokenHash}`)).toBe(1);

    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(writes.get(`device:${tokenHash}`)).toBe(1); // no extra KV write
  });

  it("refreshes lastSeenAt when it is more than an hour old", async () => {
    const { kv, ttls } = createKv();
    const env = makeEnv(kv);
    const stale = Date.now() - 2 * 3_600_000;
    const { token, tokenHash } = await seedDevice(kv, "xoxp-seeded", { lastSeenAt: stale });

    const res = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);

    const device = await getDeviceRecord(kv, tokenHash);
    expect(device?.lastSeenAt).toBeGreaterThan(stale);
    expect(ttls.get(`device:${tokenHash}`)).toBeUndefined(); // still permanent
  });
});

describe("GET /slack/status", () => {
  const get = (headers: Record<string, string> = {}) => ({ headers });
  const profileResponder =
    (profile: Record<string, unknown>) => (url: string) =>
      url.includes("users.profile.get") ? { ok: true, profile } : { ok: true };

  it("401s without a token, with a malformed token, and with an unknown token", async () => {
    const env = makeEnv(createKv().kv);
    const attempts: Record<string, string>[] = [
      {},
      { authorization: "Bearer wrong_prefix" },
      { authorization: `Bearer ab_${"b".repeat(64)}` },
    ];
    for (const headers of attempts) {
      const res = await api.request("/slack/status", get(headers), env);
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "invalid_token" });
    }
    expect(fetchCalls).toHaveLength(0); // Slack never called
  });

  it("reads the current status with the decrypted xoxp token", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv, "xoxp-live");

    slackResponder = profileResponder({
      status_text: "In a meeting",
      status_emoji: ":calendar:",
      status_expiration: 1_800_000_000,
    });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store"); // per-user data
    expect(statusReadResponseSchema.parse(await res.json())).toEqual({
      readable: true,
      status: { text: "In a meeting", emoji: ":calendar:", expirationSec: 1_800_000_000 },
    });

    const call = fetchCalls.find((f) => f.url.includes("users.profile.get"));
    expect(call).toBeDefined();
    expect(call?.init.method).toBe("GET");
    expect(new Headers(call?.init.headers).get("authorization")).toBe("Bearer xoxp-live");
  });

  it("maps an empty profile status to status: null", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv);

    slackResponder = profileResponder({
      status_text: "",
      status_emoji: "",
      status_expiration: 0,
    });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(statusReadResponseSchema.parse(await res.json())).toEqual({
      readable: true,
      status: null,
    });
  });

  it("defaults a missing status_expiration to 0", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token } = await seedDevice(kv);

    slackResponder = profileResponder({ status_text: "afk", status_emoji: ":zzz:" });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(statusReadResponseSchema.parse(await res.json())).toEqual({
      readable: true,
      status: { text: "afk", emoji: ":zzz:", expirationSec: 0 },
    });
  });

  it("degrades to readable: false when the token lacks users.profile:read", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    slackResponder = () => ({ ok: false, error: "missing_scope" });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);
    expect(statusReadResponseSchema.parse(await res.json())).toEqual({
      readable: false,
      status: null,
    });
    // missing_scope is a healthy legacy token, not a dead one
    expect(await getDeviceRecord(kv, tokenHash)).not.toBeNull();
  });

  it("deletes the device and 401s slack_revoked when Slack reports a dead token", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    slackResponder = () => ({ ok: false, error: "invalid_auth" });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "slack_revoked" });
    expect(await getDeviceRecord(kv, tokenHash)).toBeNull();
  });

  it("maps transient Slack failures to 502 slack_error", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    slackResponder = () => ({ ok: false, error: "fatal_error" });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "slack_error", detail: "fatal_error" });
    expect(await getDeviceRecord(kv, tokenHash)).not.toBeNull(); // transient ≠ revoked
  });

  it("rate-limits at 30/min per device on its own scope", async () => {
    const { kv, data } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    // seed the read counter at the limit (both adjacent buckets to dodge minute rollover)
    const bucket = Math.floor(Date.now() / 60_000);
    data.set(`rl:statusread:${tokenHash}:${bucket}`, "30");
    data.set(`rl:statusread:${tokenHash}:${bucket + 1}`, "30");

    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(429);
    expect(fetchCalls).toHaveLength(0);

    // the write scope has its own budget — POST /status is unaffected
    const status = { text: "claude agent working", emoji: ":robot_face:", expirationSec: 0 };
    const write = await api.request(
      "/status",
      jsonInit({ status }, { authorization: `Bearer ${token}` }),
      env,
    );
    expect(write.status).toBe(200);
  });

  it("promotes a provisional device record to permanent on first authenticated use", async () => {
    const { kv, ttls } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(
      kv,
      "xoxp-live",
      { provisional: true },
      DEVICE_PROVISIONAL_TTL_SEC,
    );
    expect(ttls.get(`device:${tokenHash}`)).toBe(DEVICE_PROVISIONAL_TTL_SEC);

    slackResponder = profileResponder({ status_text: "", status_emoji: "" });
    const res = await api.request(
      "/slack/status",
      get({ authorization: `Bearer ${token}` }),
      env,
    );
    expect(res.status).toBe(200);

    const device = await getDeviceRecord(kv, tokenHash);
    expect(device?.provisional).toBeUndefined();
    expect(JSON.stringify(device)).not.toContain("provisional");
    expect(ttls.get(`device:${tokenHash}`)).toBeUndefined(); // re-put without TTL
  });
});

describe("POST /unlink", () => {
  it("401s without a valid token", async () => {
    const env = makeEnv(createKv().kv);
    const res = await api.request("/unlink", { method: "POST" }, env);
    expect(res.status).toBe(401);
  });

  it("clears the status best-effort and deletes the device", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv, "xoxp-gone");

    const res = await api.request(
      "/unlink",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(await getDeviceRecord(kv, tokenHash)).toBeNull();

    const call = fetchCalls.find((f) => f.url.includes("users.profile.set"));
    expect(JSON.parse(String(call?.init.body))).toEqual({
      profile: { status_text: "", status_emoji: "", status_expiration: 0 },
    });
  });

  it("still unlinks when the Slack clear fails", async () => {
    const { kv } = createKv();
    const env = makeEnv(kv);
    const { token, tokenHash } = await seedDevice(kv);

    slackResponder = () => ({ ok: false, error: "invalid_auth" });
    const res = await api.request(
      "/unlink",
      { method: "POST", headers: { authorization: `Bearer ${token}` } },
      env,
    );
    expect(res.status).toBe(200);
    expect(await getDeviceRecord(kv, tokenHash)).toBeNull();
  });
});
