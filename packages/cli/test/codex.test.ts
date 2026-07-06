import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@agentblip/core";
import {
  codexNotifyLine,
  createCodexWatcher,
  installCodexNotify,
  isCodexNotifyInstalled,
  isIgnoredRollout,
  mapNotifyArg,
  rolloutSessionId,
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

describe("rolloutSessionId", () => {
  const uuid = "0e5e94cf-91a3-4c6e-8def-0123456789ab";

  it("extracts the trailing uuid so watcher and notify hook agree", () => {
    // The notify hook keys sessions by the bare thread-id uuid — the watcher
    // must derive the same id from the rollout filename.
    const file = `/home/u/.codex/sessions/2026/07/06/rollout-2026-07-06T10-00-00-${uuid}.jsonl`;
    expect(rolloutSessionId(file)).toBe(uuid);
    const notifyEvent = mapNotifyArg(
      JSON.stringify({ type: "agent-turn-complete", "thread-id": uuid }),
    );
    expect(notifyEvent?.sessionId).toBe(rolloutSessionId(file));
  });

  it("falls back to the basename when no uuid is present", () => {
    expect(rolloutSessionId("/x/y/notes.jsonl")).toBe("notes");
  });
});

describe("isIgnoredRollout", () => {
  const stats = (over: Partial<fs.Stats>): fs.Stats =>
    ({ isFile: () => true, mtimeMs: Date.now(), ...over }) as fs.Stats;

  it("never ignores directories (chokidar must still descend)", () => {
    expect(
      isIgnoredRollout("/s/2020", stats({ isFile: () => false })),
    ).toBe(false);
    expect(isIgnoredRollout("/s/2020")).toBe(false); // no stats yet
  });

  it("ignores non-jsonl files", () => {
    expect(isIgnoredRollout("/s/readme.md", stats({}))).toBe(true);
  });

  it("keeps fresh rollouts and drops stale ones", () => {
    expect(isIgnoredRollout("/s/rollout-a.jsonl", stats({}))).toBe(false);
    expect(
      isIgnoredRollout(
        "/s/rollout-old.jsonl",
        stats({ mtimeMs: Date.now() - 72 * 60 * 60 * 1000 }),
      ),
    ).toBe(true);
  });
});

describe("createCodexWatcher", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-watch-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("emits working events keyed by the rollout uuid", async () => {
    const uuid = "0e5e94cf-91a3-4c6e-8def-0123456789ab";
    const events: SessionEvent[] = [];
    const watcher = createCodexWatcher(dir, (event) => events.push(event));
    try {
      await new Promise((resolve) => setTimeout(resolve, 300)); // watcher warm-up
      fs.writeFileSync(
        path.join(dir, `rollout-2026-07-06T10-00-00-${uuid}.jsonl`),
        "{}\n",
      );
      const deadline = Date.now() + 4000;
      while (events.length === 0 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(events[0]).toMatchObject({
        source: "codex",
        sessionId: uuid,
        kind: "working",
      });
    } finally {
      await watcher.close();
    }
  }, 10_000);
});

describe("codexNotifyLine", () => {
  it("uses an absolute node + entry invocation and keeps the agentblip marker", () => {
    const line = codexNotifyLine();
    expect(line).toMatch(/^notify = \[/);
    expect(line).toContain(JSON.stringify(process.execPath));
    expect(line).toContain('"hook", "codex"]');
    // isCodexNotifyInstalled greps for "agentblip" — the entry path carries it
    expect(line).toContain("agentblip");
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
    expect(fs.readFileSync(configPath, "utf8")).toContain(codexNotifyLine());
    expect(isCodexNotifyInstalled(configPath)).toBe(true);
  });

  it("appends to a flat file without a notify key", () => {
    fs.writeFileSync(configPath, 'model = "gpt-5"\n');
    expect(installCodexNotify(configPath)).toBe("installed");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.startsWith('model = "gpt-5"')).toBe(true);
    expect(text).toContain(codexNotifyLine());
  });

  it("prepends when the file has [table] sections so notify stays top-level", () => {
    fs.writeFileSync(configPath, 'model = "gpt-5"\n\n[mcp_servers.foo]\ncommand = "bar"\n');
    expect(installCodexNotify(configPath)).toBe("installed");
    const text = fs.readFileSync(configPath, "utf8");
    expect(text.indexOf(codexNotifyLine())).toBeLessThan(text.indexOf("[mcp_servers.foo]"));
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

  it("recognizes the legacy bare-command install as already installed", () => {
    const legacy = 'notify = ["agentblip", "hook", "codex"]\n';
    fs.writeFileSync(configPath, legacy);
    expect(installCodexNotify(configPath)).toBe("already-installed");
    expect(fs.readFileSync(configPath, "utf8")).toBe(legacy);
    expect(isCodexNotifyInstalled(configPath)).toBe(true);
  });
});
