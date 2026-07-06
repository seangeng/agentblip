import type { KVStore } from "./kv";
import { RL_TTL_SEC, rlKey } from "./kv";

/**
 * Fixed-window minute-bucket counter (house pattern: rl:{scope}:{key}:{bucket},
 * TTL 120s so buckets self-expire). KV counters are eventually consistent, so
 * this is a soft limit — fine for abuse damping, not billing.
 *
 * @returns true when the request is allowed, false when over `limit`.
 */
export async function rateLimit(
  kv: KVStore,
  scope: string,
  key: string,
  limit: number,
  nowMs = Date.now(),
): Promise<boolean> {
  const bucket = Math.floor(nowMs / 60_000);
  const counterKey = rlKey(scope, key, bucket);
  const count = Number((await kv.get(counterKey)) ?? "0");
  if (count >= limit) return false;
  await kv.put(counterKey, String(count + 1), { expirationTtl: RL_TTL_SEC });
  return true;
}
