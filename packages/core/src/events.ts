import { z } from "zod";
import { SLACK_STATUS_MAX_LEN } from "./constants";

/**
 * Wire contracts shared by the CLI daemon, its adapters, and the relay Worker.
 * The daemon is the only thing that sees raw session data; the relay only ever
 * receives a pre-formatted SlackStatus (or null to clear).
 */

export const sessionStateSchema = z.enum(["working", "waiting", "idle"]);
export type SessionState = z.infer<typeof sessionStateSchema>;

export const eventKindSchema = z.enum([
  "start", // session opened (not yet working)
  "working", // agent is actively doing something
  "waiting", // agent blocked on the human (permission prompt, question)
  "idle", // turn finished, session still open
  "heartbeat", // refresh liveness without changing state
  "end", // session closed
]);
export type EventKind = z.infer<typeof eventKindSchema>;

export const sessionEventSchema = z.object({
  source: z.string().min(1).max(64), // "claude-code" | "codex" | any custom id
  sessionId: z.string().min(1).max(128),
  kind: eventKindSchema,
  activity: z.string().max(200).optional(), // short label, e.g. "editing format.ts"
  project: z.string().max(120).optional(), // usually basename of cwd
  ts: z.number().int().positive().optional(), // epoch ms; defaults to receipt time
});
export type SessionEvent = z.infer<typeof sessionEventSchema>;

export const slackStatusSchema = z.object({
  text: z.string().max(SLACK_STATUS_MAX_LEN),
  emoji: z.string().max(64), // ":robot_face:" form
  expirationSec: z.number().int().nonnegative(), // epoch seconds; 0 = never expires
});
export type SlackStatus = z.infer<typeof slackStatusSchema>;

/** POST /api/status — body. `status: null` clears the Slack status. */
export const statusUpdateRequestSchema = z.object({
  status: slackStatusSchema.nullable(),
});
export type StatusUpdateRequest = z.infer<typeof statusUpdateRequestSchema>;

// --- Pairing (device-code flow) ---

/** POST /api/pair/start — response. */
export const pairStartResponseSchema = z.object({
  code: z.string(), // short human code the user confirms in the browser
  deviceId: z.string(),
  pollSecret: z.string(),
  verifyUrl: z.string(), // https://agentblip.com/pair?code=XXXX
  expiresInSec: z.number().int().positive(),
});
export type PairStartResponse = z.infer<typeof pairStartResponseSchema>;

/** POST /api/pair/poll — request. */
export const pairPollRequestSchema = z.object({
  deviceId: z.string().min(1),
  pollSecret: z.string().min(1),
});
export type PairPollRequest = z.infer<typeof pairPollRequestSchema>;

/** POST /api/pair/poll — response. deviceToken present only once, on `complete`. */
export const pairPollResponseSchema = z.object({
  status: z.enum(["pending", "complete", "expired"]),
  deviceToken: z.string().optional(),
  team: z.string().optional(), // Slack workspace name, for a friendly confirmation
});
export type PairPollResponse = z.infer<typeof pairPollResponseSchema>;
