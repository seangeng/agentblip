import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { SessionEvent } from "@workmesh/core";
import {
  createAntigravityWatcher,
  parseAntigravityTime,
  parseWorkspaceCwd,
  readAntigravityActivity,
} from "../src/adapters/antigravity";
import { createGrokWatcher } from "../src/adapters/grok";
import { resolveHarnessBin } from "../src/adapters/harness";
import {
  installAntigravityMcp,
  installGeminiMcp,
  installOpenCodeMcp,
  isAntigravityMcpInstalled,
  isGeminiMcpInstalled,
  isOpenCodeMcpInstalled,
} from "../src/adapters/mcp-install";

const tempDirs: string[] = [];
function makeTmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const d of tempDirs.splice(0)) {
    fs.rmSync(d, { recursive: true, force: true });
  }
});

describe("Antigravity adapter", () => {
  it("parses workspace URIs and timestamps", () => {
    expect(parseWorkspaceCwd('["file:///Users/test/Documents/b3"]')).toBe("/Users/test/Documents/b3");
    expect(parseWorkspaceCwd('["file:///Users/test/My%20Repo"]')).toBe("/Users/test/My Repo");
    expect(parseWorkspaceCwd("")).toBeUndefined();
    expect(parseAntigravityTime("2026-11-28 17:01:56.133406+00:00")).toBeGreaterThan(0);
  });

  it("extracts latest focus or tool activity from transcript.jsonl", () => {
    const dir = makeTmp("wm-agy-");
    const convId = "conv-123";
    const logDir = path.join(dir, "brain", convId, ".system_generated", "logs");
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(
      path.join(logDir, "transcript.jsonl"),
      [
        JSON.stringify({ type: "USER_INPUT", content: "audit workmesh" }),
        JSON.stringify({
          type: "PLANNER_RESPONSE",
          tool_calls: [{ name: "update_focus", args: { focus: '"Auditing multi-provider parity"' } }],
        }),
      ].join("\n") + "\n",
    );
    expect(readAntigravityActivity(dir, convId)).toEqual({ activity: "Auditing multi-provider parity" });
  });

  it("watches conversation_summaries.db and emits working sessions with subagent counts", async () => {
    const dir = makeTmp("wm-agy-db-");
    const db = path.join(dir, "conversation_summaries.db");
    const nowIso = new Date().toISOString();
    execFileSync("sqlite3", [
      db,
      `CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY, title text, step_count integer, last_modified_time text,
        workspace_uris text, status text, agent_name text, parent_conversation_id text,
        nesting_depth integer, not_fully_idle integer, killed integer
      );
      INSERT INTO conversation_summaries VALUES
        ('root-1', 'Parity Audit', 12, '${nowIso}', '["file:///tmp/b3"]', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0),
        ('sub-1', '', 4, '${nowIso}', '["file:///tmp/b3"]', 'CASCADE_RUN_STATUS_RUNNING', 'research', 'root-1', 1, 1, 0),
        ('arch-1', 'Old Chat', 5, '${nowIso}', '["file:///tmp/b3"]', 'CASCADE_RUN_STATUS_IDLE', '', '', 0, 0, 0);`,
    ]);
    fs.mkdirSync(path.join(dir, "annotations"), { recursive: true });
    fs.writeFileSync(path.join(dir, "annotations", "arch-1.pbtxt"), 'title:"Old Chat" archived:true\n');

    const events: SessionEvent[] = [];
    const watcher = createAntigravityWatcher({
      dir,
      intervalMs: 60_000,
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "antigravity",
      sessionId: "root-1",
      kind: "working",
      cwd: "/tmp/b3",
      project: "b3",
      name: "Parity Audit",
      agents: 2,
    });
  });

  it("does not emit spurious end events when sqlite3 transiently fails", async () => {
    const dir = makeTmp("wm-agy-busy-");
    const db = path.join(dir, "conversation_summaries.db");
    const nowIso = new Date().toISOString();
    execFileSync("sqlite3", [
      db,
      `CREATE TABLE conversation_summaries (
        conversation_id text PRIMARY KEY, title text, step_count integer, last_modified_time text,
        workspace_uris text, status text, agent_name text, parent_conversation_id text,
        nesting_depth integer, not_fully_idle integer, killed integer
      );
      INSERT INTO conversation_summaries VALUES
        ('root-1', 'Parity Audit', 12, '${nowIso}', '["file:///tmp/b3"]', 'CASCADE_RUN_STATUS_RUNNING', '', '', 0, 1, 0);`,
    ]);

    const events: SessionEvent[] = [];
    const watcher = createAntigravityWatcher({
      dir,
      intervalMs: 120,
      onEvent: (e) => events.push(e),
    });
    await new Promise((r) => setTimeout(r, 250));
    expect(events.some((e) => e.sessionId === "root-1" && e.kind === "working")).toBe(true);

    // Simulate a transient SQLite failure (unreadable / locked DB) across several ticks.
    const backup = fs.readFileSync(db);
    fs.writeFileSync(db, "not-a-valid-sqlite-header");
    await new Promise((r) => setTimeout(r, 350));
    fs.writeFileSync(db, backup);
    await new Promise((r) => setTimeout(r, 200));
    watcher.stop();

    expect(events.some((e) => e.kind === "end")).toBe(false);
  });
});

