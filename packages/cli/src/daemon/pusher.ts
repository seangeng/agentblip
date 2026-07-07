import {
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_STATUS_TTL_SEC,
  EMPTY_OWNERSHIP_STATE,
  formatStatus,
  planStatusUpdate,
} from "@agentblip/core";
import type {
  FormatOptions,
  OwnershipAction,
  OwnershipState,
  SessionStore,
  SlackStatus,
  StatusPolicy,
  StatusReadResponse,
} from "@agentblip/core";
import { PermanentSinkError } from "../sinks/types";
import type { Sink } from "../sinks/types";

const DEFAULT_SWEEP_INTERVAL_MS = 15_000;
/** Transient failures back off exponentially from the sweep interval to this cap. */
const MAX_BACKOFF_MS = 5 * 60_000;
/** 401s right after start are usually relay KV propagation — retry silently. */
const PERMANENT_GRACE_MS = 60_000;
/** Permanent failures past the grace window before pushes halt for good. */
const MAX_PERMANENT_FAILURES = 3;
/** Shutdown must not hang on a slow sink — `agentblip stop` waits only 5s. */
const SHUTDOWN_FLUSH_TIMEOUT_MS = 3000;
const CLEARED = "null";
/** Sentinel that never matches a real signature — forces a retry push. */
const RETRY = " retry";

export interface PusherOptions {
  store: SessionStore;
  sink: Sink;
  formatOpts: FormatOptions;
  /** How to treat a Slack status agentblip didn't set. Default: "respect". */
  policy?: StatusPolicy;
  /** OwnershipState persisted by a previous daemon run. */
  initialOwnership?: OwnershipState;
  /** Called on every ownership transition (best effort — errors are logged). */
  persistOwnership?: (state: OwnershipState) => void;
  debounceMs?: number;
  sweepIntervalMs?: number;
  log?: (message: string) => void;
}

/** Ownership summary surfaced on /state and /health. */
export interface OwnershipSummary {
  backedOff: boolean;
  savedPrior: boolean;
  policy: StatusPolicy;
}

function signatureOf(status: SlackStatus | null): string {
  // expirationSec rolls forward on every recompute — exclude it.
  return status ? `${status.emoji}|${status.text}` : CLEARED;
}

function sameOwnership(a: OwnershipState, b: OwnershipState): boolean {
  return (
    a.backedOff === b.backedOff &&
    JSON.stringify(a.lastPushed) === JSON.stringify(b.lastPushed) &&
    JSON.stringify(a.savedPrior) === JSON.stringify(b.savedPrior)
  );
}

/**
 * The sync loop: sweeps the store, recomputes the formatted status, and pushes
 * to the sink when it changes — debounced with a guaranteed trailing update.
 * While a status is live it re-pushes every statusTtlSec/2 so the rolling
 * Slack expiration never lapses under a healthy daemon.
 *
 * Every outbound attempt (change push, ttl refresh, pause/shutdown clear) is
 * guarded by core's planStatusUpdate: the current Slack status is read once
 * per attempt and the state machine decides push/restore/clear/skip — so
 * agentblip never clobbers a status it didn't set.
 */
export class Pusher {
  paused = false;
  consecutiveFailures = 0;
  /** Pushes stopped after repeated permanent sink failures — restart to retry. */
  halted = false;
  /** Last sink failure message; cleared on the next successful push. */
  lastError: string | undefined;

  private permanentFailures = 0;
  /** Earliest time evaluate() may push again after a failure (backoff). */
  private nextRetryAt = 0;
  private readonly startedAtMs = Date.now();

  private readonly store: SessionStore;
  private readonly sink: Sink;
  private readonly formatOpts: FormatOptions;
  private readonly policy: StatusPolicy;
  private readonly persistOwnershipFn?: (state: OwnershipState) => void;
  private readonly debounceMs: number;
  private readonly sweepIntervalMs: number;
  private readonly ttlSec: number;
  private readonly log: (message: string) => void;

  private ownership: OwnershipState;
  /** The legacy-mode (readable:false) warning fires once per daemon lifetime. */
  private legacyWarned = false;

