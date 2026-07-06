import type { KVStore } from "./kv";
import { RL_TTL_SEC, rlKey } from "./kv";

/**
 * Fixed-window minute-bucket counter (house pattern: rl:{scope}:{key}:{bucket},
 * TTL 120s so buckets self-expire). KV counters are eventually consistent and
 * the read→check→write below is non-atomic (TOCTOU): a concurrent burst can
 * overshoot the configured limit. Both are accepted for this threat model —
 * this is a soft limit for abuse damping, not billing or a hard security
 * boundary.
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
  try {
    await kv.put(counterKey, String(count + 1), { expirationTtl: RL_TTL_SEC });
  } catch {
    // KV rejects >1 write/sec to the same key, so a same-second burst can make
    // this put throw. The limiter is soft — never turn a counting failure into
    // a 500 on an otherwise-allowed request.
  }
  return true;
}
