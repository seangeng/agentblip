import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { daemonSecretPath } from "./paths";

/**
 * Loopback TCP is reachable by every local user on a shared host, so the
 * daemon requires a per-run bearer secret on all endpoints except /health.
 * The secret lives in the 0600 state dir — only the owning user can read it.
 */
export function createDaemonSecret(file = daemonSecretPath()): string {
  const secret = crypto.randomBytes(32).toString("hex");
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  // writeFileSync's mode only applies on create — enforce on rewrite too.
  fs.chmodSync(file, 0o600);
  return secret;
}

/** Read fresh on every request so clients follow daemon restarts. */
export function readDaemonSecret(file = daemonSecretPath()): string | undefined {
  try {
    const secret = fs.readFileSync(file, "utf8").trim();
    return secret || undefined;
  } catch {
    return undefined;
  }
}

/** Constant-time comparison — never leak the secret through timing. */
export function secretsEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}
