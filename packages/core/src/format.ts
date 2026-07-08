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
  /** One working session, activity granularity, repoPrefix on. {project} {activity} {agent} */
  repoActivityOne: string;
  /** Multiple working sessions, activity granularity, repoPrefix on. {working} {project} {activity} */
  repoActivityMany: string;
  /** Appended when an orchestrator reported a phase. Placeholder: {phase} */
  phaseSuffix: string;
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
  repoActivityOne: "{project}: {activity}",
  repoActivityMany: "{working} agents · {project}: {activity}",
  phaseSuffix: " · {phase}",
  waitingOnly: "{waiting} agent(s) waiting on me",
};

export interface FormatOptions {
  granularity?: Granularity;
  templates?: Partial<Templates>;
  emoji?: { working?: string; waiting?: string };
  /** Append " ({project})" when a project name is known. */
  showProject?: boolean;
  /**
   * In activity granularity, lead with the repo/project name instead of the
   * agent: "b3iq: editing README.md". No-op when the session has no project.
   */
  repoPrefix?: boolean;
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
  const phase = snap.latestPhase ? redact(snap.latestPhase) : "";
  // The displayed number is total concurrent agents, not sessions — so a single
  // session that reported a fleet of 5 shows "5 agents working".
  const count = snap.agentCount;
  const single = count === 1;

  // Lead with the repo name in activity mode when we know it and it's enabled.
  const repoLed = Boolean(opts.repoPrefix && project && granularity === "activity" && activity);

  let text: string;
  if (snap.working === 0) {
    text = fill(templates.waitingOnly, { waiting: snap.waiting });
  } else if (granularity === "presence") {
    text = templates.presence;
  } else if (granularity === "activity" && activity) {
    if (repoLed) {
      text = single
        ? fill(templates.repoActivityOne, { project, activity, agent })
        : fill(templates.repoActivityMany, { working: count, project, activity });
    } else {
      text = single
        ? fill(templates.activityOne, { agent, activity, project })
        : fill(templates.activityMany, { working: count, activity });
    }
  } else {
    text = single
      ? fill(templates.workingOne, { agent, activity, project })
      : fill(templates.workingMany, { working: count, total: snap.total });
  }

  if (phase && granularity !== "presence") {
    text += fill(templates.phaseSuffix, { phase });
  }
  if (snap.working > 0 && snap.waiting > 0 && granularity !== "presence") {
    text += fill(templates.waitingSuffix, { waiting: snap.waiting });
  }
  // Skip the "(project)" suffix when the repo is already the prefix.
  if (opts.showProject && project && granularity !== "presence" && !repoLed) {
    text += ` (${project})`;
  }

  const ttl = opts.statusTtlSec ?? DEFAULT_STATUS_TTL_SEC;
  return {
    text: truncate(text, opts.maxLen ?? SLACK_STATUS_MAX_LEN),
    emoji: snap.working > 0 ? emoji.working : emoji.waiting,
    expirationSec: ttl > 0 ? Math.floor(nowMs / 1000) + ttl : 0,
  };
}