describe("Grok Bot adapter", () => {
  it("emits working when inflightCount > 0 and idle when connected with 0 inflight", () => {
    const dir = makeTmp("wm-grok-");
    const stateFile = path.join(dir, "local-exec-daemon.json");
    fs.writeFileSync(
      stateFile,
      JSON.stringify({ pid: process.pid, startedAt: Date.now() - 5000, servingAt: Date.now(), inflightCount: 2 }),
    );
    const events: SessionEvent[] = [];
    const w = createGrokWatcher({ dir, intervalMs: 60_000, onEvent: (e) => events.push(e) });
    w.stop();
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      source: "grok",
      sessionId: "grok-bot",
      kind: "working",
      name: "Grok Bot",
      agents: 2,
    });
  });
});

describe("Harness binary resolution", () => {
  it("finds harness in ~/.local/bin even when PATH omits it", () => {
    const home = makeTmp("wm-home-");
    const binDir = path.join(home, ".local", "bin");
    fs.mkdirSync(binDir, { recursive: true });
    const fake = path.join(binDir, "harness");
    fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    expect(resolveHarnessBin("harness", "/usr/bin:/bin", home)).toBe(fake);
  });
});

describe("Multi-provider MCP installers", () => {
  it("installs into Antigravity (including 0-byte file), OpenCode, and Gemini settings cleanly", () => {
    const dir = makeTmp("wm-mcp-");

    const agyFile = path.join(dir, "mcp_config.json");
    fs.writeFileSync(agyFile, "");
    expect(installAntigravityMcp(agyFile).result).toBe("installed");
    expect(isAntigravityMcpInstalled(agyFile)).toBe(true);
    expect(installAntigravityMcp(agyFile).result).toBe("already-installed");

    const ocFile = path.join(dir, "opencode.json");
    fs.writeFileSync(ocFile, JSON.stringify({ mcp: { servers: { browse: { type: "local", command: ["browse", "mcp"] } } } }));
    expect(installOpenCodeMcp(ocFile).result).toBe("installed");
    expect(isOpenCodeMcpInstalled(ocFile)).toBe(true);
    const ocParsed = JSON.parse(fs.readFileSync(ocFile, "utf8")) as { mcp: { servers: Record<string, unknown> } };
    expect(ocParsed.mcp.servers.browse).toBeDefined();
    expect(ocParsed.mcp.servers.workmesh).toBeDefined();
    expect(installOpenCodeMcp(ocFile).result).toBe("already-installed");

    const gemFile = path.join(dir, "settings.json");
    fs.writeFileSync(gemFile, JSON.stringify({ theme: "dark" }));
    expect(installGeminiMcp(gemFile).result).toBe("installed");
    expect(isGeminiMcpInstalled(gemFile)).toBe(true);
  });
});
