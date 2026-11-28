import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { HUB_REVIEW_AGENTS, hubReviewAgentSchema, type HubHandoffAccepted } from "@workmesh/protocol";
import { runRoute } from "../src/commands/mesh";
import { agentAnswer, CheckoutIndex, HandoffRunner } from "../src/daemon/handoff-runner";
import { reviewPolicyOp } from "../src/daemon/review-ops";
import { configSchema, reviewSettings } from "../src/lib/config";
import { resetFleetCache, type FleetSnapshot } from "../src/lib/fleet";

const FLEET_SAMPLE: FleetSnapshot = {
  schemaVersion: 1,
  updatedAt: "2026-11-28T12:00:00Z",
  updatedAtMs: 1_800_000_000_000,
  todayUsd: 120,
  sevenDayUsd: 840,
  providers: {
    claude: {
      id: "claude",
      displayName: "Claude Code",
      cli: "claude",
      harnessAgent: "claude",
      installed: true,
      quotaMode: "live",
      headroomPct: 12,
      poolHeadroomPct: 12,
      bucket: "tight",
      tight: true,
      expiringResets: [],
    },
    codex: {
      id: "codex",
      displayName: "Codex",
      cli: "codex",
      harnessAgent: "codex",
      installed: true,
      quotaMode: "live",
      headroomPct: 92,
      poolHeadroomPct: 92,
      bucket: "abundant",
      tight: false,
      expiringResets: [],
    },
    opencode: {
      id: "opencode",
      displayName: "OpenCode",
      cli: "opencode",
      harnessAgent: "opencode",
      installed: true,
      quotaMode: "budget",
      headroomPct: 85,
      poolHeadroomPct: 85,
      bucket: "abundant",
      tight: false,
      expiringResets: [],
    },
  },
  recommendations: {
    review: [
      {
        provider: "codex",
        score: 0.95,
        headroomPct: 92,
        bucket: "abundant",
        reason: "92% free",
        cli: "codex",
        harnessAgent: "codex",
        expiringCredits: 0,
        resetsInSec: null,
      },
      {
        provider: "opencode",
        score: 0.8,
        headroomPct: 85,
        bucket: "abundant",
        reason: "85% free",
        cli: "opencode",
        harnessAgent: "opencode",
        expiringCredits: 0,
        resetsInSec: null,
      },
    ],
  },
  alerts: [],
};

describe("multi-provider review exchange & workmesh route", () => {
  it("accepts all 8 review agents in protocol and config", () => {
    expect(HUB_REVIEW_AGENTS).toContain("opencode");
    expect(HUB_REVIEW_AGENTS).toContain("gemini");
    expect(HUB_REVIEW_AGENTS).toContain("antigravity");
    expect(HUB_REVIEW_AGENTS).toContain("grok");
    for (const agent of HUB_REVIEW_AGENTS) {
      expect(hubReviewAgentSchema.safeParse(agent).success).toBe(true);
    }
    const parsed = configSchema.parse({ reviews: { agent: "auto" } });
    expect(reviewSettings(parsed).agent).toBe("auto");
    const op = reviewPolicyOp(
      { agent: "opencode" },
      {
        request: async () => ({ ok: true, text: "" }),
        settings: () => ({ accept: "ask", postToGitHub: false, count: 1, maxMinutes: 30 }),
        save: (patch) => ({ accept: "ask", postToGitHub: false, agent: patch.agent as "opencode", count: 1, maxMinutes: 30 }),
      },
    );
    expect(op.ok).toBe(true);
    expect(op.text).toContain("opencode");
  });

  it("auto-routes reviews cross-harness using qswap fleet_status", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-rev-route-"));
    try {
      const runner = new HandoffRunner({
        coord: () => undefined,
        settings: () => ({
          roots: [],
          worktree: true,
          maxRunning: 2,
          permissionMode: "auto",
          maxMinutes: 60,
          share: "metadata",
          reviews: { accept: "auto", postToGitHub: false, agent: "auto", count: 1, maxMinutes: 30 },
        }),
        checkouts: new CheckoutIndex(path.join(dir, "checkouts.json")),
        dir,
        which: (bin) => (bin === "claude" || bin === "codex" || bin === "opencode" ? `/usr/local/bin/${bin}` : undefined),
        fleet: () => FLEET_SAMPLE,
      });

      const handoff: HubHandoffAccepted = {
        id: "ho_rev_1",
        from: { person: "Sean", sessionKey: "claude-code:ses-1", sessionName: undefined },
        to: { person: "Teammate" },
        task: "Review PR #42",
        repo: "b3-fun/workmesh",
        issue: undefined,
        context: undefined,
        device: undefined,
        sessionKey: undefined,
        note: undefined,
        status: "accepted",
        createdAt: 1,
        updatedAt: 1,
        kind: "review",
        review: { pr: 42, round: 1, rounds: 2, focus: undefined, headSha: undefined, why: undefined, authorAgent: undefined, outcome: undefined },
      };

      const plan = runner.plan(handoff);
      expect(plan.agent).toBe("codex");
      expect(plan.cannot).toBeUndefined();

      // Explicit preferredAgent overrides auto routing
      const planOc = runner.plan({ ...handoff, preferredAgent: "opencode" });
      expect(planOc.agent).toBe("opencode");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("reads non-claude review answers from stdout log", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-rev-ans-"));
    try {
      const logFile = path.join(dir, "agent.log");
      fs.writeFileSync(
        logFile,
        'workmesh: dropped 1 env var\n{"verdict":"no_issues","summary":"Looks clean","tests":"not_run","findings":[]}\n',
      );
      const ans = agentAnswer({ agent: "opencode", logFile });
      expect(ans).toContain('"verdict":"no_issues"');
      expect(ans).not.toContain("workmesh: dropped");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("workmesh route prints ranked recommendations from fleet_status.json", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "wm-route-cli-"));
    try {
      const file = path.join(dir, "fleet_status.json");
      fs.writeFileSync(file, JSON.stringify(FLEET_SAMPLE));
      resetFleetCache();
      const lines: string[] = [];
      await runRoute({ task: "review", caller: "claude", json: true }, { print: (l) => lines.push(l), fleetFile: file });
      const parsed = JSON.parse(lines.join("\n")) as { best?: { provider: string } };
      expect(parsed.best?.provider).toBe("codex");
    } finally {
      resetFleetCache();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
