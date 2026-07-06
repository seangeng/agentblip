import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/aggregate";
import type { SessionEvent } from "../src/events";

const ev = (over: Partial<SessionEvent> = {}): SessionEvent => ({
  source: "claude-code",
  sessionId: "s1",
  kind: "working",
  ...over,
});

describe("SessionStore", () => {
  it("tracks a session through its lifecycle", () => {
    const store = new SessionStore();
    store.apply(ev({ kind: "start" }), 1000);
    expect(store.snapshot().sessions[0]?.state).toBe("idle");

    store.apply(ev({ kind: "working", activity: "editing app.ts" }), 2000);
    const snap = store.snapshot();
    expect(snap.working).toBe(1);
    expect(snap.latestActivity).toBe("editing app.ts");

    store.apply(ev({ kind: "end" }), 3000);
    expect(store.snapshot().total).toBe(0);
  });

  it("counts sessions across sources independently", () => {
    const store = new SessionStore();
    store.apply(ev(), 1000);
    store.apply(ev({ source: "codex", sessionId: "s2" }), 1001);
    store.apply(ev({ sessionId: "s3", kind: "waiting" }), 1002);
    const snap = store.snapshot();
    expect(snap.total).toBe(3);
    expect(snap.working).toBe(2);
    expect(snap.waiting).toBe(1);
  });

  it("keeps previous activity for label-less working events", () => {
    const store = new SessionStore();
    store.apply(ev({ activity: "running tests" }), 1000);
    store.apply(ev(), 2000);
    expect(store.snapshot().latestActivity).toBe("running tests");
  });

  it("heartbeat refreshes liveness without changing state", () => {
    const store = new SessionStore({ workingStaleMs: 5000 });
    store.apply(ev({ kind: "waiting" }), 1000);
    store.apply(ev({ kind: "heartbeat" }), 4000);
    store.sweep(8000); // 4000ms since heartbeat < 5000ms stale threshold
    expect(store.snapshot().waiting).toBe(1);
  });

  it("drops out-of-order events", () => {
    const T = 1_700_000_000_000;
    const store = new SessionStore();
    store.apply(ev({ kind: "idle" }), T + 5000);
    store.apply(ev({ kind: "working", ts: T + 1000 }), T + 6000);
    expect(store.snapshot().working).toBe(0);
  });

  it("clamps implausible client timestamps to receipt time", () => {
    const store = new SessionStore({ workingStaleMs: 1000 });
    const now = 1_700_000_000_000;
    // Far-future ts must not wedge the session past every sweep threshold…
    store.apply(ev({ ts: now + 86_400_000 }), now);
    store.sweep(now + 2000);
    expect(store.snapshot().working).toBe(0);
    // …and pre-2001 ts (broken clock) must not be dropped as out-of-order.
    const store2 = new SessionStore();
    store2.apply(ev({ kind: "idle" }), now);
    store2.apply(ev({ kind: "working", ts: 999 }), now + 1000);
    expect(store2.snapshot().working).toBe(1);
  });

  it("gives waiting sessions a longer staleness leash than working ones", () => {
    const store = new SessionStore({
      workingStaleMs: 1000,
      waitingStaleMs: 10_000,
    });
    store.apply(ev({ kind: "waiting" }), 1000);
    store.apply(ev({ sessionId: "s2", kind: "working" }), 1000);

    store.sweep(3000); // working stale, waiting not
    expect(store.snapshot().working).toBe(0);
    expect(store.snapshot().waiting).toBe(1);

    store.sweep(12_500); // now the waiting session is stale too
    expect(store.snapshot().waiting).toBe(0);
  });

  it("sweep demotes stale working sessions then evicts idle ones", () => {
    const store = new SessionStore({ workingStaleMs: 1000, idleEvictMs: 2000 });
    store.apply(ev({ activity: "thinking" }), 1000);

    store.sweep(2500); // silent 1500ms > workingStaleMs
    let snap = store.snapshot();
    expect(snap.working).toBe(0);
    expect(snap.idle).toBe(1);
    expect(snap.latestActivity).toBeUndefined();

    store.sweep(10_000); // long past idleEvictMs
    expect(store.snapshot().total).toBe(0);
  });

  it("signature changes with state and is order-independent", () => {
    const store = new SessionStore();
    store.apply(ev(), 1000);
    const a = store.snapshot().signature;
    store.apply(ev({ sessionId: "s2", kind: "waiting" }), 2000);
    const b = store.snapshot().signature;
    expect(a).not.toBe(b);

    const store2 = new SessionStore();
    store2.apply(ev({ sessionId: "s2", kind: "waiting" }), 500);
    store2.apply(ev(), 600);
    expect(store2.snapshot().signature).toBe(b);
  });
});
