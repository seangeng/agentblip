import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  findActiveJournals,
  liveAgentCount,
  stepWorkflows,
  type WfState,
} from "../src/adapters/workflow";

const j = (lines: Array<Record<string, unknown>>) =>
  lines.map((l) => JSON.stringify(l)).join("\n");

describe("liveAgentCount", () => {
  it("counts started minus result", () => {
    const text = j([
      { type: "started", agentId: "a" },
      { type: "started", agentId: "b" },
      { type: "result", agentId: "a" },
    ]);
    expect(liveAgentCount(text)).toBe(1);
  });

  it("is 0 when all agents finished, never negative", () => {
    expect(
      liveAgentCount(j([{ type: "started" }, { type: "result" }, { type: "result" }])),
    ).toBe(0);
  });

  it("ignores blank and partial trailing lines", () => {
    const text = `${JSON.stringify({ type: "started" })}\n\n{"type":"star`; // mid-write
    expect(liveAgentCount(text)).toBe(1);
  });

  it("ignores unrelated event types", () => {
    expect(
      liveAgentCount(j([{ type: "started" }, { type: "workflow_phase" }, { type: "log" }])),
    ).toBe(1);
  });
});

describe("findActiveJournals", () => {
  let dir: string;
  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-wf-"));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  const wfPath = (proj: string, sess: string, wf: string) =>
    path.join(dir, proj, sess, "subagents", "workflows", wf);
  const writeFile = (dirPath: string, name: string, content: string, mtime?: number) => {
    fs.mkdirSync(dirPath, { recursive: true });
    const f = path.join(dirPath, name);
    fs.writeFileSync(f, content);
    if (mtime !== undefined) fs.utimesSync(f, new Date(mtime), new Date(mtime));
    return f;
  };
  const writeJournal = (proj: string, sess: string, wf: string, mtime?: number) =>
    writeFile(wfPath(proj, sess, wf), "journal.jsonl", j([{ type: "started" }]), mtime);

  it("finds recent workflow journals and derives the orchestrator session", () => {
    writeJournal("-proj", "sess1", "wf_aaa");
    writeJournal("-proj", "sess2", "wf_bbb");
    const found = findActiveJournals(dir, Date.now());
    expect(found.map((x) => x.wfId).sort()).toEqual(["wf_aaa", "wf_bbb"]);
    expect(found.find((x) => x.wfId === "wf_aaa")?.orchestrator).toBe("claude-code:sess1");
  });

  it("skips workflows whose files are all older than the active window", () => {
    writeJournal("-proj", "sess1", "wf_old", Date.now() - 60 * 60 * 1000);
    expect(findActiveJournals(dir, Date.now())).toHaveLength(0);
  });

  it("keeps a workflow live off a fresh agent file even when journal.jsonl is stale", () => {
    const p = wfPath("-proj", "sess1", "wf_long");
    writeJournal("-proj", "sess1", "wf_long", Date.now() - 60 * 60 * 1000); // stale journal
    writeFile(p, "agent-abc.jsonl", "…\n", Date.now()); // but an agent is writing
    expect(findActiveJournals(dir, Date.now()).map((x) => x.wfId)).toEqual(["wf_long"]);
  });

  it("returns nothing for a missing projects dir", () => {
    expect(findActiveJournals(path.join(dir, "nope"), Date.now())).toEqual([]);
  });
});

describe("stepWorkflows", () => {
  const NOW = 1_700_000_000_000;

  it("emits a working event with the agent count + orchestrator on first sight", () => {
    const active = new Map<string, WfState>();
    const events = stepWorkflows(
      active,
      [{ wfId: "wf1", count: 5, orchestrator: "claude-code:sess1" }],
      NOW,
    );
    expect(events).toEqual([
      {
        source: "workflow",
        sessionId: "wf1",
        kind: "working",
        agents: 5,
        activity: "running a workflow",
        orchestrator: "claude-code:sess1",
        ts: NOW,
      },
    ]);
    expect(active.get("wf1")?.agents).toBe(5);
  });

  it("ignores a drained journal we were never tracking (no adopt-then-end churn)", () => {
    const active = new Map<string, WfState>();
    expect(stepWorkflows(active, [{ wfId: "done", count: 0 }], NOW)).toEqual([]);
    expect(active.size).toBe(0);
  });

  it("heartbeats when the count is unchanged (survives a long steady phase)", () => {
    const active = new Map<string, WfState>([["wf1", { agents: 5 }]]);
    const events = stepWorkflows(active, [{ wfId: "wf1", count: 5 }], NOW);
    expect(events).toEqual([{ source: "workflow", sessionId: "wf1", kind: "heartbeat", ts: NOW }]);
  });

  it("re-sends working when the count changes", () => {
    const active = new Map<string, WfState>([["wf1", { agents: 5 }]]);
    const events = stepWorkflows(active, [{ wfId: "wf1", count: 8 }], NOW);
    expect(events[0]).toMatchObject({ kind: "working", agents: 8 });
  });

  it("ends a workflow that disappeared", () => {
    const active = new Map<string, WfState>([["wf1", { agents: 5 }]]);
    const events = stepWorkflows(active, [], NOW);
    expect(events).toEqual([{ source: "workflow", sessionId: "wf1", kind: "end", ts: NOW }]);
    expect(active.has("wf1")).toBe(false);
  });

  it("rides out an inter-phase dip to 0, then ends after the grace", () => {
    const active = new Map<string, WfState>([["wf1", { agents: 5 }]]);
    // count hits 0 (between stages) — no end yet
    let events = stepWorkflows(active, [{ wfId: "wf1", count: 0 }], NOW);
    expect(events).toEqual([]);
    expect(active.has("wf1")).toBe(true);
    // next stage starts within the grace → resumes, no end
    events = stepWorkflows(active, [{ wfId: "wf1", count: 3 }], NOW + 5_000);
    expect(events[0]).toMatchObject({ kind: "working", agents: 3 });
    // ...then truly idle past the grace → ends
    stepWorkflows(active, [{ wfId: "wf1", count: 0 }], NOW + 6_000);
    events = stepWorkflows(active, [{ wfId: "wf1", count: 0 }], NOW + 40_000);
    expect(events).toEqual([{ source: "workflow", sessionId: "wf1", kind: "end", ts: NOW + 40_000 }]);
  });
});
