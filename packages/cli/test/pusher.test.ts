import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SessionStore } from "@agentblip/core";
import type { SessionEvent, SlackStatus } from "@agentblip/core";
import { Pusher } from "../src/daemon/pusher";
import type { Sink } from "../src/sinks/types";

const working = (sessionId: string, activity: string): SessionEvent => ({
  source: "claude-code",
  sessionId,
  kind: "working",
  activity,
});

interface Harness {
  store: SessionStore;
  pusher: Pusher;
  pushes: (SlackStatus | null)[];
  fail: { next: boolean };
}

function build(over: { debounceMs?: number; statusTtlSec?: number } = {}): Harness {
  const pushes: (SlackStatus | null)[] = [];
  const fail = { next: false };
  const sink: Sink = {
    name: "mock",
    push(status: SlackStatus | null): Promise<void> {
      if (fail.next) {
        fail.next = false;
        return Promise.reject(new Error("boom"));
      }
      pushes.push(status);
      return Promise.resolve();
    },
  };
  const store = new SessionStore();
  const pusher = new Pusher({
    store,
    sink,
    formatOpts: { granularity: "activity", statusTtlSec: over.statusTtlSec ?? 300 },
    debounceMs: over.debounceMs ?? 10_000,
    log: () => {},
  });
  return { store, pusher, pushes, fail };
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
});
