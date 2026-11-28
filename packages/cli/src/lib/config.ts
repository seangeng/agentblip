import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import { DEFAULT_DAEMON_PORT, DEFAULT_DEBOUNCE_MS, DEFAULT_STATUS_TTL_SEC } from "@workmesh/core";
import {
  HUB_DEVICE_TOKEN_RE,
  HUB_GITHUB_LOGIN_RE,
  HUB_REPO_RE,
  HUB_REVIEW_AGENTS,
  hubCapacityProviderSchema,
  hubCapacityShareSchema,
  hubHandoffAgentSchema,
  hubPoolModeSchema,
  hubProjectRuleSchema,
  hubRequestSizeSchema,
  hubShareLevelSchema,
} from "@workmesh/protocol";
import { REQUEST_RULES_MAX, REQUEST_RULE_PER_DAY_MAX, type RequestRule } from "../daemon/request-rules";
import { POOL_RULES_MAX, POOL_RULE_PER_DAY_MAX, type PoolRule, type PoolSettings } from "../daemon/pool-rules";
import type { FormatOptions } from "@workmesh/core";
import type { HubCapacityShareLevel, HubHandoffAgent, HubReviewAgent, HubShareLevel } from "@workmesh/protocol";
import { envSetting } from "./names";
import { configPath } from "./paths";

/** One standing rule for requests (SPEC §56), as the config keeps it. */
export const requestRuleSchema = z.object({
  from: z.string().trim().toLowerCase().max(254).regex(/^[^\s@]+@[^\s@]+\.[^\s@]+$/),
  repo: z.string().max(200).regex(HUB_REPO_RE).optional(),
  maxSize: hubRequestSizeSchema,
  perDay: z.number().int().min(1).max(REQUEST_RULE_PER_DAY_MAX),
});

/** One local opt-in capacity pool rule (SPEC §58), added only at the owner's terminal. */
export const poolRuleSchema = z.object({
  from: z
    .string()
    .trim()
    .toLowerCase()
    .max(254)
    .refine((v) => v === "team" || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "from must be `team` or an email"),
  providers: z.array(hubCapacityProviderSchema).min(1).max(8),
  modes: z.array(hubPoolModeSchema).min(1).max(2),
  repo: z
    .string()
    .max(200)
    .refine((v) => HUB_REPO_RE.test(v) || /^[\w.-]+\/\*$/.test(v), "repo must be owner/name or owner/*")
    .optional(),
  minHeadroom: z.number().min(0).max(95).default(30),
  expiringFloor: z.number().min(0).max(95).default(10),
  perDay: z.number().int().min(1).max(POOL_RULE_PER_DAY_MAX).default(10),
});

const templatesSchema = z
  .object({
    presence: z.string(),
    workingOne: z.string(),
    workingMany: z.string(),
    waitingSuffix: z.string(),
    activityOne: z.string(),
    activityMany: z.string(),
    repoActivityOne: z.string(),
    repoActivityMany: z.string(),
    waitingOnly: z.string(),
  })
  .partial();

/**
 * Hub forward (team hub): pairing result plus local include/exclude dirs.
 * Holds a device token, so it lives in the 0600 config file only.
 */
export const hubConfigSchema = z.object({
  url: z.url(),
  deviceId: z.string().min(1),
  deviceToken: z.string().regex(HUB_DEVICE_TOKEN_RE),
  machine: z.string().max(120).optional(),
  person: z.object({ email: z.string(), name: z.string() }).optional(),
  project: hubProjectRuleSchema,
  /** Absolute dirs shared on top of the project's rule (`workmesh hub include`). */
  includeDirs: z.array(z.string()).default([]),
  /** Absolute dirs never shared, whatever their remote (`workmesh hub exclude`). */
  excludeDirs: z.array(z.string()).default([]),
  pairedAt: z.number().int().optional(),
  /**
   * SPEC §8 sharing level, chosen by the person (`hub connect --share`,
   * `hub share`). Absent (0.6 pairings, a connect with no terminal and no
   * `--share`) means `conversation`, the default since 0.7 (Sean, 11-24): see
   * hubShareLevel. An unknown value reads as absent.
   */
  share: hubShareLevelSchema.optional().catch(undefined),
  /**
   * Whether a session stays shared for the rest of its life once it touches a
   * shared repo (SPEC §8). Absent or true: yes (the default). False
   * (`hub sticky off`): a session whose cwd is outside every shared repo is
   * shared turn by turn, only for turns that touch a shared repo.
   */
  stickyShare: z.boolean().optional().catch(undefined),
  /** v0.6: the person's GitHub login, read from `gh` at `hub connect` (an avatar on the board and menu bar). */
  github: z.string().regex(HUB_GITHUB_LOGIN_RE).optional().catch(undefined),
});
export type HubConfig = z.infer<typeof hubConfigSchema>;

