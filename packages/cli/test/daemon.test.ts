import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runDaemon } from "../src/daemon";
import { configSchema } from "../src/lib/config";
import type { Config } from "../src/lib/config";
import { pidFilePath } from "../src/lib/paths";

let stateDirTmp: string;
let savedStateHome: string | undefined;

beforeEach(() => {
  stateDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-daemon-"));
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_STATE_HOME = stateDirTmp;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
  fs.rmSync(stateDirTmp, { recursive: true, force: true });
});

const config = (over: Record<string, unknown> = {}): Config =>
  configSchema.parse({
    adapters: { codex: { enabled: false }, claudeCode: { enabled: false } },
    ...over,
  });

describe("runDaemon startup failures", () => {
  it("does not leave a pidfile when the sink cannot be created", async () => {
    // unlink leaves relay mode + no token in old configs; the daemon must
    // fail without claiming the pidfile, or `agentblip stop` lies later.
    await expect(runDaemon(config({ mode: "relay" }))).rejects.toThrow(/device token/);
    expect(fs.existsSync(pidFilePath())).toBe(false);
  });

  it("does not leave a pidfile when the port is already taken", async () => {
    const blocker = net.createServer();
    await new Promise<void>((resolve) => {
      blocker.listen(0, "127.0.0.1", resolve);
    });
    const port = (blocker.address() as net.AddressInfo).port;
    try {
      await expect(runDaemon(config({ mode: "console", port }))).rejects.toThrow();
      expect(fs.existsSync(pidFilePath())).toBe(false);
    } finally {
      await new Promise((resolve) => blocker.close(resolve));
    }
  });

  it("refuses to start when a live daemon owns the pidfile", async () => {
    fs.mkdirSync(path.dirname(pidFilePath()), { recursive: true });
    // our own (test-runner) pid is definitely alive and not process.pid+? — use
    // the parent pid, which is alive for the duration of the test
    fs.writeFileSync(pidFilePath(), `${process.ppid}\n`);
    await expect(runDaemon(config({ mode: "console" }))).rejects.toThrow(
      /already running/,
    );
  });
});
