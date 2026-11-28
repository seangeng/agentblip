import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pairPollResponseSchema, pairStartResponseSchema } from "@workmesh/core";
import {
  codexConfigPath,
  codexHooksPath,
  codexNotifyLine,
  installCodexHooks,
  installCodexNotify,
} from "../adapters/codex";
import { claudeSettingsPath, installClaudeHooks } from "../adapters/claude-code";
import {
  antigravityMcpConfigPath,
  claudeJsonPath,
  geminiSettingsPath,
  installAntigravityMcp,
  installClaudeMcp,
  installCodexMcp,
  installGeminiMcp,
  installOpenCodeMcp,
  openCodeConfigPath,
} from "../adapters/mcp-install";
import type { McpInstallReport } from "../adapters/mcp-install";
import { hubShareLevel, loadConfigSafe, saveConfig } from "../lib/config";
import type { Config } from "../lib/config";
import { isDaemonUp } from "../lib/daemon-client";
import { stableNodePath, versionManagedNode } from "../lib/node-path";
import { claudeConfigDir, codexHome, configPath } from "../lib/paths";
import { resolveDir } from "./hub";
import { runServiceInstall } from "./service";
import { markSetup } from "../lib/update-state";
import pkg from "../../package.json";
import {
  ask,
  askSecret,
  bold,
  confirm,
  cyan,
  dim,
  errorMessage,
  green,
  red,
  select,
  sleep,
  spinner,
  yellow,
} from "../lib/ui";

const POLL_INTERVAL_MS = 2000;
const HTTP_TIMEOUT_MS = 10_000;

export function openBrowser(url: string): void {
  let cmd: string;
  let args: string[];
  if (process.platform === "darwin") {
    cmd = "open";
    args = [url];
  } else if (process.platform === "win32") {
    cmd = "cmd";
    args = ["/c", "start", "", url];
  } else {
    cmd = "xdg-open";
    args = [url];
  }
  try {
    const child = spawn(cmd, args, { stdio: "ignore", detached: true });
    child.on("error", () => {});
    child.unref();
  } catch {
    // best effort — the verify URL is printed either way
  }
}

async function pairDevice(relayUrl: string): Promise<string> {
  const startRes = await fetch(new URL("/api/pair/start", relayUrl), {
    method: "POST",
    signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
  });
  if (!startRes.ok) {
    throw new Error(`relay ${relayUrl} responded ${startRes.status} — is it reachable?`);
  }
  const pair = pairStartResponseSchema.parse(await startRes.json());

  console.log("");
  console.log(`  pairing code: ${bold(pair.code)}`);
  console.log(`  confirm it in your browser: ${cyan(pair.verifyUrl)}`);
  console.log("");
  openBrowser(pair.verifyUrl);

  const spin = spinner("waiting for you to connect Slack…");
  const deadline = Date.now() + pair.expiresInSec * 1000;
  try {
    while (Date.now() < deadline) {
      await sleep(POLL_INTERVAL_MS);
      let res: Response;
      try {
        res = await fetch(new URL("/api/pair/poll", relayUrl), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            deviceId: pair.deviceId,
            pollSecret: pair.pollSecret,
          }),
          signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
        });
      } catch {
        continue; // transient network error — keep polling
      }
      if (!res.ok) continue;
      const poll = pairPollResponseSchema.parse(await res.json());
      if (poll.status === "complete" && poll.deviceToken) {
        spin.stop(
          green(`linked to Slack${poll.team ? ` workspace "${poll.team}"` : ""}`),
        );
        return poll.deviceToken;
      }
      if (poll.status === "expired") break;
    }
  } finally {
    spin.stop();
  }
  throw new Error("pairing expired — run `workmesh setup` again");
}

/** Validates a relay URL (prompt or --relay-url flag). Throws on garbage. */
export function resolveRelayUrl(input: string): string {
  const trimmed = input.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(`invalid relay URL: ${trimmed || "(empty)"}`);
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`invalid relay URL: ${trimmed} — must be http(s)`);
  }
  return trimmed;
}

