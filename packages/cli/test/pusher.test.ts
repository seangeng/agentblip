import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EMPTY_OWNERSHIP_STATE, SessionStore } from "@agentblip/core";
import type {
  OwnershipState,
  SessionEvent,
  SlackStatus,
  StatusPolicy,
} from "@agentblip/core";
import { Pusher } from "../src/daemon/pusher";
import { loadOwnershipState, saveOwnershipState } from "../src/lib/ownership-state";
import { PermanentSinkError } from "../src/sinks/types";
import type { Sink } from "../src/sinks/types";

const working = (sessionId: string, activity: string): SessionEvent => ({
  source: "claude-code",
  sessionId,
  kind: "working",
  activity,
});

/** A status somebody else (the human, another app) put on the profile. */
const foreign: SlackStatus = {
  text: "On vacation",
  emoji: ":palm_tree:",
  expirationSec: 0,
};

interface Harness {
  store: SessionStore;
  pusher: Pusher;
  pushes: (SlackStatus | null)[];
  /** Simulated Slack profile: successful pushes land here; reads serve it. */
  remote: {
    status: SlackStatus | null;
    readable: boolean;
    readFail: boolean;
    reason: "missing_scope" | "unsupported" | undefined;
  };
  fail: { next: boolean; always: boolean; permanent: boolean; hang: boolean };
  logs: string[];
  attempts: () => number;
  reads: () => number;
  ownershipWrites: OwnershipState[];
}

function build(
  over: {
    debounceMs?: number;
    statusTtlSec?: number;
    policy?: StatusPolicy;
    initialOwnership?: OwnershipState;
  } = {},
): Harness {
  const pushes: (SlackStatus | null)[] = [];
  const remote = {
    status: null as SlackStatus | null,
    readable: true,
    readFail: false,
    reason: undefined as "missing_scope" | "unsupported" | undefined,
  };
  const fail = { next: false, always: false, permanent: false, hang: false };
  const logs: string[] = [];
  const ownershipWrites: OwnershipState[] = [];
  let attemptCount = 0;
  let readCount = 0;
  const sink: Sink = {
    name: "mock",
    push(status: SlackStatus | null): Promise<void> {
      attemptCount += 1;
      if (fail.hang) return new Promise(() => {});
      if (fail.next || fail.always) {
        fail.next = false;
        return Promise.reject(
          fail.permanent ? new PermanentSinkError("token revoked") : new Error("boom"),
        );
      }
      remote.status = status; // the mock profile follows successful pushes
      pushes.push(status);
      return Promise.resolve();
    },
    getStatus(): Promise<{
      readable: boolean;
      status: SlackStatus | null;
      reason?: "missing_scope" | "unsupported";
    }> {
      readCount += 1;
      if (remote.readFail) return Promise.reject(new Error("read boom"));
      return Promise.resolve({
        readable: remote.readable,
        status: remote.status,
        reason: remote.reason,
      });
    },
  };
  const store = new SessionStore();
  const pusher = new Pusher({
    store,
    sink,
    formatOpts: { granularity: "activity", statusTtlSec: over.statusTtlSec ?? 300 },
    policy: over.policy,
    initialOwnership: over.initialOwnership,
    persistOwnership: (state) => ownershipWrites.push(state),
    debounceMs: over.debounceMs ?? 10_000,
    log: (message) => logs.push(message),
  });
  return {
    store,
    pusher,
    pushes,
    remote,
    fail,
    logs,
    attempts: () => attemptCount,
    reads: () => readCount,
    ownershipWrites,
  };
}

