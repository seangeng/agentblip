import { describe, expect, it } from "vitest";
import {
  aesGcmDecrypt,
  aesGcmEncrypt,
  pairCode,
  randomHex,
  sha256hex,
  timingSafeEqualHex,
} from "./crypto";

const KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(7)));
const OTHER_KEY = btoa(String.fromCharCode(...new Uint8Array(32).fill(8)));

describe("sha256hex", () => {
  it("matches known SHA-256 vectors", async () => {
    expect(await sha256hex("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    expect(await sha256hex("")).toBe(
      "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    );
  });
});

describe("randomHex", () => {
  it("emits exactly n lowercase hex chars, including odd lengths", () => {
    expect(randomHex(16)).toMatch(/^[0-9a-f]{16}$/);
    expect(randomHex(64)).toMatch(/^[0-9a-f]{64}$/);
    expect(randomHex(7)).toMatch(/^[0-9a-f]{7}$/);
  });

  it("does not repeat across calls", () => {
    expect(randomHex(32)).not.toBe(randomHex(32));
  });
});

describe("pairCode", () => {
  it("is 8 chars from the unambiguous alphabet (no 0/O/1/I)", () => {
    for (let i = 0; i < 50; i++) {
      const code = pairCode();
      expect(code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{8}$/);
      expect(code).not.toMatch(/[0O1I]/);
    }
  });
});

describe("aesGcm", () => {
  it("round-trips and produces a fresh IV per encryption", async () => {
    const payload = await aesGcmEncrypt("xoxp-secret-token", KEY);
    expect(payload).toMatch(/^[A-Za-z0-9+/=]+\.[A-Za-z0-9+/=]+$/);
    expect(await aesGcmDecrypt(payload, KEY)).toBe("xoxp-secret-token");
    expect(await aesGcmEncrypt("xoxp-secret-token", KEY)).not.toBe(payload);
  });

  it("rejects tampered ciphertext", async () => {
    const payload = await aesGcmEncrypt("secret", KEY);
    const [iv, cipher] = payload.split(".");
    const flipped = cipher[0] === "A" ? "B" : "A";
    await expect(aesGcmDecrypt(`${iv}.${flipped}${cipher.slice(1)}`, KEY)).rejects.toThrow();
  });

  it("rejects the wrong key", async () => {
    const payload = await aesGcmEncrypt("secret", KEY);
    await expect(aesGcmDecrypt(payload, OTHER_KEY)).rejects.toThrow();
  });

  it("rejects malformed payloads", async () => {
    await expect(aesGcmDecrypt("no-dot-here", KEY)).rejects.toThrow("malformed");
  });
});

describe("timingSafeEqualHex", () => {
  it("compares hex digests correctly", async () => {
    const a = await sha256hex("hello");
    expect(timingSafeEqualHex(a, a)).toBe(true);
    expect(timingSafeEqualHex(a, await sha256hex("world"))).toBe(false);
    expect(timingSafeEqualHex(a, a.slice(0, 32))).toBe(false);
  });
});
