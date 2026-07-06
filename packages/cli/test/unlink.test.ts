import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUnlink } from "../src/commands/unlink";
import { loadConfig } from "../src/lib/config";
import { configPath } from "../src/lib/paths";

let configDirTmp: string;
let savedConfigHome: string | undefined;

beforeEach(() => {
  configDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-unlink-"));
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = configDirTmp;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  fs.rmSync(configDirTmp, { recursive: true, force: true });
});

function writeConfig(config: Record<string, unknown>): void {
  fs.mkdirSync(path.dirname(configPath()), { recursive: true });
  fs.writeFileSync(configPath(), JSON.stringify(config, null, 2));
}

describe("runUnlink", () => {
  it("removes the token and flips relay mode to console so the daemon can still start", async () => {
    writeConfig({
      mode: "relay",
      deviceToken: "ab_dead",
      // nothing listens on port 1 — the relay call fails fast and falls back
      relayUrl: "http://127.0.0.1:1",
    });

    await runUnlink();

    const config = loadConfig(configPath());
    expect(config.deviceToken).toBeUndefined();
    expect(config.mode).toBe("console");
  });

  it("is a no-op without a saved device token", async () => {
    writeConfig({ mode: "relay", relayUrl: "http://127.0.0.1:1" });
    await runUnlink();
    const config = loadConfig(configPath());
    expect(config.mode).toBe("relay"); // untouched — nothing was unlinked
  });
});