describe("Pusher", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("pushes when the formatted status changes", async () => {
    const { store, pusher, pushes } = build();
    pusher.start();
    expect(pushes).toHaveLength(0); // nothing live, nothing pushed

    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(1);
    expect(pushes[0]?.text).toBe("claude: editing a.ts");
    expect(pushes[0]?.emoji).toBe(":robot_face:");
  });

  it("does not push when the formatted output is unchanged", async () => {
    const { store, pusher, pushes } = build();
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();

    store.apply({ source: "claude-code", sessionId: "a", kind: "heartbeat" });
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(1);
  });

  it("coalesces rapid changes into a trailing push with the latest state", async () => {
    const { store, pusher, pushes } = build({ debounceMs: 10_000 });
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(1);

    store.apply(working("a", "editing b.ts"));
    pusher.notify();
    store.apply(working("a", "editing c.ts"));
    pusher.notify();
    expect(pushes).toHaveLength(1); // debounced

    await vi.advanceTimersByTimeAsync(10_000);
    await pusher.flush();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.text).toBe("claude: editing c.ts"); // trailing push, latest wins
  });

  it("re-pushes every statusTtlSec/2 to keep the rolling expiration alive", async () => {
    const { store, pusher, pushes } = build({ statusTtlSec: 300 });
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150_000);
    await pusher.flush();
    expect(pushes).toHaveLength(2);
    expect(pushes[1]?.text).toBe(pushes[0]?.text);
    expect(pushes[1]?.expirationSec ?? 0).toBeGreaterThan(pushes[0]?.expirationSec ?? 0);
  });

  it("clears the status once sessions go stale, without ttl-refreshing null", async () => {
    const { store, pusher, pushes } = build({ statusTtlSec: 300 });
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();

    // default workingStaleMs is 3min: sweeps demote the silent session,
    // formatStatus turns null, and null is pushed exactly once.
    await vi.advanceTimersByTimeAsync(600_000);
    await pusher.flush();
    expect(pushes[pushes.length - 1]).toBeNull();
    expect(pushes.filter((p) => p === null)).toHaveLength(1);
  });

  it("does not push anything while there are no sessions", async () => {
    const { pusher, pushes } = build();
    pusher.start();
    await vi.advanceTimersByTimeAsync(600_000);
    await pusher.flush();
    expect(pushes).toHaveLength(0);
  });

  it("pause pushes null immediately, even inside the debounce window", async () => {
    const { store, pusher, pushes } = build({ debounceMs: 60_000 });
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(1);

    await pusher.pause();
    expect(pusher.paused).toBe(true);
    expect(pushes).toHaveLength(2);
    expect(pushes[1]).toBeNull();
  });

  it("suppresses pushes while paused and resumes with the current status", async () => {
    const { store, pusher, pushes } = build({ debounceMs: 1000 });
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    await pusher.pause();
    expect(pushes).toHaveLength(2);

    store.apply(working("b", "editing b.ts"));
    pusher.notify();
    await vi.advanceTimersByTimeAsync(30_000);
    await pusher.flush();
    expect(pushes).toHaveLength(2); // still paused

    pusher.resume();
    await vi.advanceTimersByTimeAsync(1000);
    await pusher.flush();
    expect(pushes).toHaveLength(3);
    expect(pushes[2]).not.toBeNull();
  });

  it("survives sink failures and retries on the next sweep", async () => {
    const { store, pusher, pushes, fail } = build({ debounceMs: 1000 });
    pusher.start();
    fail.next = true;
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pushes).toHaveLength(0);
    expect(pusher.consecutiveFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(15_000); // next sweep retries
    await pusher.flush();
    expect(pushes).toHaveLength(1);
    expect(pusher.consecutiveFailures).toBe(0);
  });

  it("shutdown pushes null when a status is live", async () => {
    const { store, pusher, pushes } = build();
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();

    await pusher.shutdown();
    expect(pushes[pushes.length - 1]).toBeNull();
  });

  it("shutdown skips the clear when nothing was ever pushed", async () => {
    const { pusher, pushes } = build();
    pusher.start();
    await pusher.shutdown();
    expect(pushes).toHaveLength(0);
  });

  it("shutdown resolves within its cap even when the sink hangs", async () => {
    // `agentblip stop` waits 5s — a 10s sink push must not stall shutdown.
    const { store, pusher, fail } = build();
    pusher.start();
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();

    fail.hang = true;
    const done = pusher.shutdown();
    await vi.advanceTimersByTimeAsync(3000);
    await expect(done).resolves.toBeUndefined();
  });

  it("backs off exponentially after consecutive transient failures", async () => {
    const { store, pusher, attempts, fail } = build();
    pusher.start();
    fail.always = true;
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(attempts()).toBe(1); // failed — retry due in 15s

    await vi.advanceTimersByTimeAsync(15_000);
    await pusher.flush();
    expect(attempts()).toBe(2); // failed again — backoff doubles to 30s

    await vi.advanceTimersByTimeAsync(15_000);
    await pusher.flush();
    expect(attempts()).toBe(2); // sweep ticked, but still inside the backoff

    await vi.advanceTimersByTimeAsync(15_000);
    await pusher.flush();
    expect(attempts()).toBe(3);
    expect(pusher.lastError).toBe("boom");
  });

  it("clears lastError and resumes normal pushes after a success", async () => {
    const { store, pusher, pushes, fail } = build();
    pusher.start();
    fail.next = true;
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(pusher.lastError).toBe("boom");

    await vi.advanceTimersByTimeAsync(15_000);
    await pusher.flush();
    expect(pushes).toHaveLength(1);
    expect(pusher.lastError).toBeUndefined();
  });

  it("retries permanent failures silently during the startup grace window", async () => {
    // right after pairing, relay KV propagation can 401 for up to ~60s
    const { store, pusher, pushes, fail, logs } = build();
    pusher.start();
    fail.next = true;
    fail.permanent = true;
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    expect(logs).toHaveLength(0); // tolerated silently
    expect(pusher.halted).toBe(false);

    await vi.advanceTimersByTimeAsync(15_000); // next sweep retries, KV caught up
    await pusher.flush();
    expect(pushes).toHaveLength(1);
  });

  it("halts pushing after repeated permanent failures past the grace window", async () => {
    const { store, pusher, attempts, fail } = build();
    pusher.start();
    await vi.advanceTimersByTimeAsync(60_000); // leave the startup grace window

    fail.always = true;
    fail.permanent = true;
    store.apply(working("a", "editing a.ts"));
    pusher.notify();
    await pusher.flush();
    await vi.advanceTimersByTimeAsync(15_000); // 2nd attempt
    await pusher.flush();
    await vi.advanceTimersByTimeAsync(30_000); // 3rd attempt after doubled backoff
    await pusher.flush();

    expect(attempts()).toBe(3);
    expect(pusher.halted).toBe(true);
    expect(pusher.lastError).toBe("token revoked");

    await vi.advanceTimersByTimeAsync(600_000); // no more retries — sink stays quiet
    await pusher.flush();
    expect(attempts()).toBe(3);
  });
});