export interface SetupOptions {
  relayUrl?: string;
  /** Install or refresh agent hooks only: no prompts, no pairing, config untouched. */
  hooksOnly?: boolean;
  /** Claude Code config dir to hook (default $CLAUDE_CONFIG_DIR, else ~/.claude). */
  claudeDir?: string;
  /** `--codex` / `--no-codex`; undefined: only when a Codex install is found. */
  codex?: boolean;
  /** Register the `workmesh` MCP server with Claude Code and Codex (default true; `--no-mcp` skips it). */
  mcp?: boolean;
  /** Run the daemon under launchd / systemd (default true; `--no-service` skips it). SPEC §24. */
  service?: boolean;
  /** Linux: turn lingering on (default true; `--no-linger`), so the daemon survives logout. */
  linger?: boolean;
  /** Install the asyncRewake Stop hook that wakes idle sessions for messages (default true; `--no-wake`). SPEC §31. */
  wake?: boolean;
}

/** `--claude-dir`, else $CLAUDE_CONFIG_DIR, else ~/.claude. */
export function resolveClaudeDir(flag?: string): string {
  return flag ? resolveDir(flag) : claudeConfigDir();
}

/** True when this machine has Codex: $CODEX_HOME is set or ~/.codex exists. */
export function codexDetected(): boolean {
  return Boolean(process.env.CODEX_HOME) || fs.existsSync(codexHome());
}

/**
 * Whether to touch Codex, and the line that says why. An explicit flag wins;
 * without one, only a Codex install found on this machine is hooked.
 */
export function codexDecision(flag: boolean | undefined): { install: boolean; why: string } {
  if (flag === false) return { install: false, why: "skipped (--no-codex)" };
  if (flag === true) return { install: true, why: `installing in ${codexHome()} (--codex)` };
  if (codexDetected()) {
    return { install: true, why: `found ${codexHome()}, installing there (pass --no-codex to leave Codex alone)` };
  }
  return { install: false, why: `no Codex install found (${codexHome()}), skipped (pass --codex to install anyway)` };
}

/**
 * A note when the hooks will pin a Node that a version manager may remove: the path setup writes (lib/node-path.ts)
 * is still inside one version's tree (nvm, asdf, Volta without a stable name). Homebrew's isn't: it gets
 * `/opt/homebrew/bin/node`.
 */
export function nodePathWarning(node = stableNodePath()): string | undefined {
  if (!versionManagedNode(node)) return undefined;
  return (
    `hooks run ${node}, a version-managed Node: after you remove that version, every hook fails until you ` +
    "install Workmesh under your new Node and run `workmesh setup --hooks-only` (`workmesh doctor` checks for this)"
  );
}

/** What `hub connect` will share, or does share: printed by setup so nobody has to guess. */
export function sharingSummary(config: Pick<Config, "hub">): string {
  if (!config.hub) {
    return (
      "hub: not connected. `workmesh hub connect <url>` shares conversation by default (your prompts and the agent's " +
      "replies, redacted) once a session touches a shared repo; add `--share metadata` for metadata only"
    );
  }
  const level = hubShareLevel(config.hub);
  const other = level === "conversation" ? "metadata" : "conversation";
  return `hub: sharing ${level} with ${config.hub.project.name}; switch with \`workmesh hub share ${other}\``;
}

function mcpLine(r: McpInstallReport): string {
  switch (r.result) {
    case "installed":
    case "updated":
      return `${green(r.result === "installed" ? "MCP server registered" : "MCP server repointed")}${r.via === "claude-cli" ? dim(" (claude mcp add, user scope)") : dim(` (${r.path})`)}${r.backupPath ? dim(` (backup: ${r.backupPath})`) : ""}`;
    case "already-installed":
      return dim("MCP server already registered");
    case "manual":
      return yellow(`MCP server not registered: ${r.detail ?? "left as is"}`);
  }
}

