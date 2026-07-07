import fs from "node:fs";
import { planStatusUpdate } from "@agentblip/core";
import type { SlackStatus } from "@agentblip/core";
import { loadConfigSafe, saveConfig } from "../lib/config";
import { configPath, ownershipStatePath } from "../lib/paths";
import { loadOwnershipState } from "../lib/ownership-state";
import { createSink } from "../sinks";
import { dim, errorMessage, green, yellow } from "../lib/ui";

const HTTP_TIMEOUT_MS = 10_000;

/**
 * Decide what happens to the Slack status when the device is unlinked, honoring
 * the same ownership rules the daemon uses: never wipe a status agentblip
 * didn't set, and restore one it displaced. Returns whether the relay should
 * do the clear server-side (true) or leave the status as-is (false).
 */
async function settleStatusBeforeUnlink(
  config: ReturnType<typeof loadConfigSafe>,
): Promise<boolean> {
  const ownership = loadOwnershipState();
  let sink: ReturnType<typeof createSink>;
  try {
    sink = createSink(config);
  } catch {
    return true; // can't build a sink — fall back to legacy clear
  }

  let current: SlackStatus | null | undefined;
  try {
    const read = await sink.getStatus();
    current = read.readable ? read.status : undefined;
  } catch {
    current = undefined; // read unavailable → legacy plan (blind clear if ours)
  }

  const action = planStatusUpdate({
    desired: null,
    current,
    state: ownership,
    policy: config.statusPolicy,
  });
  if (action.kind === "restore") {
    try {
      await sink.push(action.status); // put back what we displaced
    } catch {
      /* best effort — unlink proceeds regardless */
    }
    return false;
  }
  // "clear" → let the relay clear our status; "skip" → foreign status, leave it.
  return action.kind === "clear";
}

export async function runUnlink(): Promise<void> {
  const config = loadConfigSafe();
  if (!config.deviceToken) {
    console.log(dim("no device token saved — nothing to unlink"));
    return;
  }

  const clear = await settleStatusBeforeUnlink(config);
  try {
    const res = await fetch(new URL("/api/unlink", config.relayUrl), {
      method: "POST",
      headers: {
        authorization: `Bearer ${config.deviceToken}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ clear }),
      signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
    });
    if (res.ok) {
      console.log(
        green(
          clear
            ? "device revoked on relay; Slack status cleared"
            : "device revoked on relay; your existing Slack status was left untouched",
        ),
      );
    } else if (res.status === 401) {
      console.log(dim("relay no longer recognizes this device (already unlinked)"));
    } else {
      console.log(yellow(`relay responded ${res.status} — removing local token anyway`));
    }
  } catch (err) {
    console.log(
      yellow(`could not reach relay (${errorMessage(err)}) — removing local token anyway`),
    );
  }

  // Reset ownership so a later re-pair can't resurrect a stale saved prior.
  try {
    fs.rmSync(ownershipStatePath(), { force: true });
  } catch {
    /* ignore */
  }

  delete config.deviceToken;
  const wasRelay = config.mode === "relay";
  if (wasRelay) {
    // Relay mode without a token can't create a sink — a daemon (auto)started
    // in that state just crashes. Fall back to the dry-run sink.
    config.mode = "console";
  }
  saveConfig(config);
  console.log(green(`device token removed from ${configPath()}`));
  if (wasRelay) {
    console.log(dim("mode set to console — run `agentblip setup` to pair again"));
  }
}
