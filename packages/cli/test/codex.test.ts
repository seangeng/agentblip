import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CODEX_NOTIFY_LINE,
  installCodexNotify,
  isCodexNotifyInstalled,
  mapNotifyArg,
} from "../src/adapters/codex";

describe("mapNotifyArg", () => {
  const notify = (over: Record<string, unknown> = {}): string =>
    JSON.stringify({
      type: "agent-turn-complete",
      "turn-id": "turn-9",
      "thread-id": "thread-7",
      "last-assistant-message": "Done refactoring",
      ...over,
    });

  it("maps agent-turn-complete to an idle codex event", () => {
    const event = mapNotifyArg(notify(), 500);
    expect(event).toEqual({
      source: "codex",
      sessionId: "thread-7",
      kind: "idle",
      activity: "Done refactoring",
      ts: 500,
    });
  });

  it("falls back to turn-id then a fixed id", () => {
    expect(mapNotifyArg(notify({ "thread-id": undefined }))?.sessionId).toBe("turn-9");
    expect(
      mapNotifyArg(notify({ "thread-id": undefined, "turn-id": undefined }))?.sessionId,
    ).toBe("codex");
  });

  it("truncates the last assistant message to 60 chars", () => {
    const long = "x".repeat(200);
    const activity = mapNotifyArg(notify({ "last-assistant-message": long }))?.activity;
    expect(activity).toHaveLength(60);
    expect(activity?.endsWith("…")).toBe(true);
  });

  it("collapses whitespace in the activity", () => {
    const activity = mapNotifyArg(
      notify({ "last-assistant-message": "line one\n\n  line two" }),
    )?.activity;
    expect(activity).toBe("line one line two");
  });

  it("omits activity when there is no message", () => {
    expect(
      mapNotifyArg(notify({ "last-assistant-message": undefined }))?.activity,
    ).toBeUndefined();
  });

  it("returns null for other notification types", () => {
    expect(mapNotifyArg(JSON.stringify({ type: "something-else" }))).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(mapNotifyArg("not json")).toBeNull();
    expect(mapNotifyArg("42")).toBeNull();
    expect(mapNotifyArg(JSON.stringify({ foo: "bar" }))).toBeNull();
  });
});

describe("installCodexNotify", () => {
  let dir: string;
  let configPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-codex-"));
    configPath = path.join(dir, "config.toml");
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("creates config.toml with the notify hook when missing", () => {
    expect(installCodexNotify(configPath)).toBe("installed");
    expect(fs.readFileSync(configPath, "utf8")).toContain(CODEX_NOTIFY_LINE);
    expect(isCodexNotifyInstalled(configPath)).toBe(true);
  });

  it("appends to a flat file without a notify key", () => {
    fs.writeFileSync(configPath, 'model = "gpt-5"\n');
    expect(installCodexNotify(configPath)).toBe("installed");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.startsWith('model = "gpt-5"')).toBe(true);
    expect(text).toContain(CODEX_NOTIFY_LINE);
  });

  it("prepends when the file has [table] sections so notify stays top-level", () => {
    fs.writeFileSync(configPath, 'model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "bar"\n');
    expect(installCodexNotify(configPath)).toBe("installed");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.indexOf(CODEX_NOTIFY_LINE)).toBeLessThan(text.indexOf("[mcp_servers.foo]"));
    expect(text).toContain('command = "bar"');
  });

  it("never rewrites an existing foreign notify key", () => {
    const original = 'notify = ["some-other-tool"]\n';
    fs.writeFileSync(configPath, original);
    expect(installCodexNotify(configPath)).toBe("manual");
    expect(fs.readFileSync(configPath, "utf8")).toBe(original);
    expect(isCodexNotifyInstalled(configPath)).toBe(false);
  });

  it("is idempotent when agentblip is already installed", () => {
    installCodexNotify(configPath);
    const afterFirst = fs.readFileSync(configPath, "utf8");
    expect(installCodexNotify(configPath)).toBe("already-installed");
    expect(fs.readFileSync(configPath, "utf8")).toBe(afterFirst);
  });
});
