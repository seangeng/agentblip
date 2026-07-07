import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pairPollResponseSchema, pairStartResponseSchema } from "@agentblip/core";
import {
  codexConfigPath,
  codexNotifyLine,
  installCodexNotify,
} from "../adapters/codex";
import { claudeSettingsPath, installClaudeHooks } from "../adapters/claude-code";
import { loadConfigSafe, saveConfig } from "../lib/config";
import { isDaemonUp } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
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

function openBrowser(url: string): void {
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
  throw new Error("pairing expired — run `agentblip setup` again");
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
}

export async function runSetup(opts: SetupOptions = {}): Promise<void> {
  console.log(bold("agentblip setup"));
  console.log(dim("your Slack status, synced with your local AI agent sessions\n"));

  const config = loadConfigSafe();
  if (opts.relayUrl) config.relayUrl = resolveRelayUrl(opts.relayUrl);

  const modes = ["relay", "slack", "console"] as const;
  config.mode = await select(
    "How should agentblip update Slack?",
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
          " (add users.profile:read so agentblip never overwrites a status it didn't set)",
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
        label: "respect it (recommended) — agentblip stands down until it clears",
      },
      {
        value: "overwrite",
        label: "overwrite while agents work (restores it after)",
      },
    ],
    Math.max(0, policies.indexOf(config.statusPolicy)),
  );

  console.log("");
  const wantClaude = await confirm(
    `Install Claude Code hooks (${claudeSettingsPath()})?`,
    true,
  );
  config.adapters.claudeCode.enabled = wantClaude;
  if (wantClaude) {
    try {
      const result = installClaudeHooks();
      console.log(
        result.changed
          ? `  ${green("hooks installed")}${result.backupPath ? dim(` (backup: ${result.backupPath})`) : ""}`
          : `  ${dim("already installed")}`,
      );
    } catch (err) {
      console.log(`  ${red(`could not install hooks: ${errorMessage(err)}`)}`);
    }
  }

  const wantCodex = await confirm(
    `Install Codex notify hook (${codexConfigPath()})?`,
    fs.existsSync(path.dirname(codexConfigPath())),
  );
  config.adapters.codex.enabled = wantCodex;
  if (wantCodex) {
    try {
      const result = installCodexNotify();
      if (result === "installed") console.log(`  ${green("notify hook installed")}`);
      else if (result === "already-installed") console.log(`  ${dim("already installed")}`);
      else {
        console.log(
          `  ${yellow("config.toml already sets `notify` — add agentblip manually:")}`,
        );
        console.log(`    ${codexNotifyLine()}`);
      }
    } catch (err) {
      console.log(`  ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
    }
  }

  saveConfig(config);
  console.log("");
  console.log(green(`config saved to ${configPath()}`));
  if (await isDaemonUp(config.port)) {
    // The daemon captures its config (sink, token, granularity) at startup —
    // without a restart the changes above silently never apply.
    console.log(
      yellow(
        `daemon is running with the old config — restart it: ${bold("agentblip stop && agentblip start --detach")}`,
      ),
    );
  }
  console.log("\nnext steps:");
  console.log(`  ${bold("agentblip start --detach")}   run the sync daemon`);
  console.log(`  ${bold("agentblip status")}           see live agent sessions`);
  console.log(`  ${bold("agentblip doctor")}           verify everything`);
}
