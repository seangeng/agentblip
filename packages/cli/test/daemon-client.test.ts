import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { configSchema } from "../src/lib/config";
import type { Config } from "../src/lib/config";
import {
  START_FAILURE_COOLDOWN_MS,
  ensureDaemon,
  inStartFailureCooldown,
  sinkConfigured,
} from "../src/lib/daemon-client";
import { logFilePath, startFailedMarkerPath } from "../src/lib/paths";

// port 1 is never listening — isDaemonUp fails immediately
const DEAD_PORT = 1;

const config = (over: Record<string, unknown> = {}): Config =>
  configSchema.parse({ port: DEAD_PORT, ...over });

let stateDirTmp: string;
let savedStateHome: string | undefined;

beforeEach(() => {
  stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-client-"));
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDirTmp;
});

afterEach(() => {
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  fs.rmSync(stateDirTmp, { recursive: true, force: true });
});

describe("sinkConfigured", () => {
  it("rejects relay mode without a device token (post-unlink state)", () => {
    expect(sinkConfigured(config({ mode: "relay" }))).toBe(false);
    expect(sinkConfigured(config({ mode: "relay", deviceToken: "ab_x" }))).toBe(true);
  });

  it("rejects slack mode without a token, allows console always", () => {
    expect(sinkConfigured(config({ mode: "slack" }))).toBe(false);
    expect(sinkConfigured(config({ mode: "slack", slackToken: "xoxp-1" }))).toBe(true);
    expect(sinkConfigured(config({ mode: "console" }))).toBe(true);
  });
});

describe("inStartFailureCooldown", () => {
  it("is false with no marker", () => {
    expect(inStartFailureCooldown()).toBe(false);
  });

  it("is true while the marker is fresh and false once it expires", () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    const now = Date.now();
    fs.writeFileSync(startFailedMarkerPath(), `${now}\n`);
    expect(inStartFailureCooldown(now)).toBe(true);
    expect(inStartFailureCooldown(now + START_FAILURE_COOLDOWN_MS - 1)).toBe(true);
    expect(inStartFailureCooldown(now + START_FAILURE_COOLDOWN_MS)).toBe(false);
  });

  it("is false on a garbage marker", () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), "not-a-timestamp\n");
    expect(inStartFailureCooldown()).toBe(false);
  });
});

describe("ensureDaemon", () => {
  it("does not spawn when the sink is unconfigured (relay mode, no token)", async () => {
    const result = await ensureDaemon(config({ mode: "relay" }));
    expect(result).toBe(false);
    // spawnDetachedDaemon would have created the daemon log
    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("does not re-spawn while a failed start is in cooldown", async () => {
    fs.mkdirSync(path.dirname(startFailedMarkerPath()), { recursive: true });
    fs.writeFileSync(startFailedMarkerPath(), `${Date.now()}\n`);
    const result = await ensureDaemon(config({ mode: "console" }));
    expect(result).toBe(false);
    expect(fs.existsSync(logFilePath())).toBe(false);
  });

  it("respects autoStartDaemon: false", async () => {
    const result = await ensureDaemon(config({ autoStartDaemon: false }));
    expect(result).toBe(false);
    expect(fs.existsSync(logFilePath())).toBe(false);
  });
});
