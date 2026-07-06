/**
 * WebCrypto helpers shared by the relay routes. Everything here runs on both
 * workerd and Node >= 20 (tests) — no Node-only crypto imports.
 */

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Pairing codes avoid ambiguous glyphs (0/O, 1/I). 32 chars → uniform via & 31. */
const PAIR_CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

const AES_GCM_IV_BYTES = 12;

function bytesToHex(bytes: Uint8Array): string {
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

// Return type pinned to ArrayBuffer so results satisfy WebCrypto's BufferSource.
function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export async function sha256hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(input));
  return bytesToHex(new Uint8Array(digest));
}

/** `chars` lowercase hex characters of CSPRNG randomness. */
export function randomHex(chars: number): string {
  const bytes = new Uint8Array(Math.ceil(chars / 2));
  crypto.getRandomValues(bytes);
  return bytesToHex(bytes).slice(0, chars);
}

/** Short human-confirmable pairing code, e.g. "K7WQPX3M". */
export function pairCode(length = 8): string {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = "";
  for (const b of bytes) out += PAIR_CODE_ALPHABET[b & 31];
  return out;
}

async function importAesKey(base64Key: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", base64ToBytes(base64Key), "AES-GCM", false, [
    "encrypt",
    "decrypt",
  ]);
}

/** AES-256-GCM. Returns "iv.ciphertext", both base64 (base64 never contains "."). */
export async function aesGcmEncrypt(plain: string, base64Key: string): Promise<string> {
  const key = await importAesKey(base64Key);
  const iv = crypto.getRandomValues(new Uint8Array(AES_GCM_IV_BYTES));
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, encoder.encode(plain));
  return `${bytesToBase64(iv)}.${bytesToBase64(new Uint8Array(cipher))}`;
}

/** Inverse of aesGcmEncrypt. Throws on malformed payload or GCM tag mismatch. */
export async function aesGcmDecrypt(payload: string, base64Key: string): Promise<string> {
  const [ivB64, cipherB64] = payload.split(".");
  if (!ivB64 || !cipherB64) throw new Error("malformed encrypted payload");
  const key = await importAesKey(base64Key);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: base64ToBytes(ivB64) },
    key,
    base64ToBytes(cipherB64),
  );
  return decoder.decode(plain);
}

/** Constant-time comparison for equal-length hex digests (length leak is fine). */
export function timingSafeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