/**
 * Registers `workmesh mcp` with Claude Code (user scope). `claudeBin: null` merges the file without the CLI. A
 * `--claude-dir` other than the one Claude Code would pick up from this environment is always a file merge into
 * that profile's `.claude.json`, so the `claude` CLI can't register it in the wrong profile.
 */
export function setupClaudeMcp(opts: { claudeBin?: string | null; claudeDir?: string } = {}): void {
  const dir = opts.claudeDir ? resolveClaudeDir(opts.claudeDir) : undefined;
  const elsewhere = dir !== undefined && dir !== claudeConfigDir();
  try {
    const report = installClaudeMcp({ file: claudeJsonPath(dir), claudeBin: elsewhere ? null : opts.claudeBin });
    console.log(`  claude code mcp: ${mcpLine(report)}`);
  } catch (err) {
    console.log(`  claude code mcp: ${red(`could not register: ${errorMessage(err)}`)}`);
  }
}

/** Registers `workmesh mcp` in Codex's config.toml. */
export function setupCodexMcp(): void {
  try {
    console.log(`  codex mcp: ${mcpLine(installCodexMcp())}`);
  } catch (err) {
    console.log(`  codex mcp: ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
  }
}

/** Registers `workmesh mcp` with detected Antigravity, OpenCode, and Gemini CLI installs. */
export function setupExtraMcps(): void {
  const agyPath = antigravityMcpConfigPath();
  if (fs.existsSync(path.dirname(agyPath))) {
    try {
      console.log(`  antigravity mcp: ${mcpLine(installAntigravityMcp(agyPath))}`);
    } catch (err) {
      console.log(`  antigravity mcp: ${red(`could not update mcp_config.json: ${errorMessage(err)}`)}`);
    }
  }
  const ocPath = openCodeConfigPath();
  if (fs.existsSync(path.dirname(ocPath))) {
    try {
      console.log(`  opencode mcp: ${mcpLine(installOpenCodeMcp(ocPath))}`);
    } catch (err) {
      console.log(`  opencode mcp: ${red(`could not update opencode.json: ${errorMessage(err)}`)}`);
    }
  }
  const gemPath = geminiSettingsPath();
  if (fs.existsSync(gemPath)) {
    try {
      console.log(`  gemini mcp: ${mcpLine(installGeminiMcp(gemPath))}`);
    } catch (err) {
      console.log(`  gemini mcp: ${red(`could not update settings.json: ${errorMessage(err)}`)}`);
    }
  }
}

function installCodex(opts: { mcp?: boolean } = {}): void {
  try {
    const result = installCodexHooks();
    console.log(
      `  codex: ${result.changed ? green(`hooks installed in ${result.hooksPath}`) : dim("hooks already installed")}` +
        (result.backupPath ? dim(` (backup: ${result.backupPath})`) : ""),
    );
    if (result.changed) {
      console.log(`  ${yellow("open Codex and run /hooks to trust Workmesh's hooks (Codex skips untrusted hooks)")}`);
    }
  } catch (err) {
    console.log(`  codex: ${red(`could not update hooks.json: ${errorMessage(err)}`)}`);
  }
  try {
    const notify = installCodexNotify();
    if (notify === "manual") {
      console.log(`  codex notify: ${dim("config.toml already sets notify; left as is (fallback only)")}`);
    } else {
      console.log(`  codex notify: ${notify === "installed" ? green(`installed in ${codexConfigPath()}`) : dim("already installed")}`);
    }
  } catch (err) {
    console.log(`  codex notify: ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
  }
  if (opts.mcp !== false) setupCodexMcp();
}

/** `workmesh setup --hooks-only`: (re)install Claude Code hooks, and Codex's when found or asked for. */
export function installHooksOnly(
  opts: Pick<SetupOptions, "claudeDir" | "codex" | "mcp" | "wake"> & { claudeBin?: string | null; title?: string } = {},
): void {
  console.log(bold(opts.title ?? "workmesh setup --hooks-only"));
  const settingsPath = claudeSettingsPath(resolveClaudeDir(opts.claudeDir));
  try {
    const result = installClaudeHooks(settingsPath, { wake: opts.wake });
    console.log(
      `  claude code: ${result.changed ? green(`hooks installed in ${settingsPath}`) : dim(`already installed in ${settingsPath}`)}` +
        (result.backupPath ? dim(` (backup: ${result.backupPath})`) : ""),
    );
  } catch (err) {
    console.log(`  claude code: ${red(`could not install hooks in ${settingsPath}: ${errorMessage(err)}`)}`);
  }
  if (opts.mcp !== false) setupClaudeMcp({ claudeBin: opts.claudeBin, claudeDir: opts.claudeDir });
  if (opts.claudeDir) {
    console.log(
      dim(
        "  the daemon reads sessions and workflows from $CLAUDE_CONFIG_DIR (the service setup installs, and a daemon a " +
          "hook starts, get it); for a daemon started elsewhere set adapters.claudeCode.configDir in config.json",
      ),
    );
  }
  const codex = codexDecision(opts.codex);
  if (codex.install) {
    console.log(`  codex: ${codex.why}`);
    installCodex({ mcp: opts.mcp });
  } else {
    console.log(`  codex: ${dim(codex.why)}`);
  }
  if (opts.mcp !== false) setupExtraMcps();
  const warning = nodePathWarning();
  if (warning) console.log(`  ${yellow(`note: ${warning}`)}`);
  console.log(`  ${sharingSummary(loadConfigSafe())}`);
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  if (opts.hooksOnly) {
    installHooksOnly(opts);
    // The service carries CLAUDE_CONFIG_DIR into the daemon's environment: make it the profile just hooked.
    if (opts.claudeDir) process.env.CLAUDE_CONFIG_DIR = resolveClaudeDir(opts.claudeDir);
    if (opts.service !== false) await runServiceInstall({ linger: opts.linger });
    markSetup(pkg.version);
    return;
  }
  console.log(bold("workmesh setup"));
  console.log(dim("your Slack status, synced with your local AI agent sessions\n"));

  const config = loadConfigSafe();
  if (opts.relayUrl) config.relayUrl = resolveRelayUrl(opts.relayUrl);

  const modes = ["relay", "slack", "console"] as const;
  config.mode = await select(
    "How should Workmesh update Slack?",
    [
      {
        value: "relay",
        label: `relay — pair with ${config.relayUrl} (recommended, no Slack app of your own)`,
      },
      { value: "slack", label: "slack — bring your own Slack user token, no server" },
      { value: "console", label: "console — dry run, just print what would be set" },
    ],
    Math.max(0, modes.indexOf(config.mode)),
  );

  if (config.mode === "relay") {
    if (!opts.relayUrl) {
      // Self-hosters point this at their own Worker (docs/SELF_HOSTING.md).
      config.relayUrl = resolveRelayUrl(
        await ask("Relay URL (self-hosters: your own Worker):", config.relayUrl),
      );
    }
    config.deviceToken = await pairDevice(config.relayUrl);
  } else if (config.mode === "slack") {
    console.log(
      dim(
        "\n  needs a user token with users.profile:write scopes" +
          " (add users.profile:read so Workmesh never overwrites a status it didn't set)",
      ),
    );
    const keepHint = config.slackToken ? " (enter keeps the saved token)" : "";
    const token = await askSecret(`Paste your Slack user token (xoxp-…)${keepHint}:`);
    if (token) config.slackToken = token;
    if (!config.slackToken) throw new Error("no Slack token provided");
  }

  const granularities = ["presence", "count", "activity", "off"] as const;
  config.granularity = await select(
    "\nHow much should your status reveal?",
    [
      { value: "presence", label: 'presence — "heads down with agents"' },
      { value: "count", label: 'count — "3 agents working"' },
      { value: "activity", label: 'activity — "claude: editing format.ts"' },
      { value: "off", label: "off — never set a status" },
    ],
    Math.max(0, granularities.indexOf(config.granularity)),
  );

  const policies = ["respect", "overwrite"] as const;
  config.statusPolicy = await select(
    "\nIf your Slack status is already set by you or another app:",
    [
      {
        value: "respect",
        label: "respect it (recommended) — Workmesh stands down until it clears",
      },
      {
        value: "overwrite",
        label: "overwrite while agents work (restores it after)",
      },
    ],
    Math.max(0, policies.indexOf(config.statusPolicy)),
  );

  console.log("");
  const claudeDir = resolveClaudeDir(opts.claudeDir);
  const settingsPath = claudeSettingsPath(claudeDir);
  const wantClaude = await confirm(`Install Claude Code hooks (${settingsPath})?`, true);
  config.adapters.claudeCode.enabled = wantClaude;
  // A dir given on the command line is remembered, so a daemon started from
  // any terminal watches the same profile the hooks were installed in.
  if (opts.claudeDir) config.adapters.claudeCode.configDir = claudeDir;
  if (wantClaude) {
    try {
      const result = installClaudeHooks(settingsPath, { wake: opts.wake });
      console.log(
        result.changed
          ? `  ${green("hooks installed")}${result.backupPath ? dim(` (backup: ${result.backupPath})`) : ""}`
          : `  ${dim("already installed")}`,
      );
    } catch (err) {
      console.log(`  ${red(`could not install hooks: ${errorMessage(err)}`)}`);
    }
    if (opts.mcp !== false) setupClaudeMcp({ claudeDir: opts.claudeDir });
  }

  const wantCodex =
    opts.codex ??
    (await confirm(
      `Install Codex hooks (${codexHooksPath()}, plus the notify fallback in ${codexConfigPath()})?`,
      codexDetected(),
    ));
  config.adapters.codex.enabled = wantCodex;
  if (wantCodex) {
    try {
      const result = installCodexHooks();
      console.log(
        result.changed
          ? `  ${green("codex hooks installed")}${result.backupPath ? dim(` (backup: ${result.backupPath})`) : ""}`
          : `  ${dim("codex hooks already installed")}`,
      );
      if (result.changed) {
        console.log(
          `  ${yellow("Codex runs a new hook only after you trust it: open Codex and run /hooks to review and trust Workmesh's")}`,
        );
      }
    } catch (err) {
      console.log(`  ${red(`could not update hooks.json: ${errorMessage(err)}`)}`);
    }
    try {
      const result = installCodexNotify();
      if (result === "installed") console.log(`  ${green("notify hook installed")}`);
      else if (result === "already-installed") console.log(`  ${dim("already installed")}`);
      else {
        console.log(
          `  ${yellow("config.toml already sets `notify` — add Workmesh manually:")}`,
        );
        console.log(`    ${codexNotifyLine()}`);
      }
    } catch (err) {
      console.log(`  ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
    }
    if (opts.mcp !== false) setupCodexMcp();
  }

  saveConfig(config);
  markSetup(pkg.version);
  console.log("");
  console.log(green(`config saved to ${configPath()}`));
  const warning = nodePathWarning();
  if (warning) console.log(yellow(`note: ${warning}`));
  console.log(sharingSummary(config));
  // The service (re)starts the daemon, so it runs with the config just saved.
  if (opts.service !== false && (await runServiceInstall({ linger: opts.linger }))) {
    console.log("\nnext steps:");
    console.log(`  ${bold("workmesh status")}           see live agent sessions`);
    console.log(`  ${bold("workmesh doctor")}           verify everything`);
    return;
  }
  if (await isDaemonUp(config.port)) {
    // The daemon captures its config (sink, token, granularity) at startup —
    // without a restart the changes above silently never apply.
    console.log(
      yellow(
        `daemon is running with the old config — restart it: ${bold("workmesh restart")}`,
      ),
    );
  }
  console.log("\nnext steps:");
  console.log(`  ${bold("workmesh start --detach")}   run the sync daemon`);
  console.log(`  ${bold("workmesh status")}           see live agent sessions`);
  console.log(`  ${bold("workmesh doctor")}           verify everything`);
}
