import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runUnlink } from "../src/commands/unlink";
import { loadConfig } from "../src/lib/config";
import { saveOwnershipState } from "../src/lib/ownership-state";
import { configPath, ownershipStatePath } from "../src/lib/paths";

let configDirTmp: string;
let savedConfigHome: string | undefined;
let savedStateHome: string | undefined;

beforeEach(() => {
  configDirTmp = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-unlink-"));
  savedConfigHome = process.env.XDG_CONFIG_HOME;
  savedStateHome = process.env.XDG_STATE_HOME;
  process.env.XDG_CONFIG_HOME = configDirTmp;
  process.env.XDG_STATE_HOME = configDirTmp;
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  if (savedConfigHome === undefined) delete process.env.XDG_CONFIG_HOME;
  else process.env.XDG_CONFIG_HOME = savedConfigHome;
  if (savedStateHome === undefined) delete process.env.XDG_STATE_HOME;
  else process.env.XDG_STATE_HOME = savedStateHome;
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

  it("leaves a foreign status untouched (sends clear:false) and resets ownership", async () => {
    writeConfig({ mode: "relay", deviceToken: "ab_live", relayUrl: "https://relay.test" });
    const ours = { text: "claude agent working", emoji: ":robot_face:", expirationSec: 0 };
    const foreign = { text: "On vacation", emoji: ":palm_tree:", expirationSec: 0 };
    saveOwnershipState({ lastPushed: ours, savedPrior: null, backedOff: false });
    expect(fs.existsSync(ownershipStatePath())).toBe(true);

    let unlinkBody: unknown;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.includes("/api/slack/status")) {
          return new Response(JSON.stringify({ readable: true, status: foreign }), { status: 200 });
        }
        unlinkBody = JSON.parse(String(init?.body));
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }),
    );

    await runUnlink();

    // The human's status is foreign to us → we must NOT clear it.
    expect(unlinkBody).toEqual({ clear: false });
    // Ownership file reset so a later re-pair can't resurrect a stale prior.
    expect(fs.existsSync(ownershipStatePath())).toBe(false);
    expect(loadConfig(configPath()).deviceToken).toBeUndefined();
  });
});