  /** Assume nothing is set until we push something. */
  private lastSignature: string = CLEARED;
  private lastPushAt = 0;
  private trailing: NodeJS.Timeout | undefined;
  private interval: NodeJS.Timeout | undefined;
  private queue: Promise<void> = Promise.resolve();

  constructor(opts: PusherOptions) {
    this.store = opts.store;
    this.sink = opts.sink;
    this.formatOpts = opts.formatOpts;
    this.policy = opts.policy ?? "respect";
    this.persistOwnershipFn = opts.persistOwnership;
    this.debounceMs = opts.debounceMs ?? DEFAULT_DEBOUNCE_MS;
    this.sweepIntervalMs = opts.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
    this.ttlSec = opts.formatOpts.statusTtlSec ?? DEFAULT_STATUS_TTL_SEC;
    this.log = opts.log ?? ((message) => console.error(message));
    this.ownership = opts.initialOwnership ?? { ...EMPTY_OWNERSHIP_STATE };
    if (!sameOwnership(this.ownership, EMPTY_OWNERSHIP_STATE)) {
      // A previous run left ownership residue (e.g. crash while a foreign
      // status was displaced) — force an initial plan so a saved prior gets
      // restored / our stale status cleared even before any event arrives.
      this.lastSignature = RETRY;
    }
  }

  /** Surfaced on /state and /health for the status/doctor commands. */
  ownershipSummary(): OwnershipSummary {
    return {
      backedOff: this.ownership.backedOff,
      savedPrior: this.ownership.savedPrior !== null,
      policy: this.policy,
    };
  }

  start(): void {
    if (this.interval) return;
    this.interval = setInterval(() => this.tick(), this.sweepIntervalMs);
    this.tick();
  }

  /** Called by the server when an event lands — evaluates immediately. */
  notify(): void {
    this.evaluate();
  }

  async pause(): Promise<void> {
    if (this.paused) return;
    this.paused = true;
    this.clearTrailing();
    this.push(null, CLEARED); // immediate — pause bypasses the debounce
    await this.flush();
  }

  resume(): void {
    this.paused = false;
    this.evaluate();
  }

