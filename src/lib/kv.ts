/**
 * Typed accessors for everything the relay keeps in KV. This is the single
 * place that knows key shapes, TTLs, and JSON encoding (see CLAUDE.md §KV Schema).
 */

/** Minimal KV surface the relay uses — KVNamespace satisfies it, tests mock it. */
export interface KVStore {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}

export const PAIR_TTL_SEC = 900;
export const PAIR_STATE_TTL_SEC = 600;
/**
 * After OAuth completes, the pair record holds the plaintext device token until
 * the CLI polls for it. setup polls every 2s, so this bounds that window to a
 * few minutes rather than the full pairing TTL.
 */
export const PAIR_COMPLETE_TTL_SEC = 300;
/** Redelivery grace after the first complete poll, so one dropped response isn't fatal. */
export const PAIR_DELIVERED_TTL_SEC = 60;
/** Provisional device records self-expire unless promoted on first authenticated use. */
export const DEVICE_PROVISIONAL_TTL_SEC = 86_400;
export const RL_TTL_SEC = 120;

/** `pair:{code}` — pending until the Slack OAuth callback completes it. */
export interface PairRecord {
  deviceId: string;
  pollSecretHash: string; // sha256hex(pollSecret)
  status: "pending" | "complete";
  deviceToken?: string; // plaintext; lives only between callback and delivery
  team?: string; // Slack workspace name, for the CLI confirmation line
  deliveredAt?: number; // epoch ms of first token handover (grace TTL started)
}

/** `device:{sha256hex(deviceToken)}` — the long-lived link to a Slack user. */
export interface DeviceRecord {
  slackUserId: string;
  teamId: string;
  teamName: string;
  encToken: string; // AES-GCM "iv.cipher" of the xoxp user token
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms, refreshed at most hourly
  provisional?: true; // set at OAuth callback, cleared on first authenticated use
}

const pairKey = (code: string) => `pair:${code}`;
const pairDeviceKey = (deviceId: string) => `pairdev:${deviceId}`;
const pairStateKey = (nonce: string) => `pairstate:${nonce}`;
const deviceKey = (tokenHash: string) => `device:${tokenHash}`;

/** `rl:{scope}:{key}:{minuteBucket}` — used by lib/ratelimit. */
export const rlKey = (scope: string, key: string, minuteBucket: number) =>
  `rl:${scope}:${key}:${minuteBucket}`;

// --- pair:{code} ---

export async function getPairRecord(kv: KVStore, code: string): Promise<PairRecord | null> {
  const raw = await kv.get(pairKey(code));
  return raw ? (JSON.parse(raw) as PairRecord) : null;
}

export async function putPairRecord(
  kv: KVStore,
  code: string,
  record: PairRecord,
  ttlSec = PAIR_TTL_SEC,
): Promise<void> {
  await kv.put(pairKey(code), JSON.stringify(record), { expirationTtl: ttlSec });
}

export async function deletePairRecord(kv: KVStore, code: string): Promise<void> {
  await kv.delete(pairKey(code));
}

// --- pairdev:{deviceId} → code (poll looks the record up by deviceId) ---

export async function getPairCodeForDevice(
  kv: KVStore,
  deviceId: string,
): Promise<string | null> {
  return kv.get(pairDeviceKey(deviceId));
}

export async function putPairDeviceIndex(
  kv: KVStore,
  deviceId: string,
  code: string,
  ttlSec = PAIR_TTL_SEC,
): Promise<void> {
  await kv.put(pairDeviceKey(deviceId), code, { expirationTtl: ttlSec });
}

export async function deletePairDeviceIndex(kv: KVStore, deviceId: string): Promise<void> {
  await kv.delete(pairDeviceKey(deviceId));
}

// --- pairstate:{nonce} → {code, cookieHash} (OAuth CSRF state, single-use) ---

export interface PairState {
  code: string;
  /** sha256 of the HttpOnly cookie set at /install — binds OAuth to one browser. */
  cookieHash: string;
}

export async function getPairState(kv: KVStore, nonce: string): Promise<PairState | null> {
  const raw = await kv.get(pairStateKey(nonce));
  return raw ? (JSON.parse(raw) as PairState) : null;
}

export async function putPairState(
  kv: KVStore,
  nonce: string,
  state: PairState,
): Promise<void> {
  await kv.put(pairStateKey(nonce), JSON.stringify(state), {
    expirationTtl: PAIR_STATE_TTL_SEC,
  });
}

export async function deletePairState(kv: KVStore, nonce: string): Promise<void> {
  await kv.delete(pairStateKey(nonce));
}

// --- device:{tokenHash} ---

export async function getDeviceRecord(
  kv: KVStore,
  tokenHash: string,
): Promise<DeviceRecord | null> {
  const raw = await kv.get(deviceKey(tokenHash));
  return raw ? (JSON.parse(raw) as DeviceRecord) : null;
}

export async function putDeviceRecord(
  kv: KVStore,
  tokenHash: string,
  record: DeviceRecord,
  ttlSec?: number,
): Promise<void> {
  await kv.put(
    deviceKey(tokenHash),
    JSON.stringify(record),
    ttlSec === undefined ? undefined : { expirationTtl: ttlSec },
  );
}

export async function deleteDeviceRecord(kv: KVStore, tokenHash: string): Promise<void> {
  await kv.delete(deviceKey(tokenHash));
}
