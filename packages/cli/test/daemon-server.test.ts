import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@agentblip/core";
import type { SafeConfig } from "../src/lib/config";
import type { OwnershipSummary } from "../src/daemon/pusher";
import { createDaemonServer } from "../src/daemon/server";
import { createDaemonSecret } from "../src/lib/daemon-auth";
import { getHealth, getState, pauseDaemon, postEvent } from "../src/lib/daemon-client";

const SECRET = "a".repeat(64);

interface TestHarness {
  server: http.Server;
  port: number;
  applied: SessionEvent[];
  lastError: { value?: string };
  ownership: { value: OwnershipSummary };
  pauseStarted: { value: boolean };
  config: { value: SafeConfig };
  configPatches: Array<Record<string, unknown>>;
}

const BASE_CONFIG: SafeConfig = {
  mode: "relay",
  relayUrl: "https://agentblip.com",
  port: 4519,
  granularity: "count",
  statusPolicy: "respect",
  showProject: false,
  repoPrefix: true,
  statusTtlSec: 300,
  debounceMs: 10000,
};

async function startServer(): Promise<TestHarness> {
  const applied: SessionEvent[] = [];
  const lastError: { value?: string } = {};
  const ownership: { value: OwnershipSummary } = {
    value: { backedOff: false, savedPrior: false, policy: "respect" },
  };
  const pauseStarted = { value: false };
  const config = { value: { ...BASE_CONFIG } };
  const configPatches: Array<Record<string, unknown>> = [];
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
    getOwnership: () => ownership.value,
    pause: () => {
      pauseStarted.value = true;
      return new Promise<void>(() => {}); // hangs — like a slow sink push
    },
    resume: () => {},
    getConfig: () => config.value,
    setConfig: (patch) => {
      configPatches.push(patch);
      config.value = { ...config.value, ...patch };
      return config.value;
    },
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as AddressInfo).port;
  return { server, port, applied, lastError, ownership, pauseStarted, config, configPatches };
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

  it("includes the ownership summary in /state and /health", async () => {
    h.ownership.value = { backedOff: true, savedPrior: true, policy: "overwrite" };

    const state = await fetch(url("/state"), {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(state.status).toBe(200);
    const stateBody = (await state.json()) as { ownership: OwnershipSummary };
    expect(stateBody.ownership).toEqual(h.ownership.value);

    const health = await fetch(url("/health"));
    expect(health.status).toBe(200);
    const healthBody = (await health.json()) as { ownership: OwnershipSummary };
    expect(healthBody.ownership).toEqual(h.ownership.value);
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

  it("GET /config returns the token-free config view", async () => {
    const res = await fetch(url("/config"), {
      headers: { authorization: `Bearer ${SECRET}` },
    });
    expect(res.status).toBe(200);
    expect((await res.json()) as SafeConfig).toEqual(BASE_CONFIG);
  });

  it("POST /config applies a valid live patch and echoes the new config", async () => {
    const res = await fetch(url("/config"), {
      method: "POST",
      headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
      body: JSON.stringify({ granularity: "activity", statusPolicy: "overwrite" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as SafeConfig;
    expect(body.granularity).toBe("activity");
    expect(body.statusPolicy).toBe("overwrite");
    expect(h.configPatches).toEqual([{ granularity: "activity", statusPolicy: "overwrite" }]);
  });

  it("POST /config rejects unknown/immutable keys and bad values", async () => {
    for (const bad of [{ port: 9000 }, { deviceToken: "x" }, { granularity: "loud" }]) {
      const res = await fetch(url("/config"), {
        method: "POST",
        headers: { authorization: `Bearer ${SECRET}`, "content-type": "application/json" },
        body: JSON.stringify(bad),
      });
      expect(res.status).toBe(400);
    }
    expect(h.configPatches).toHaveLength(0); // nothing applied
  });

  it("/config requires the daemon secret", async () => {
    expect((await fetch(url("/config"))).status).toBe(401);
    const post = await fetch(url("/config"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    expect(post.status).toBe(401);
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
