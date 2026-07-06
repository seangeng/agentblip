import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  DEFAULT_DAEMON_PORT,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_STATUS_TTL_SEC,
} from "@agentblip/core";
import type { FormatOptions } from "@agentblip/core";
import { configPath } from "./paths";

const templatesSchema = z
  .object({
    presence: z.string(),
    workingOne: z.string(),
    workingMany: z.string(),
    waitingSuffix: z.string(),
    activityOne: z.string(),
    activityMany: z.string(),
    waitingOnly: z.string(),
  })
  .partial();

export const configSchema = z.object({
  mode: z.enum(["relay", "slack", "console"]).default("console"),
  relayUrl: z.url().default("https://agentblip.com"),
  deviceToken: z.string().optional(),
  slackToken: z.string().optional(),
  port: z.number().int().min(1).max(65535).default(DEFAULT_DAEMON_PORT),
  granularity: z.enum(["off", "presence", "count", "activity"]).default("count"),
  showProject: z.boolean().default(false),
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
        .object({ enabled: z.boolean().default(true) })
        .default({ enabled: true }),
      codex: z
        .object({
          enabled: z.boolean().default(true),
          sessionsDir: z.string().optional(),
        })
        .default({ enabled: true }),
    })
    .default({ claudeCode: { enabled: true }, codex: { enabled: true } }),
  autoStartDaemon: z.boolean().default(true),
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
        `invalid JSON in ${file} — fix or delete it, then run \`agentblip setup\``,
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
  const relayUrl = process.env.AGENTBLIP_RELAY_URL;
  if (relayUrl) config.relayUrl = relayUrl;
  const token = process.env.AGENTBLIP_TOKEN;
  if (token) config.deviceToken = token;
  const port = process.env.AGENTBLIP_PORT;
  if (port) {
    const n = Number.parseInt(port, 10);
    if (Number.isInteger(n) && n >= 1 && n <= 65535) config.port = n;
  }
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

export function formatOptionsFromConfig(config: Config): FormatOptions {
  return {
    granularity: config.granularity,
    templates: config.templates,
    emoji: config.emoji,
    showProject: config.showProject,
    statusTtlSec: config.statusTtlSec,
    redactPatterns: config.redactPatterns,
  };
}
