import { describe, expect, it } from "vitest";
import type { KVStore } from "./kv";
import { rateLimit } from "./ratelimit";

function createKv() {
  const data = new Map<string, string>();
  const ttls = new Map<string, number | undefined>();
  const kv: KVStore = {
    async get(key) {
      return data.get(key) ?? null;
    },
    async put(key, value, options) {
      data.set(key, value);
      ttls.set(key, options?.expirationTtl);
    },
    async delete(key) {
      data.delete(key);
      ttls.delete(key);
    },
  };
  return { kv, data, ttls };
}

const T0 = 1_751_800_000_000; // fixed epoch ms so bucket math is deterministic

describe("rateLimit", () => {
  it("allows up to the limit within one minute, then blocks", async () => {
    const { kv } = createKv();
    for (let i = 0; i < 5; i++) {
      expect(await rateLimit(kv, "pairstart", "1.2.3.4", 5, T0 + i * 1000)).toBe(true);
    }
    expect(await rateLimit(kv, "pairstart", "1.2.3.4", 5, T0 + 5000)).toBe(false);
  });

  it("does not increment the counter once over the limit", async () => {
    const { kv, data } = createKv();
    for (let i = 0; i < 7; i++) await rateLimit(kv, "s", "k", 5, T0);
    const bucket = Math.floor(T0 / 60_000);
    expect(data.get(`rl:s:k:${bucket}`)).toBe("5");
  });

  it("resets in the next minute bucket", async () => {
    const { kv } = createKv();
    for (let i = 0; i < 5; i++) await rateLimit(kv, "s", "k", 5, T0);
    expect(await rateLimit(kv, "s", "k", 5, T0)).toBe(false);
    expect(await rateLimit(kv, "s", "k", 5, T0 + 60_000)).toBe(true);
  });

  it("isolates scopes and keys", async () => {
    const { kv } = createKv();
    for (let i = 0; i < 5; i++) await rateLimit(kv, "s", "a", 5, T0);
    expect(await rateLimit(kv, "s", "a", 5, T0)).toBe(false);
    expect(await rateLimit(kv, "s", "b", 5, T0)).toBe(true);
    expect(await rateLimit(kv, "other", "a", 5, T0)).toBe(true);
  });

  it("writes house-pattern keys with a 120s TTL", async () => {
    const { kv, ttls } = createKv();
    await rateLimit(kv, "status", "deadbeef", 30, T0);
    const bucket = Math.floor(T0 / 60_000);
    expect(ttls.get(`rl:status:deadbeef:${bucket}`)).toBe(120);
  });
});
