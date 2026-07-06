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
export const RL_TTL_SEC = 120;

/** `pair:{code}` — pending until the Slack OAuth callback completes it. */
export interface PairRecord {
  deviceId: string;
  pollSecretHash: string; // sha256hex(pollSecret)
  status: "pending" | "complete";
  deviceToken?: string; // plaintext; lives only between callback and first poll
  team?: string; // Slack workspace name, for the CLI confirmation line
}

/** `device:{sha256hex(deviceToken)}` — the long-lived link to a Slack user. */
export interface DeviceRecord {
  slackUserId: string;
  teamId: string;
  teamName: string;
  encToken: string; // AES-GCM "iv.cipher" of the xoxp user token
  createdAt: number; // epoch ms
  lastSeenAt: number; // epoch ms, refreshed at most hourly
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

// --- pairstate:{nonce} → code (OAuth CSRF state, single-use) ---

export async function getPairState(kv: KVStore, nonce: string): Promise<string | null> {
  return kv.get(pairStateKey(nonce));
}

export async function putPairState(kv: KVStore, nonce: string, code: string): Promise<void> {
  await kv.put(pairStateKey(nonce), code, { expirationTtl: PAIR_STATE_TTL_SEC });
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
): Promise<void> {
  await kv.put(deviceKey(tokenHash), JSON.stringify(record));
}

export async function deleteDeviceRecord(kv: KVStore, tokenHash: string): Promise<void> {
  await kv.delete(deviceKey(tokenHash));
}
