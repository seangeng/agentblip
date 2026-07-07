import type { SlackStatus } from "./events";

/**
 * Status ownership: agentblip must never fight the human (or another app)
 * for the Slack status field. Before every push the daemon reads the current
 * status and runs this pure state machine to decide what to do.
 *
 * Rules:
 *  - A status we didn't set is "foreign". policy "respect" (default): stand
 *    down and alert. policy "overwrite": displace it once, remember it, and
 *    restore it when sessions end.
 *  - A foreign status appearing while we're active means the human changed it
 *    deliberately — back off regardless of policy.
 *  - When we can't read the current status (token without users.profile:read),
 *    fall back to legacy blind pushes rather than bricking the setup.
 */

export type StatusPolicy = "respect" | "overwrite";

export interface OwnershipState {
  /** What we believe we last set. null = we set nothing / cleared. */
  lastPushed: SlackStatus | null;
  /** Foreign status we displaced (overwrite policy) — restored on clear. */
  savedPrior: SlackStatus | null;
  /** We saw a foreign status and are standing down until it clears. */
  backedOff: boolean;
}

export const EMPTY_OWNERSHIP_STATE: OwnershipState = {
  lastPushed: null,
  savedPrior: null,
  backedOff: false,
};

export type OwnershipAction =
  /** Set our formatted status. */
  | { kind: "push"; status: SlackStatus; state: OwnershipState }
  /** Put back the status we displaced. */
  | { kind: "restore"; status: SlackStatus; state: OwnershipState }
  /** Clear the Slack status entirely. */
  | { kind: "clear"; state: OwnershipState }
  /** Do nothing this round. */
  | {
      kind: "skip";
      reason: "foreign-status" | "not-ours" | "nothing-to-do";
      state: OwnershipState;
    };

/** Same status for ownership purposes (expiration drifts with TTL refreshes). */
export function sameStatus(
  a: SlackStatus | null,
  b: SlackStatus | null,
): boolean {
  if (a === null || b === null) return a === b;
  return a.text === b.text && a.emoji === b.emoji;
}

function isEmpty(status: SlackStatus | null): boolean {
  return status === null || (status.text === "" && status.emoji === "");
}

/** A saved prior whose timed expiration already passed shouldn't resurrect. */
function priorStillValid(prior: SlackStatus, nowMs: number): boolean {
  return prior.expirationSec === 0 || prior.expirationSec > Math.floor(nowMs / 1000);
}

export interface PlanArgs {
  /** Formatted status the daemon wants visible; null = sessions over/paused. */
  desired: SlackStatus | null;
  /**
   * Status currently on the Slack profile. null = profile has no status.
   * undefined = could not read (missing scope / read unavailable).
   */
  current: SlackStatus | null | undefined;
  state: OwnershipState;
  policy: StatusPolicy;
  nowMs?: number;
}

export function planStatusUpdate(args: PlanArgs): OwnershipAction {
  const { desired, current, state, policy } = args;
  const nowMs = args.nowMs ?? Date.now();

  // Read unavailable → legacy behavior: push/clear blindly, own everything.
  if (current === undefined) {
    if (desired) {
      return {
        kind: "push",
        status: desired,
        state: { ...state, lastPushed: desired, backedOff: false },
      };
    }
    if (state.lastPushed) {
      return { kind: "clear", state: { ...EMPTY_OWNERSHIP_STATE } };
    }
    return {
      kind: "skip",
      reason: "nothing-to-do",
      state: { ...EMPTY_OWNERSHIP_STATE },
    };
  }

  const currentEmpty = isEmpty(current);
  const currentIsOurs = !currentEmpty && sameStatus(current, state.lastPushed);
  const currentIsForeign = !currentEmpty && !currentIsOurs;

  if (desired) {
    if (currentEmpty || currentIsOurs) {
      // Free slot, or refreshing our own status. savedPrior survives so a
      // later clear can still restore what we displaced.
      return {
        kind: "push",
        status: desired,
        state: { ...state, lastPushed: desired, backedOff: false },
      };
    }
    // currentIsForeign
    if (policy === "overwrite" && state.lastPushed === null && !state.backedOff) {
      // First takeover: remember what we displaced.
      return {
        kind: "push",
        status: desired,
        state: { lastPushed: desired, savedPrior: current, backedOff: false },
      };
    }
    // Respect policy, or the human changed the status while we were active:
    // stand down. Their status is the truth now — drop any saved prior.
    return {
      kind: "skip",
      reason: "foreign-status",
      state: { lastPushed: null, savedPrior: null, backedOff: true },
    };
  }

  // desired === null — sessions over, paused, or shutting down.
  if (currentIsForeign) {
    // Someone else's status is up; not ours to touch.
    return {
      kind: "skip",
      reason: "not-ours",
      state: { ...EMPTY_OWNERSHIP_STATE },
    };
  }
  // Restore a displaced status whether ours is still up or already expired
  // (currentEmpty after a crash — the human's status shouldn't stay lost).
  if (state.savedPrior && priorStillValid(state.savedPrior, nowMs)) {
    return {
      kind: "restore",
      status: state.savedPrior,
      state: { ...EMPTY_OWNERSHIP_STATE },
    };
  }
  if (currentIsOurs) {
    return { kind: "clear", state: { ...EMPTY_OWNERSHIP_STATE } };
  }
  return {
    kind: "skip",
    reason: "nothing-to-do",
    state: { ...EMPTY_OWNERSHIP_STATE },
  };
}
