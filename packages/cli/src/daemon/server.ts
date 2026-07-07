import http from "node:http";
import { sessionEventSchema } from "@agentblip/core";
import type { SessionEvent, SlackStatus, StatusSnapshot } from "@agentblip/core";
import { secretsEqual } from "../lib/daemon-auth";
import type { OwnershipSummary } from "./pusher";

const MAX_BODY_BYTES = 64 * 1024;

export interface DaemonServerDeps {
  /** Per-daemon bearer secret required on every endpoint except /health. */
  secret: string;
  applyEvent(event: SessionEvent): void;
  getState(): {
    snapshot: StatusSnapshot;
    formatted: SlackStatus | null;
    paused: boolean;
    lastError?: string;
  };
  getLastError(): string | undefined;
  /** Ownership guard summary — included in /state and /health. */
  getOwnership(): OwnershipSummary;
  pause(): Promise<void>;
  resume(): void;
}

function json(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error("body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function isAuthorized(req: http.IncomingMessage, secret: string): boolean {
  const header = req.headers.authorization;
  if (typeof header !== "string" || !header.startsWith("Bearer ")) return false;
  return secretsEqual(header.slice("Bearer ".length), secret);
}

/** Loopback HTTP API — the single integration surface for all adapters. */
export function createDaemonServer(deps: DaemonServerDeps): http.Server {
  const startedAt = Date.now();

  async function handle(
    req: http.IncomingMessage,
    res: http.ServerResponse,
  ): Promise<void> {
    const method = req.method ?? "GET";
    const url = req.url ?? "/";
    try {
      if (method === "GET" && url === "/health") {
        json(res, 200, {
          ok: true,
          pid: process.pid,
          uptimeSec: Math.round((Date.now() - startedAt) / 1000),
          lastError: deps.getLastError(),
          ownership: deps.getOwnership(),
        });
        return;
      }
      // Loopback TCP is reachable by every local user on shared hosts — all
      // session data and control endpoints require the per-daemon secret.
      if (!isAuthorized(req, deps.secret)) {
        json(res, 401, { ok: false, error: "unauthorized" });
        return;
      }
      if (method === "POST" && url === "/event") {
        const body = await readBody(req);
        let raw: unknown;
        try {
          raw = JSON.parse(body) as unknown;
        } catch {
          json(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const parsed = sessionEventSchema.safeParse(raw);
        if (!parsed.success) {
          const detail = parsed.error.issues
            .map((i) => `${i.path.join(".")}: ${i.message}`)
            .join("; ");
          json(res, 400, { ok: false, error: detail });
          return;
        }
        deps.applyEvent(parsed.data);
        json(res, 200, { ok: true });
        return;
      }
      if (method === "GET" && url === "/state") {
        json(res, 200, { ...deps.getState(), ownership: deps.getOwnership() });
        return;
      }
      if (method === "POST" && url === "/pause") {
        // Respond immediately: pause() flips the flag synchronously but then
        // awaits a status-clear push (up to 10s) — far past the CLI's 1.5s
        // request timeout. The clearing push runs in the background.
        void deps.pause().catch(() => {});
        json(res, 200, { ok: true, paused: true });
        return;
      }
      if (method === "POST" && url === "/resume") {
        deps.resume();
        json(res, 200, { ok: true, paused: false });
        return;
      }
      json(res, 404, { ok: false, error: "not found" });
    } catch (err) {
      const message = err instanceof Error ? err.message : "internal error";
      json(res, message === "body too large" ? 413 : 500, {
        ok: false,
        error: message,
      });
    }
  }

  return http.createServer((req, res) => {
    void handle(req, res);
  });
}
