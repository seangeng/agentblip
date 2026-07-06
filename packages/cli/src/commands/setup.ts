import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { pairPollResponseSchema, pairStartResponseSchema } from "@agentblip/core";
import {
  CODEX_NOTIFY_LINE,
  codexConfigPath,
  installCodexNotify,
} from "../adapters/codex";
import { claudeSettingsPath, installClaudeHooks } from "../adapters/claude-code";
import { loadConfigSafe, saveConfig } from "../lib/config";
import { configPath } from "../lib/paths";
import {
  ask,
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

export async function runSetup(): Promise<void> {
  console.log(bold("agentblip setup"));
  console.log(dim("your Slack status, synced with your local AI agent sessions\n"));

  const config = loadConfigSafe();

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
    config.deviceToken = await pairDevice(config.relayUrl);
  } else if (config.mode === "slack") {
    console.log(dim("\n  needs a user token with the users.profile:write scope"));
    const token = await ask("Paste your Slack user token (xoxp-…):", config.slackToken);
    if (!token) throw new Error("no Slack token provided");
    config.slackToken = token;
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
        console.log(`    ${CODEX_NOTIFY_LINE}`);
      }
    } catch (err) {
      console.log(`  ${red(`could not update config.toml: ${errorMessage(err)}`)}`);
    }
  }

  saveConfig(config);
  console.log("");
  console.log(green(`config saved to ${configPath()}`));
  console.log("\nnext steps:");
  console.log(`  ${bold("agentblip start --detach")}   run the sync daemon`);
  console.log(`  ${bold("agentblip status")}           see live agent sessions`);
  console.log(`  ${bold("agentblip doctor")}           verify everything`);
}
