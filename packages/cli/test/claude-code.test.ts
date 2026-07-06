import { describe, expect, it } from "vitest";
import { mapHookInput } from "../src/adapters/claude-code";

const input = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  hook_event_name: "PreToolUse",
  session_id: "sess-1",
  cwd: "/Users/dev/projects/agentblip",
  ...over,
});

describe("mapHookInput", () => {
  it("maps SessionStart to a start event with project from cwd basename", () => {
    const event = mapHookInput(input({ hook_event_name: "SessionStart" }), 123);
    expect(event).toEqual({
      source: "claude-code",
      sessionId: "sess-1",
      kind: "start",
      project: "agentblip",
      ts: 123,
    });
  });

  it("maps UserPromptSubmit to working/thinking", () => {
    const event = mapHookInput(input({ hook_event_name: "UserPromptSubmit" }));
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("thinking");
  });

  it.each(["Edit", "Write"])("labels %s with the file basename", (tool) => {
    const event = mapHookInput(
      input({ tool_name: tool, tool_input: { file_path: "/x/y/format.ts" } }),
    );
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBe("editing format.ts");
  });

  it("labels NotebookEdit via notebook_path", () => {
    const event = mapHookInput(
      input({ tool_name: "NotebookEdit", tool_input: { notebook_path: "/x/nb.ipynb" } }),
    );
    expect(event?.activity).toBe("editing nb.ipynb");
  });

  it("falls back to a generic editing label without a file path", () => {
    const event = mapHookInput(input({ tool_name: "Edit", tool_input: {} }));
    expect(event?.activity).toBe("editing files");
  });

  it("labels Bash as running commands", () => {
    expect(mapHookInput(input({ tool_name: "Bash" }))?.activity).toBe("running commands");
  });

  it.each(["Read", "Grep", "Glob"])("labels %s as reading code", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe("reading code");
  });

  it.each(["Task", "Agent"])("labels %s as delegating to subagents", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe(
      "delegating to subagents",
    );
  });

  it.each(["WebFetch", "WebSearch"])("labels %s as browsing the web", (tool) => {
    expect(mapHookInput(input({ tool_name: tool }))?.activity).toBe("browsing the web");
  });

  it("labels unknown tools as using {tool}", () => {
    expect(mapHookInput(input({ tool_name: "MagicWand" }))?.activity).toBe(
      "using MagicWand",
    );
  });

  it("maps PreToolUse without a tool_name to a label-less working event", () => {
    const event = mapHookInput(input());
    expect(event?.kind).toBe("working");
    expect(event?.activity).toBeUndefined();
  });

  it("maps PostToolUse to heartbeat", () => {
    expect(mapHookInput(input({ hook_event_name: "PostToolUse" }))?.kind).toBe("heartbeat");
  });

  it("maps Notification to waiting/needs my input", () => {
    const event = mapHookInput(input({ hook_event_name: "Notification" }));
    expect(event?.kind).toBe("waiting");
    expect(event?.activity).toBe("needs my input");
  });

  it.each(["Stop", "SubagentStop"])("maps %s to idle", (name) => {
    expect(mapHookInput(input({ hook_event_name: name }))?.kind).toBe("idle");
  });

  it("maps SessionEnd to end", () => {
    expect(mapHookInput(input({ hook_event_name: "SessionEnd" }))?.kind).toBe("end");
  });

  it("omits project when cwd is missing", () => {
    const event = mapHookInput({
      hook_event_name: "SessionStart",
      session_id: "s",
    });
    expect(event?.project).toBeUndefined();
  });

  it("returns null for unknown hook events", () => {
    expect(mapHookInput(input({ hook_event_name: "SomethingNew" }))).toBeNull();
  });

  it("returns null for malformed input", () => {
    expect(mapHookInput(null)).toBeNull();
    expect(mapHookInput("nope")).toBeNull();
    expect(mapHookInput(42)).toBeNull();
    expect(mapHookInput({ hook_event_name: "Stop" })).toBeNull(); // missing session_id
    expect(mapHookInput({ session_id: "s" })).toBeNull(); // missing event name
  });
});