  /** Clears the status (if one is live) and stops all timers. */
  async shutdown(): Promise<void> {
    this.clearTrailing();
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
    this.paused = true;
    // Push even when our signature is already clear if ownership has residue:
    // a displaced status may still need restoring (or ours clearing).
    const residue =
      this.ownership.lastPushed !== null || this.ownership.savedPrior !== null;
    if (this.lastSignature !== CLEARED || residue) this.push(null, CLEARED);
    // Cap the wait: the sink allows 10s per push, but `agentblip stop` only
    // waits 5s — a slow relay must not make a normal shutdown look failed.
    await Promise.race([
      this.flush(),
      new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, SHUTDOWN_FLUSH_TIMEOUT_MS);
        timer.unref?.();
      }),
    ]);
  }

  /** Awaits all in-flight sink pushes. */
  flush(): Promise<void> {
    return this.queue;
  }

  private tick(): void {
    this.store.sweep();
    this.evaluate();
  }

  private evaluate(): void {
    if (this.paused || this.halted) return;
    if (Date.now() < this.nextRetryAt) return; // backing off after a sink failure
    const status = formatStatus(this.store.snapshot(), this.formatOpts);
    const signature = signatureOf(status);
    const now = Date.now();

    if (signature !== this.lastSignature) {
      const wait = this.debounceMs - (now - this.lastPushAt);
      if (wait > 0) {
        this.scheduleTrailing(wait);
        return;
      }
      this.push(status, signature);
      return;
    }

    // While backed off this doubles as the resume poll: each refresh re-reads
    // the current status and pushes again once the foreign status clears.
    const refreshDue =
      status !== null &&
      this.ttlSec > 0 &&
      now - this.lastPushAt >= (this.ttlSec * 1000) / 2;
    if (refreshDue) this.push(status, signature);
  }

  private scheduleTrailing(delayMs: number): void {
    if (this.trailing) return; // pending trailing push will pick up the latest state
    this.trailing = setTimeout(() => {
      this.trailing = undefined;
      this.evaluate();
    }, delayMs);
  }

  private clearTrailing(): void {
    if (this.trailing) {
      clearTimeout(this.trailing);
      this.trailing = undefined;
    }
  }

  /** One status read per push attempt; failures degrade to legacy (undefined). */
  private async readCurrent(): Promise<SlackStatus | null | undefined> {
    let read: StatusReadResponse;
    try {
      read = await this.sink.getStatus();
    } catch {
      return undefined; // read unavailable this round — plan legacy, push blind
    }
    if (!read.readable) {
      // "unsupported" (console dry-run) has nothing to overwrite — stay silent.
      if (read.reason !== "unsupported" && !this.legacyWarned) {
        this.legacyWarned = true;
        const fix =
          this.sink.name === "slack"
            ? "reissue your Slack token with the users.profile:read scope"
            : "run `agentblip setup` to re-pair with the read scope";
        this.log(
          `sink "${this.sink.name}" cannot read the current status (token lacks users.profile:read) — ` +
            "legacy mode: an existing status set by you or another app may be overwritten; " +
            fix,
        );
      }
      return undefined;
    }
    return read.status;
  }

  /** Records a planned transition: logs backoff/resume/restore, persists. */
  private commitOwnership(action: OwnershipAction): void {
    const prev = this.ownership;
    const next = action.state;
    this.ownership = next;
    if (!prev.backedOff && next.backedOff) {
      this.log(
        `existing status detected — standing down (statusPolicy: ${this.policy})`,
      );
    } else if (prev.backedOff && !next.backedOff && action.kind === "push") {
      this.log("existing status cleared — resuming status updates");
    }
    if (action.kind === "restore") {
      this.log("restored the Slack status agentblip had displaced");
    }
    if (!sameOwnership(prev, next)) {
      try {
        this.persistOwnershipFn?.(next);
      } catch (err) {
        this.log(
          `could not persist ownership state: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
  }

  private push(desired: SlackStatus | null, signature: string): void {
    this.lastPushAt = Date.now();
    this.lastSignature = signature;
    this.queue = this.queue.then(async () => {
      try {
        // Ownership guard around every outbound push: read once, then let
        // core's state machine decide what (if anything) actually goes out.
        const current = await this.readCurrent();
        const action = planStatusUpdate({
          desired,
          current,
          state: this.ownership,
          policy: this.policy,
        });
        if (action.kind === "push" || action.kind === "restore") {
          await this.sink.push(action.status);
        } else if (action.kind === "clear") {
          await this.sink.push(null);
        }
        // Commit only after the sink accepted the write (skip has no write)
        // so a failed push leaves the previous ownership intact for the retry.
        this.commitOwnership(action);
        this.consecutiveFailures = 0;
        this.permanentFailures = 0;
        this.nextRetryAt = 0;
        this.lastError = undefined;
      } catch (err) {
        this.consecutiveFailures += 1;
        const message = err instanceof Error ? err.message : String(err);
        this.lastError = message;
        const permanent = err instanceof PermanentSinkError;
        const inGrace = Date.now() - this.startedAtMs < PERMANENT_GRACE_MS;
        if (permanent && !inGrace) {
          this.permanentFailures += 1;
          if (this.permanentFailures >= MAX_PERMANENT_FAILURES) {
            this.halted = true;
            this.log(
              `sink "${this.sink.name}" rejected ${this.permanentFailures} pushes — halting status updates: ${message}`,
            );
            return;
          }
        }
        this.lastSignature = RETRY; // next evaluate retries
        this.nextRetryAt =
          Date.now() +
          Math.min(
            this.sweepIntervalMs * 2 ** (this.consecutiveFailures - 1),
            MAX_BACKOFF_MS,
          );
        // A permanent failure inside the grace window is expected (relay KV
        // propagation right after pairing) — retry without alarming the log.
        if (!(permanent && inGrace)) {
          this.log(
            `sink "${this.sink.name}" push failed (x${this.consecutiveFailures}): ${message}`,
          );
        }
      }
    });
  }
}
