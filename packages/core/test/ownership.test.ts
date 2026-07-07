import { describe, expect, it } from "vitest";
import {
  EMPTY_OWNERSHIP_STATE,
  planStatusUpdate,
  sameStatus,
  type OwnershipState,
} from "../src/ownership";
import type { SlackStatus } from "../src/events";

const NOW = 1_700_000_000_000;
const NOW_SEC = Math.floor(NOW / 1000);

const ours: SlackStatus = {
  text: "claude agent working",
  emoji: ":robot_face:",
  expirationSec: NOW_SEC + 300,
};
const oursRefreshed: SlackStatus = { ...ours, expirationSec: NOW_SEC + 600 };
const vacation: SlackStatus = { text: "On vacation", emoji: ":palm_tree:", expirationSec: 0 };
const meeting: SlackStatus = {
  text: "In a meeting",
  emoji: ":calendar:",
  expirationSec: NOW_SEC + 1800,
};
const fresh = (): OwnershipState => ({ ...EMPTY_OWNERSHIP_STATE });

describe("sameStatus", () => {
  it("ignores expiration drift, matches text+emoji", () => {
    expect(sameStatus(ours, oursRefreshed)).toBe(true);
    expect(sameStatus(ours, vacation)).toBe(false);
    expect(sameStatus(null, null)).toBe(true);
    expect(sameStatus(ours, null)).toBe(false);
  });
});

describe("planStatusUpdate — free slot", () => {
  it("pushes onto an empty profile and records ownership", () => {
    const a = planStatusUpdate({ desired: ours, current: null, state: fresh(), policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("push");
    expect(a.state.lastPushed).toEqual(ours);
  });

  it("refreshes our own status", () => {
    const state = { ...fresh(), lastPushed: ours };
    const a = planStatusUpdate({ desired: oursRefreshed, current: ours, state, policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("push");
  });
});

describe("planStatusUpdate — foreign status (the user's ask)", () => {
  it("respect (default): does NOT overwrite an existing status, backs off", () => {
    const a = planStatusUpdate({ desired: ours, current: vacation, state: fresh(), policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("skip");
    expect(a).toMatchObject({ reason: "foreign-status" });
    expect(a.state.backedOff).toBe(true);
  });

  it("resumes automatically once the foreign status clears", () => {
    const backed = { lastPushed: null, savedPrior: null, backedOff: true };
    const a = planStatusUpdate({ desired: ours, current: null, state: backed, policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("push");
    expect(a.state.backedOff).toBe(false);
  });

  it("stays backed off while the foreign status remains", () => {
    const backed = { lastPushed: null, savedPrior: null, backedOff: true };
    const a = planStatusUpdate({ desired: ours, current: vacation, state: backed, policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("skip");
  });

  it("overwrite: displaces once, remembers the prior", () => {
    const a = planStatusUpdate({ desired: ours, current: vacation, state: fresh(), policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("push");
    expect(a.state.savedPrior).toEqual(vacation);
  });

  it("overwrite: a mid-session manual change beats the policy", () => {
    // We were active (lastPushed set), then the human set "In a meeting".
    const state = { lastPushed: ours, savedPrior: vacation, backedOff: false };
    const a = planStatusUpdate({ desired: oursRefreshed, current: meeting, state, policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("skip");
    expect(a).toMatchObject({ reason: "foreign-status" });
    // Their new status is the truth — stale prior dropped, nothing restored over it.
    expect(a.state.savedPrior).toBeNull();
    expect(a.state.backedOff).toBe(true);
  });
});

describe("planStatusUpdate — clearing (sessions over / shutdown)", () => {
  it("restores the displaced status instead of blanking", () => {
    const state = { lastPushed: ours, savedPrior: vacation, backedOff: false };
    const a = planStatusUpdate({ desired: null, current: ours, state, policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("restore");
    expect(a).toMatchObject({ status: vacation });
    expect(a.state).toEqual(EMPTY_OWNERSHIP_STATE);
  });

  it("restores after a crash left the slot empty (expired our status)", () => {
    const state = { lastPushed: ours, savedPrior: vacation, backedOff: false };
    const a = planStatusUpdate({ desired: null, current: null, state, policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("restore");
  });

  it("does not resurrect a prior whose timed expiration already passed", () => {
    const stalePrior = { ...meeting, expirationSec: NOW_SEC - 60 };
    const state = { lastPushed: ours, savedPrior: stalePrior, backedOff: false };
    const a = planStatusUpdate({ desired: null, current: ours, state, policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("clear");
  });

  it("clears our own status when there is no prior", () => {
    const state = { ...fresh(), lastPushed: ours };
    const a = planStatusUpdate({ desired: null, current: ours, state, policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("clear");
  });

  it("never touches a foreign status on clear", () => {
    const state = { lastPushed: ours, savedPrior: null, backedOff: false };
    const a = planStatusUpdate({ desired: null, current: meeting, state, policy: "overwrite", nowMs: NOW });
    expect(a.kind).toBe("skip");
    expect(a).toMatchObject({ reason: "not-ours" });
  });

  it("no-ops when slot is empty and nothing was displaced", () => {
    const a = planStatusUpdate({ desired: null, current: null, state: fresh(), policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("skip");
    expect(a).toMatchObject({ reason: "nothing-to-do" });
  });
});

describe("planStatusUpdate — read unavailable (legacy tokens)", () => {
  it("pushes blindly when current is unreadable", () => {
    const a = planStatusUpdate({ desired: ours, current: undefined, state: fresh(), policy: "respect", nowMs: NOW });
    expect(a.kind).toBe("push");
  });

  it("clears blindly only if we own something", () => {
    const owned = { ...fresh(), lastPushed: ours };
    expect(
      planStatusUpdate({ desired: null, current: undefined, state: owned, policy: "respect", nowMs: NOW }).kind,
    ).toBe("clear");
    expect(
      planStatusUpdate({ desired: null, current: undefined, state: fresh(), policy: "respect", nowMs: NOW }).kind,
    ).toBe("skip");
  });
});