describe("Pusher ownership guard", () => {
  beforeEach(() => {
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval", "Date"],
    });
    vi.setSystemTime(1_000_000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("respect: never overwrites a foreign status — backs off with one log line", async () => {
    const h = build();
    h.remote.status = foreign;
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();

    expect(h.pushes).toHaveLength(0); // the human's status is untouched
    expect(h.pusher.ownershipSummary().backedOff).toBe(true);
    expect(h.logs.filter((l) => l.includes("standing down"))).toEqual([
      "existing status detected — standing down (statusPolicy: respect)",
    ]);
    expect(h.ownershipWrites.at(-1)?.backedOff).toBe(true);

    // refresh polls keep skipping without re-logging while it persists
    await vi.advanceTimersByTimeAsync(150_000);
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(0);
    expect(h.logs.filter((l) => l.includes("standing down"))).toHaveLength(1);
  });

  it("resumes pushing once the foreign status clears", async () => {
    const h = build();
    h.remote.status = foreign;
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(0);

    h.remote.status = null; // the human cleared their status
    await vi.advanceTimersByTimeAsync(150_000); // next refresh doubles as the poll
    await h.pusher.flush();

    expect(h.pushes).toHaveLength(1);
    expect(h.pushes[0]?.text).toBe("claude: editing a.ts");
    expect(h.pusher.ownershipSummary().backedOff).toBe(false);
    expect(h.logs.some((l) => l.includes("resuming status updates"))).toBe(true);
  });

  it("ttl refresh goes through while we own the slot", async () => {
    const h = build({ statusTtlSec: 300 });
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150_000);
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(2); // the read saw our own status — refresh allowed
    expect(h.pusher.ownershipSummary().backedOff).toBe(false);
  });

  it("overwrite: displaces a foreign status and restores it on shutdown", async () => {
    const h = build({ policy: "overwrite" });
    h.remote.status = foreign;
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();

    expect(h.pushes).toHaveLength(1); // took the slot
    expect(h.pusher.ownershipSummary().savedPrior).toBe(true);
    expect(h.ownershipWrites.at(-1)?.savedPrior).toEqual(foreign);

    await h.pusher.shutdown();
    expect(h.pushes.at(-1)).toEqual(foreign); // restored, not cleared
    expect(h.remote.status).toEqual(foreign);
    expect(h.logs.some((l) => l.includes("restored"))).toBe(true);
    expect(h.ownershipWrites.at(-1)).toEqual(EMPTY_OWNERSHIP_STATE);
  });

  it("mid-session manual change wins — backs off and drops any saved prior", async () => {
    const h = build({ policy: "overwrite" });
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1); // we own the slot

    h.remote.status = { text: "Lunch", emoji: ":bento:", expirationSec: 0 };
    await vi.advanceTimersByTimeAsync(150_000); // ttl refresh reads the change
    await h.pusher.flush();

    expect(h.pushes).toHaveLength(1); // the refresh did NOT go out
    expect(h.pusher.ownershipSummary()).toMatchObject({
      backedOff: true,
      savedPrior: false,
    });
    expect(h.logs).toContain(
      "existing status detected — standing down (statusPolicy: overwrite)",
    );
  });

  it("shutdown leaves a foreign status untouched after backing off", async () => {
    const h = build();
    h.remote.status = foreign;
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pusher.ownershipSummary().backedOff).toBe(true);

    await h.pusher.shutdown();
    expect(h.pushes).toHaveLength(0); // never wrote anything
    expect(h.remote.status).toEqual(foreign);
  });

  it("readable:false → legacy blind pushes with a single lifetime warning", async () => {
    const h = build();
    h.remote.readable = false;
    h.remote.status = foreign; // invisible to the daemon — overwritten blind
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(150_000); // refresh — still legacy
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(2);
    expect(h.logs.filter((l) => l.includes("legacy mode"))).toHaveLength(1);
  });

  it('reason "unsupported" (console dry-run) pushes legacy-style with NO warning', async () => {
    const h = build();
    h.remote.readable = false;
    h.remote.reason = "unsupported";
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1);
    expect(h.logs.filter((l) => l.includes("legacy mode"))).toHaveLength(0);
  });

  it("treats a failed status read as unreadable and pushes legacy-style", async () => {
    const h = build();
    h.remote.readFail = true;
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1);
    expect(h.pusher.lastError).toBeUndefined(); // a read failure is not a push failure
  });

  it("reads the current status at most once per push attempt", async () => {
    const h = build();
    h.pusher.start();
    h.store.apply(working("a", "editing a.ts"));
    h.pusher.notify();
    await h.pusher.flush();
    expect(h.pushes).toHaveLength(1);
    expect(h.reads()).toBe(1);
  });

  it("restores a displaced status left over from a previous run (crash recovery)", async () => {
    const ours: SlackStatus = {
      text: "claude: editing a.ts",
      emoji: ":robot_face:",
      expirationSec: 0,
    };
    const h = build({
      policy: "overwrite",
      initialOwnership: { lastPushed: ours, savedPrior: foreign, backedOff: false },
    });
    h.remote.status = ours; // our stale status is still up after the crash
    h.pusher.start();
    await h.pusher.flush();

    expect(h.pushes).toEqual([foreign]); // the prior came back, not just a clear
    expect(h.ownershipWrites.at(-1)).toEqual(EMPTY_OWNERSHIP_STATE);
  });
});

