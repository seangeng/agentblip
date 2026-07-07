import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { EMPTY_OWNERSHIP_STATE, slackStatusSchema } from "@agentblip/core";
import type { OwnershipState } from "@agentblip/core";
import { ownershipStatePath } from "./paths";

/**
 * OwnershipState persisted across daemon runs so a crash while a foreign
 * status was displaced (overwrite policy) can still restore it on the next
 * start, and a stale "we own the slot" belief survives a restart.
 */
const ownershipStateSchema = z.object({
  lastPushed: slackStatusSchema.nullable(),
  savedPrior: slackStatusSchema.nullable(),
  backedOff: z.boolean(),
});

/** Missing or corrupt file → EMPTY_OWNERSHIP_STATE (never blocks startup). */
export function loadOwnershipState(file = ownershipStatePath()): OwnershipState {
  try {
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    return ownershipStateSchema.parse(raw);
  } catch {
    return { ...EMPTY_OWNERSHIP_STATE };
  }
}

export function saveOwnershipState(
  state: OwnershipState,
  file = ownershipStatePath(),
): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(state, null, 2)}\n`);
}