/** The level a hub section shares at: `conversation` unless the person chose `metadata`. */
export function hubShareLevel(hub: Pick<HubConfig, "share"> | undefined): HubShareLevel {
  return hub?.share ?? "conversation"; // max sharing by default (Sean, 11-24)
}

/** Whether shared sessions stay shared once they touch a shared repo (default true). */
export function hubStickyShare(hub: Pick<HubConfig, "stickyShare"> | undefined): boolean {
  return hub?.stickyShare ?? true;
}

/** The waiting time for new releases (SPEC §41): a day by default, 30 days at most. */
export const DEFAULT_UPDATE_WAIT_HOURS = 24;
export const MAX_UPDATE_WAIT_HOURS = 24 * 30;

export const configSchema = z.object({
  mode: z.enum(["relay", "slack", "console"]).default("console"),
  relayUrl: z.url().default("https://agentblip.com"),
  deviceToken: z.string().optional(),
  slackToken: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_DAEMON_PORT),
  granularity: z.enum(["off", "presence", "count", "activity"]).default("count"),
  /** How to treat a Slack status Workmesh didn't set (ownership guard). */
  statusPolicy: z.enum(["respect", "overwrite"]).default("respect"),
  showProject: z.boolean().default(false),
  /** Lead the activity status with the repo name ("b3iq: editing README.md"). */
  repoPrefix: z.boolean().default(true),
  statusTtlSec: z.number().int().nonnegative().default(DEFAULT_STATUS_TTL_SEC),
  debounceMs: z.number().int().nonnegative().default(DEFAULT_DEBOUNCE_MS),
  templates: templatesSchema.optional(),
  emoji: z
    .object({ working: z.string().optional(), waiting: z.string().optional() })
    .optional(),
  redactPatterns: z.array(z.string()).optional(),
  hideProjects: z.array(z.string()).optional(),
  adapters: z
    .object({
      claudeCode: z
        .object({
          enabled: z.boolean().default(true),
          /**
           * Claude Code config dir the daemon reads sessions and workflows
           * from (`setup --claude-dir`). Unset: $CLAUDE_CONFIG_DIR, else ~/.claude.
           */
          configDir: z.string().optional(),
        })
        .default({ enabled: true }),
      codex: z
        .object({
          enabled: z.boolean().default(true),
          sessionsDir: z.string().optional(),
        })
        .default({ enabled: true }),
      workflow: z
        .object({
          enabled: z.boolean().default(true),
          projectsDir: z.string().optional(),
        })
        .default({ enabled: true }),
      opencode: z
        .object({
          enabled: z.boolean().default(true),
          dbPath: z.string().optional(),
        })
        .default({ enabled: true }),
      gemini: z
        .object({
          enabled: z.boolean().default(true),
          dir: z.string().optional(),
        })
        .default({ enabled: true }),
      harness: z
        .object({
          enabled: z.boolean().default(true),
        })
        .default({ enabled: true }),
    })
    .default({
      claudeCode: { enabled: true },
      codex: { enabled: true },
      workflow: { enabled: true },
      opencode: { enabled: true },
      gemini: { enabled: true },
      harness: { enabled: true },
    }),
  autoStartDaemon: z.boolean().default(true),
  /**
   * v2 Delegate (SPEC §31): handoffs this machine takes. Absent = the defaults below. A malformed section reads as
   * absent.
   */
  handoffs: z
    .object({
      /**
       * `ask` (default): every handoff waits for your Accept, your own too. `auto-self`: a handoff you sent yourself
       * starts on one of your machines at once, with no click; others' wait for your Accept. It trusts every machine
       * and token of yours: each of them, and any agent running there, can start an agent here. `never`: this machine
       * runs no handoffs.
       */
      accept: z.enum(["ask", "auto-self", "never"]).optional().catch(undefined),
      /**
       * What happens to a handoff that was accepted somewhere else, on the board or on another machine. `confirm`
       * (default): it waits here until you say "run it here". `auto`: this machine starts it. `auto` trusts the hub's
       * word that you accepted it.
       */
      runAccepted: z.enum(["confirm", "auto"]).optional().catch(undefined),
      /** The agent CLI that runs handoffs (default: auto by qswap headroom, else claude/codex/opencode). */
      agent: hubHandoffAgentSchema.optional().catch(undefined),
      /** Dirs whose git repos count as checkouts for handoffs (`workmesh roots add <dir>`). */
      roots: z.array(z.string()).default([]).catch([]),
      /** Run each handoff in a new git worktree on its own branch (default true). */
      worktree: z.boolean().optional().catch(undefined),
      maxRunning: z.number().int().min(0).max(10).optional().catch(undefined),
      /** Claude Code `--permission-mode` for a handoff's session (default `auto`). */
      permissionMode: z.enum(["acceptEdits", "auto", "bypassPermissions", "manual", "dontAsk", "plan"]).optional().catch(undefined),
      /** The model a handoff's agent runs on (`--model` / `-m`, e.g. `haiku`, `sonnet`); absent: the agent's default. */
      model: z.string().regex(/^[\w.:\[\]/-]{1,80}$/).optional().catch(undefined),
      maxMinutes: z.number().int().min(5).max(24 * 60).optional().catch(undefined),
      /**
       * Environment variables a handoff's agent gets although their names look like secrets (`GH_TOKEN`). The agent
       * starts without such variables, except what its own tool signs in with. Names only, never values.
       */
      env: z.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]{0,127}$/)).max(100).optional().catch(undefined),
      /**
       * Standing rules for requests (SPEC §56): requests this machine accepts with no click, from one person (exact
       * email), optionally in one repo, up to a size, at most so many a day. Added only at a terminal
       * (`workmesh handoffs rule add`). A malformed rule is dropped on its own.
       */
      requestRules: z
        .preprocess(
          (v) => (Array.isArray(v) ? v.filter((r) => requestRuleSchema.safeParse(r).success).slice(0, REQUEST_RULES_MAX) : undefined),
          z.array(requestRuleSchema).optional(),
        )
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  /**
   * Review exchange (SPEC §53): teammates' PR reviews this machine runs, and the reviews its sessions ask for. Absent =
   * the defaults below. A malformed section, or a malformed key in it, reads as absent.
   */
  reviews: z
    .object({
      /**
       * `ask` (default): a review handoff waits for your Accept, as any handoff does. `auto`: this machine starts it at
       * once. A review is read-only: a fresh checkout of the PR's head, no push, merge or approval. `never`: this
       * machine runs no reviews (the hub then asks someone else).
       */
      accept: z.enum(["auto", "ask", "never"]).optional().catch(undefined),
      /**
       * Post this machine's reviews on the PR as a comment, through your own `gh` (default false). Never an approval:
       * a person approves the PR.
       */
      postToGitHub: z.boolean().optional().catch(undefined),
      /** The agent CLI reviews run on (`auto` routes via qswap fleet_status.json; default: `handoffs.agent`, else claude, codex, …). */
      agent: z.enum([...HUB_REVIEW_AGENTS, "auto"] as const).optional().catch(undefined),
      /** The model reviews run on (default: `handoffs.model`, else the agent's default). */
      model: z.string().regex(/^[\w.:\[\]/-]{1,80}$/).optional().catch(undefined),
      /**
       * Ask for an agent review by itself when a session here opens a PR (not a draft) or marks one ready. Absent:
       * your setting on the board (off by default) and the team's repos where every ready PR gets one.
       */
      auto: z.boolean().optional().catch(undefined),
      /** Reviewers one review asks: 1 (default) or 2. */
      count: z.number().int().min(1).max(2).optional().catch(undefined),
      /** A review is stopped after this long (default 30 min). */
      maxMinutes: z.number().int().min(5).max(240).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  /** v2: wake an idle session when a message for it arrives (default true; `workmesh wake off`). */
  wake: z.boolean().optional().catch(undefined),
  /**
   * Who may reach this machine's sessions (SPEC §23). This machine decides: what a sender or the hub asks for is a
   * request. Absent = the defaults below. A malformed section, or a malformed key in it, reads as absent.
   */
  messages: z
    .object({
      /**
       * Whose message may start a turn in an idle session, while `wake` is on. `replies` (default): your own messages,
       * and a reply from a person (or their agent) that the session wrote to first. `team`: anyone on the team.
       * `self`: only your own. A list of people: those people, and your own. An entry is an email, or a display
       * name that stands for the one person on the team with it (SPEC §23).
       */
      wake: z
        .union([z.enum(["replies", "team", "self"]), z.array(z.string().min(1).max(200)).max(100)])
        .optional()
        .catch(undefined),
      /**
       * Which sessions get a teammate's message only after the person said so. `bypass` (default): a session that
       * runs with permission prompts skipped. `unattended`: also one in an automatic mode. `always`: every session.
       * `never`: none. A held message is shown to the person (menu bar, `workmesh inbox --held`), never to the agent.
       */
      /** Require signed-in board approval for each native tool call after a teammate’s message. */
      confirmActions: z.boolean().optional().catch(undefined),
      hold: z.enum(["bypass", "unattended", "always", "never"]).optional().catch(undefined),
      /** How long a held message waits for the person before it is dropped, in minutes (default 60). */
      holdMinutes: z.number().int().min(1).max(7 * 24 * 60).optional().catch(undefined),
      /**
       * Whose messages this machine takes at all. `team` (default): anyone on the team. `self`: only your own. A
       * list of people, read as for `wake`: those people, and your own. A message from anyone else is dropped here
       * and never delivered.
       */
      from: z
        .union([z.enum(["team", "self"]), z.array(z.string().min(1).max(200)).max(100)])
        .optional()
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  /** v2: the person's own patterns for the `custom` approval gate (case-insensitive regexes over a shell command). */
  gates: z
    .object({ custom: z.array(z.string().max(300)).max(50).default([]).catch([]) })
    .optional()
    .catch(undefined),
  /**
   * 0.12 (SPEC §41): updates the daemon installs on its own (`workmesh update --auto on|off`). Absent = off. `scope`
   * `patch` (default) takes 0.12.0 → 0.12.3 only; `minor` takes 0.12.x → 0.13.0 too. Never a new major or a prerelease.
   * The `waitHours` key is how old a release must be before the daemon offers it or installs it on its own (default
   * 24; 0 turns the wait off). Run by hand, `workmesh update` never waits.
   */
  update: z
    .object({
      auto: z.boolean().optional().catch(undefined),
      scope: z.enum(["patch", "minor"]).optional().catch(undefined),
      waitHours: z.number().min(0).max(MAX_UPDATE_WAIT_HOURS).optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  /**
   * Opt-in fleet capacity reporting (SPEC §57): off by default. Set only at the person's terminal
   * (`workmesh capacity share off|availability|detailed`).
   */
  capacity: z
    .object({
      share: hubCapacityShareSchema.optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
  /**
   * Opt-in team delegation pool (SPEC §58): lets teammates delegate worktree PR and readonly tasks
   * to this machine's spare subscriptions when live qswap headroom stays above the local reserve floor.
   */
  pool: z
    .object({
      enabled: z.boolean().optional().catch(undefined),
      rules: z
        .preprocess(
          (v) => (Array.isArray(v) ? v.filter((r) => poolRuleSchema.safeParse(r).success).slice(0, POOL_RULES_MAX) : undefined),
          z.array(poolRuleSchema).optional(),
        )
        .catch(undefined),
    })
    .optional()
    .catch(undefined),
  /**
   * Present once paired with a hub (`workmesh hub connect`). A malformed
   * section reads as "not paired" instead of invalidating the Slack config.
   */
  hub: hubConfigSchema.optional().catch(undefined),
});

export type Config = z.infer<typeof configSchema>;

export function defaultConfig(): Config {
  return applyEnvOverrides(configSchema.parse({}));
}

/** Loads config, applying schema defaults and env overrides. Throws on a corrupt file. */
export function loadConfig(file = configPath()): Config {
  let raw: unknown = {};
  if (fs.existsSync(file)) {
    const text = fs.readFileSync(file, "utf8");
    try {
      raw = JSON.parse(text) as unknown;
    } catch {
      throw new Error(
        `invalid JSON in ${file} — fix or delete it, then run \`workmesh setup\``,
      );
    }
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid config at ${file}: ${detail}`);
  }
  return applyEnvOverrides(parsed.data);
}

/** Like loadConfig but never throws — falls back to defaults (used by `hook`). */
export function loadConfigSafe(file = configPath()): Config {
  try {
    return loadConfig(file);
  } catch {
    return defaultConfig();
  }
}

function applyEnvOverrides(config: Config): Config {
  // WORKMESH_*, or the pre-rename AGENTBLIP_* when that is all that is set.
  const relayUrl = envSetting("RELAY_URL");
  if (relayUrl) config.relayUrl = relayUrl;
  const token = envSetting("TOKEN");
  if (token) config.deviceToken = token;
  const port = envSetting("PORT");
  if (port) {
    const n = Number.parseInt(port, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) config.port = n;
  }
  const policy = envSetting("STATUS_POLICY");
  if (policy === "respect" || policy === "overwrite") config.statusPolicy = policy;
  return config;
}

export function saveConfig(config: Config, file = configPath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, {
    mode: 0o600,
  });
  // writeFileSync's mode only applies on create — enforce on rewrite too.
  fs.chmodSync(file, 0o600);
}

/**
 * The subset of config the running daemon can change on the fly (via the menu
 * bar app / POST /config). Anything affecting the connection — mode, port,
 * tokens, relayUrl — needs a restart and is intentionally excluded.
 */
export const liveConfigPatchSchema = z
  .object({
    granularity: z.enum(["off", "presence", "count", "activity"]),
    statusPolicy: z.enum(["respect", "overwrite"]),
    showProject: z.boolean(),
    repoPrefix: z.boolean(),
  })
  .partial()
  .strict();

export type LiveConfigPatch = z.infer<typeof liveConfigPatchSchema>;

/** Config view safe to expose over the loopback API — never includes tokens. */
export interface SafeConfig {
  mode: Config["mode"];
  relayUrl: string;
  port: number;
  granularity: Config["granularity"];
  statusPolicy: Config["statusPolicy"];
  showProject: boolean;
  repoPrefix: boolean;
  statusTtlSec: number;
  debounceMs: number;
  /** Hub pairing without its token; absent when not paired. */
  hub?: { url: string; project: { id: string; name: string }; share: HubShareLevel };
}

export function safeConfig(config: Config): SafeConfig {
  return {
    mode: config.mode,
    relayUrl: config.relayUrl,
    port: config.port,
    granularity: config.granularity,
    statusPolicy: config.statusPolicy,
    showProject: config.showProject,
    repoPrefix: config.repoPrefix,
    statusTtlSec: config.statusTtlSec,
    debounceMs: config.debounceMs,
    ...(config.hub
      ? {
          hub: {
            url: config.hub.url,
            project: { id: config.hub.project.id, name: config.hub.project.name },
            share: hubShareLevel(config.hub),
          },
        }
      : {}),
  };
}

/**
 * The hub section as it is on disk right now: undefined when not paired,
 * "unreadable" when the file can't be parsed (callers then keep what they have).
 */
export function readHubConfig(file = configPath()): HubConfig | undefined | "unreadable" {
  try {
    return loadConfig(file).hub;
  } catch {
    return "unreadable";
  }
}

/** The v2 settings with their defaults (SPEC §31). */
/** Auto-update settings (SPEC §41): off unless the person turned it on; patch releases only by default. */
export function autoUpdateSettings(config: Pick<Config, "update">): { enabled: boolean; scope: "patch" | "minor" } {
  return { enabled: config.update?.auto === true, scope: config.update?.scope ?? "patch" };
}

/**
 * How many hours a release must be out before the daemon offers it or installs it on its own (SPEC §41): 24 unless
 * the person set `update.waitHours`; 0 is no wait. A value the schema refuses reads as absent, so a typo keeps the
 * default instead of turning the wait off.
 */
export function updateWaitHours(config: Pick<Config, "update">): number {
  return config.update?.waitHours ?? DEFAULT_UPDATE_WAIT_HOURS;
}

/** Whose message may wake an idle session: one of the three rules, or a list of people. */
export type MessageWakeRule = "replies" | "team" | "self" | string[];

/** Which sessions get a teammate's message only after the person said so. */
export type MessageHoldRule = "bypass" | "unattended" | "always" | "never";
/** Whose messages this machine takes at all: the whole team, only the person's own, or a list of people. */
export type MessageFromRule = "team" | "self" | string[];

/** Who may reach this machine's sessions (SPEC §23), with the defaults. */
export interface MessageSettings {
  wake: MessageWakeRule;
  hold: MessageHoldRule;
  /** How long a held message waits for the person before it is dropped. */
  holdMinutes: number;
  from: MessageFromRule;
}

export function messageSettings(config: Pick<Config, "messages">): MessageSettings {
  const m = config.messages;
  return { wake: m?.wake ?? "replies", hold: m?.hold ?? "bypass", holdMinutes: m?.holdMinutes ?? 60, from: m?.from ?? "team" };
}

export function delegateSettings(
  config: Pick<Config, "handoffs" | "wake" | "gates"> & Partial<Pick<Config, "reviews" | "pool">>,
): {
  wake: boolean;
  accept: "ask" | "auto-self" | "never";
  runAccepted: "confirm" | "auto";
  agent?: HubHandoffAgent;
  roots: string[];
  worktree: boolean;
  maxRunning: number;
  permissionMode: string;
  model?: string;
  maxMinutes: number;
  env: string[];
  customGates: string[];
  requestRules: RequestRule[];
  reviewAccept: "auto" | "ask" | "never";
  pool: PoolSettings;
} {
  const h = config.handoffs;
  return {
    wake: config.wake ?? true,
    accept: h?.accept ?? "ask",
    runAccepted: h?.runAccepted ?? "confirm",
    agent: h?.agent,
    roots: h?.roots ?? [],
    worktree: h?.worktree ?? true,
    maxRunning: h?.maxRunning ?? 2,
    permissionMode: h?.permissionMode ?? "auto",
    ...(h?.model ? { model: h.model } : {}),
    maxMinutes: h?.maxMinutes ?? 120,
    env: h?.env ?? [],
    customGates: config.gates?.custom ?? [],
    requestRules: h?.requestRules ?? [],
    reviewAccept: config.reviews?.accept ?? "ask",
    pool: poolSettings(config),
  };
}

export function capacityShareLevel(config: Partial<Pick<Config, "capacity">>): HubCapacityShareLevel {
  return config.capacity?.share ?? "off";
}

export function poolSettings(config: Partial<Pick<Config, "pool">>): PoolSettings {
  return {
    enabled: config.pool?.enabled === true,
    rules: (config.pool?.rules ?? []) as PoolRule[],
  };
}

/**
 * A change to the config's `reviews` section (SPEC §53): a value sets the key, `null` removes it (its default again).
 * Only a person's own terminal reaches this (`review_policy`); the hub and agents never do.
 */
export function patchReviewConfig(config: Config, patch: Partial<Record<keyof ReviewSettings, unknown>>): Config {
  const next: Record<string, unknown> = { ...(config.reviews ?? {}) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) continue;
    if (v === null) delete next[k];
    else next[k] = v;
  }
  const parsed = configSchema.shape.reviews.safeParse(next);
  return { ...config, reviews: parsed.success ? parsed.data : config.reviews };
}

/** Review exchange (SPEC §53): this machine's review settings, with the defaults. */
export interface ReviewSettings {
  accept: "auto" | "ask" | "never";
  postToGitHub: boolean;
  agent?: HubReviewAgent | "auto";
  model?: string;
  /** Undefined: the hub's word (the person's board setting, the team's repos). */
  auto?: boolean;
  count: 1 | 2;
  maxMinutes: number;
}

export function reviewSettings(config: Pick<Config, "reviews" | "handoffs">): ReviewSettings {
  const r = config.reviews;
  const fallbackAgent =
    config.handoffs?.agent && (HUB_REVIEW_AGENTS as readonly string[]).includes(config.handoffs.agent)
      ? (config.handoffs.agent as HubReviewAgent)
      : undefined;
  const agent = r?.agent ?? fallbackAgent;
  const model = r?.model ?? config.handoffs?.model;
  return {
    accept: r?.accept ?? "ask",
    postToGitHub: r?.postToGitHub ?? false,
    ...(agent ? { agent } : {}),
    ...(model ? { model } : {}),
    ...(r?.auto === undefined ? {} : { auto: r.auto }),
    count: r?.count === 2 ? 2 : 1,
    maxMinutes: r?.maxMinutes ?? 30,
  };
}

export function formatOptionsFromConfig(config: Config): FormatOptions {
  return {
    granularity: config.granularity,
    templates: config.templates,
    emoji: config.emoji,
    showProject: config.showProject,
    repoPrefix: config.repoPrefix,
    statusTtlSec: config.statusTtlSec,
    redactPatterns: config.redactPatterns,
  };
}
