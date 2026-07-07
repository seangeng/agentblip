import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_DAEMON_PORT, DEFAULT_DEBOUNCE_MS, DEFAULT_STATUS_TTL_SEC } from "@agentblip/core";
import { loadConfig, loadConfigSafe, saveConfig } from "../src/lib/config";

let dir: string;
let file: string;
const savedEnv: Record<string, string | undefined> = {};
const ENV_KEYS = [
  "AGENTBLIP_RELAY_URL",
  "AGENTBLIP_TOKEN",
  "AGENTBLIP_PORT",
  "AGENTBLIP_STATUS_POLICY",
];

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-config-"));
  file = path.join(dir, "config.json");
  for (const key of ENV_KEYS) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  for (const key of ENV_KEYS) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe("config", () => {
  it("returns full defaults when the file is missing", () => {
    const config = loadConfig(file);
    expect(config.mode).toBe("console");
    expect(config.relayUrl).toBe("https://agentblip.com");
    expect(config.port).toBe(DEFAULT_DAEMON_PORT);
    expect(config.granularity).toBe("count");
    expect(config.statusPolicy).toBe("respect");
    expect(config.showProject).toBe(false);
    expect(config.statusTtlSec).toBe(DEFAULT_STATUS_TTL_SEC);
    expect(config.debounceMs).toBe(DEFAULT_DEBOUNCE_MS);
    expect(config.adapters.claudeCode.enabled).toBe(true);
    expect(config.adapters.codex.enabled).toBe(true);
    expect(config.autoStartDaemon).toBe(true);
  });

  it("round-trips through save/load", () => {
    const config = loadConfig(file);
    config.mode = "relay";
    config.deviceToken = "ab_deadbeef";
    config.granularity = "activity";
    config.hideProjects = ["secret-project"];
    saveConfig(config, file);

    const reloaded = loadConfig(file);
    expect(reloaded).toEqual(config);
  });

  it("saves with 600 permissions", () => {
    saveConfig(loadConfig(file), file);
    const mode = fs.statSync(file).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("fills defaults for a partial file", () => {
    fs.writeFileSync(file, JSON.stringify({ mode: "relay", deviceToken: "ab_x" }));
    const config = loadConfig(file);
    expect(config.mode).toBe("relay");
    expect(config.deviceToken).toBe("ab_x");
    expect(config.port).toBe(DEFAULT_DAEMON_PORT);
    expect(config.adapters.codex.enabled).toBe(true);
  });

  it("throws on corrupt JSON, while loadConfigSafe falls back to defaults", () => {
    fs.writeFileSync(file, "{not json");
    expect(() => loadConfig(file)).toThrow(/invalid JSON/);
    expect(loadConfigSafe(file).mode).toBe("console");
  });

  it("rejects invalid values with a descriptive error", () => {
    fs.writeFileSync(file, JSON.stringify({ granularity: "everything" }));
    expect(() => loadConfig(file)).toThrow(/granularity/);
  });

  it("applies env overrides", () => {
    process.env.AGENTBLIP_RELAY_URL = "https://relay.example.com";
    process.env.AGENTBLIP_TOKEN = "ab_envtoken";
    process.env.AGENTBLIP_PORT = "9123";
    const config = loadConfig(file);
    expect(config.relayUrl).toBe("https://relay.example.com");
    expect(config.deviceToken).toBe("ab_envtoken");
    expect(config.port).toBe(9123);
  });

  it("ignores an invalid AGENTBLIP_PORT", () => {
    process.env.AGENTBLIP_PORT = "not-a-port";
    expect(loadConfig(file).port).toBe(DEFAULT_DAEMON_PORT);
  });

  it("applies AGENTBLIP_STATUS_POLICY, ignoring invalid values", () => {
    process.env.AGENTBLIP_STATUS_POLICY = "overwrite";
    expect(loadConfig(file).statusPolicy).toBe("overwrite");
    process.env.AGENTBLIP_STATUS_POLICY = "clobber";
    expect(loadConfig(file).statusPolicy).toBe("respect");
  });

  it("rejects an invalid statusPolicy in the file", () => {
    fs.writeFileSync(file, JSON.stringify({ statusPolicy: "clobber" }));
    expect(() => loadConfig(file)).toThrow(/statusPolicy/);
  });

  it("round-trips statusPolicy through save/load", () => {
    const config = loadConfig(file);
    config.statusPolicy = "overwrite";
    saveConfig(config, file);
    expect(loadConfig(file).statusPolicy).toBe("overwrite");
  });
});
