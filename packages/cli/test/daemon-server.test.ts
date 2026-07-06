import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@agentblip/core";
import { createDaemonServer } from "../src/daemon/server";
import { createDaemonSecret } from "../src/lib/daemon-auth";
import { getHealth, getState, pauseDaemon, postEvent } from "../src/lib/daemon-client";

const SECRET = "a".repeat(64);

interface TestHarness {
  server: http.Server;
  port: number;
  applied: SessionEvent[];
  lastError: { value?: string };
  pauseStarted: { value: boolean };
}

async function startServer(): Promise<TestHarness> {
  const applied: SessionEvent[] = [];
  const lastError: { value?: string } = {};
  const pauseStarted = { value: false };
  const server = createDaemonServer({
    secret: SECRET,
    applyEvent: (event) => applied.push(event),
    getState: () => ({
      snapshot: {
        sessions: [],
        working: 0,
        waiting: 0,
        idle: 0,
        total: 0,
        signature: "",
      },
      formatted: null,
      paused: false,
      lastError: lastError.value,
    }),
    getLastError: () => lastError.value,
    pause: () => {
      pauseStarted.value = true;
      return new Promise<void>(() => {}); // hangs — like a slow sink push
    },
    resume: () => {},
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, applied, lastError, pauseStarted };
}

const event: SessionEvent = {
  source: "claude-code",
  sessionId: "s1",
  kind: "working",
};

describe("daemon server auth", () => {
  let h: TestHarness;

  beforeEach(async () => {
    h = await startServer();
  });

  afterEach(() => {
    h.server.close();
  });

  const url = (pathname: string): string => `http://127.0.0.1:${h.port}${pathname}`;

  it("rejects unauthenticated requests on every endpoint except /health", async () => {
    for (const [method, pathname] of [
      ["POST", "/event"],
      ["GET", "/state"],
      ["POST", "/pause"],
      ["POST", "/resume"],
    ] as const) {
      const res = await fetch(url(pathname), {
        method,
        headers: { "content-type": "application/json" },
        body: method === "POST" ? JSON.stringify(event) : undefined,
      });
      expect(res.status, `${method} ${pathname}`).toBe(401);
    }
    expect(h.applied).toHaveLength(0);

    const health = await fetch(url("/health"));
    expect(health.status).toBe(200);
  });

  it("rejects a wrong bearer secret", async () => {
    const res = await fetch(url("/state"), {
      headers: { authorization: `Bearer ${"b".repeat(64)}` },
    });
    expect(res.status).toBe(401);
  });

  it("accepts requests carrying the daemon secret", async () => {
    const res = await fetch(url("/event"), {
      method: "POST",
      headers: {
        authorization: `Bearer ${SECRET}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(event),
    });
    expect(res.status).toBe(200);
    expect(h.applied).toHaveLength(1);
  });

  it("surfaces lastError via /health without auth", async () => {
    h.lastError.value = "device unlinked or token revoked";
    const res = await fetch(url("/health"));
    const body = (await res.json()) as { ok: boolean; lastError?: string };
    expect(body.ok).toBe(true);
    expect(body.lastError).toBe("device unlinked or token revoked");
  });

  it("responds to /pause immediately even when the clearing push hangs", async () => {
    // the CLI aborts after 1.5s — /pause must not await the sink push
    const started = Date.now();
    const res = await fetch(url("/pause"), {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as object).toEqual({ ok: true, paused: true });
    expect(Date.now() - started).toBeLessThan(1000);
    expect(h.pauseStarted.value).toBe(true);
  });
});

describe("daemon client auth integration", () => {
  let h: TestHarness;
  let stateDirTmp: string;
  let savedStateHome: string | undefined;

  beforeEach(async () => {
    stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-state-"));
    savedStateHome = process.env.XDG_STATE_HOME;
    process.env.XDG_STATE_HOME = stateDirTmp;
    h = await startServer();
  });

  afterEach(() => {
    h.server.close();
    if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
    else process.env.XDG_STATE_HOME = savedStateHome;
    fs.rmSync(stateDirTmp, { recursive: true, force: true });
  });

  it("daemon-client reads the secret file and authenticates", async () => {
    // simulate the daemon having written its secret into the state dir
    const written = createDaemonSecret();
    expect(written).toHaveLength(64);
    const secretFile = path.join(stateDirTmp, "agentblip", "daemon.secret");
    expect(fs.statSync(secretFile).mode & 0o777).toBe(0o600);
    // our test server uses a fixed secret — rewrite the file to match
    fs.writeFileSync(secretFile, `${SECRET}\n`);

    await expect(postEvent(h.port, event)).resolves.toEqual({ ok: true });
    expect(h.applied).toHaveLength(1);
    const state = await getState(h.port);
    expect(state.paused).toBe(false);
    const health = await getHealth(h.port);
    expect(health.ok).toBe(true);
  });

  it("daemon-client fails cleanly when the secret is missing", async () => {
    await expect(postEvent(h.port, event)).rejects.toThrow(/401/);
  });

  it("pauseDaemon returns without waiting for the sink push", async () => {
    fs.mkdirSync(path.join(stateDirTmp, "agentblip"), { recursive: true });
    fs.writeFileSync(path.join(stateDirTmp, "agentblip", "daemon.secret"), `${SECRET}\n`);
    await expect(pauseDaemon(h.port)).resolves.toEqual({ ok: true, paused: true });
  });
});
