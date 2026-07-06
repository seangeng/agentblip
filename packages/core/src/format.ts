import type { SlackStatus } from "./events";
import type { StatusSnapshot } from "./types";
import {
  DEFAULT_STATUS_TTL_SEC,
  SLACK_STATUS_MAX_LEN,
  displayName,
} from "./constants";
import { redactText } from "./redact";

/**
 * Granularity controls how much your Slack status reveals:
 *  - off:      never set a status
 *  - presence: a fixed message while any agent is working
 *  - count:    "3 agents working"
 *  - activity: count + what the most recent agent is doing
 */
export type Granularity = "off" | "presence" | "count" | "activity";

export interface Templates {
  /** Fixed text for `presence` granularity. */
  presence: string;
  /** One working session. Placeholders: {agent} {activity} {project} */
  workingOne: string;
  /** Multiple working sessions. Placeholders: {working} {total} */
  workingMany: string;
  /** Appended when sessions are waiting on the human. Placeholder: {waiting} */
  waitingSuffix: string;
  /** One working session, activity granularity. {agent} {activity} {project} */
  activityOne: string;
  /** Multiple working sessions, activity granularity. {working} {activity} */
  activityMany: string;
  /** Only waiting sessions remain (nothing working). Placeholder: {waiting} */
  waitingOnly: string;
}

export const DEFAULT_TEMPLATES: Templates = {
  presence: "heads down with agents",
  workingOne: "{agent} agent working",
  workingMany: "{working} agents working",
  waitingSuffix: " · {waiting} waiting on me",
  activityOne: "{agent}: {activity}",
  activityMany: "{working} agents · {activity}",
  waitingOnly: "{waiting} agent(s) waiting on me",
};

export interface FormatOptions {
  granularity?: Granularity;
  templates?: Partial<Templates>;
  emoji?: { working?: string; waiting?: string };
  /** Append " ({project})" when a project name is known. */
  showProject?: boolean;
  /** Rolling expiration window in seconds (0 disables expiration). */
  statusTtlSec?: number;
  /** Redaction patterns applied to activity/project text. */
  redactPatterns?: string[];
  maxLen?: number;
}

const DEFAULT_EMOJI = { working: ":robot_face:", waiting: ":raised_hand:" };

function fill(template: string, vars: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, k: string) =>
    k in vars ? String(vars[k]) : `{${k}}`,
  );
}

function truncate(text: string, maxLen: number): string {
  return text.length <= maxLen ? text : `${text.slice(0, maxLen - 1)}…`;
}

/**
 * Turn a snapshot into a Slack status, or null when the status should be
 * cleared (no live sessions, or granularity off).
 */
export function formatStatus(
  snap: StatusSnapshot,
  opts: FormatOptions = {},
  nowMs = Date.now(),
): SlackStatus | null {
  const granularity = opts.granularity ?? "count";
  if (granularity === "off") return null;
  if (snap.working === 0 && snap.waiting === 0) return null;

  const templates = { ...DEFAULT_TEMPLATES, ...opts.templates };
  const emoji = { ...DEFAULT_EMOJI, ...opts.emoji };
  const redact = (s: string) =>
    opts.redactPatterns?.length ? redactText(s, opts.redactPatterns) : s;

  const active = snap.sessions.find((s) => s.state === "working");
  const agent = active ? displayName(active.source) : "";
  const activity = redact(snap.latestActivity ?? "");
  const project = active?.project ? redact(active.project) : "";

  let text: string;
  if (snap.working === 0) {
    text = fill(templates.waitingOnly, { waiting: snap.waiting });
  } else if (granularity === "presence") {
    text = templates.presence;
  } else if (granularity === "activity" && activity) {
    text =
      snap.working === 1
        ? fill(templates.activityOne, { agent, activity, project })
        : fill(templates.activityMany, { working: snap.working, activity });
  } else {
    text =
      snap.working === 1
        ? fill(templates.workingOne, { agent, activity, project })
        : fill(templates.workingMany, {
            working: snap.working,
            total: snap.total,
          });
  }

  if (snap.working > 0 && snap.waiting > 0 && granularity !== "presence") {
    text += fill(templates.waitingSuffix, { waiting: snap.waiting });
  }
  if (opts.showProject && project && granularity !== "presence") {
    text += ` (${project})`;
  }

  const ttl = opts.statusTtlSec ?? DEFAULT_STATUS_TTL_SEC;
  return {
    text: truncate(text, opts.maxLen ?? SLACK_STATUS_MAX_LEN),
    emoji: snap.working > 0 ? emoji.working : emoji.waiting,
    expirationSec: ttl > 0 ? Math.floor(nowMs / 1000) + ttl : 0,
  };
}