describe("ownership state file", () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "agentblip-ownership-"));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("round-trips through save/load", () => {
    const file = path.join(dir, "ownership.json");
    const state: OwnershipState = {
      lastPushed: { text: "claude agent working", emoji: ":robot_face:", expirationSec: 123 },
      savedPrior: foreign,
      backedOff: false,
    };
    saveOwnershipState(state, file);
    expect(loadOwnershipState(file)).toEqual(state);
  });

  it("returns the empty state for a missing file", () => {
    expect(loadOwnershipState(path.join(dir, "nope.json"))).toEqual(
      EMPTY_OWNERSHIP_STATE,
    );
  });

  it("returns the empty state for a corrupt file", () => {
    const file = path.join(dir, "ownership.json");
    fs.writeFileSync(file, "{not json");
    expect(loadOwnershipState(file)).toEqual(EMPTY_OWNERSHIP_STATE);
    fs.writeFileSync(file, JSON.stringify({ lastPushed: 42 })); // wrong shape
    expect(loadOwnershipState(file)).toEqual(EMPTY_OWNERSHIP_STATE);
  });

  it("creates parent directories on save", () => {
    const file = path.join(dir, "state", "ownership.json");
    saveOwnershipState({ ...EMPTY_OWNERSHIP_STATE }, file);
    expect(loadOwnershipState(file)).toEqual(EMPTY_OWNERSHIP_STATE);
  });
});
