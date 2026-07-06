import fs from "node:fs";
import {
  areClaudeHooksInstalled,
  claudeSettingsPath,
} from "../adapters/claude-code";
import { codexConfigPath, isCodexNotifyInstalled } from "../adapters/codex";
import { loadConfig, loadConfigSafe } from "../lib/config";
import type { Config } from "../lib/config";
import { getHealth } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
import {
  dim,
  errorMessage,
  formatDuration,
  green,
  red,
  yellow,
} from "../lib/ui";

const HTTP_TIMEOUT_MS = 5000;

interface CheckResult {
  name: string;
  status: "ok" | "warn" | "fail";
  detail: string;
}

const ok = (name: string, detail: string): CheckResult => ({ name, status: "ok", detail });
const warn = (name: string, detail: string): CheckResult => ({ name, status: "warn", detail });
const fail = (name: string, detail: string): CheckResult => ({ name, status: "fail", detail });

export interface DoctorOptions {
  json?: boolean;
}

export async function runDoctor(opts: DoctorOptions): Promise<void> {
  const checks: CheckResult[] = [];

  const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
  checks.push(
    nodeMajor >= 20
      ? ok("node", `v${process.versions.node}`)
      : fail("node", `v${process.versions.node} — agentblip needs node >= 20`),
  );

  let config: Config | undefined;
  const file = configPath();
  if (!fs.existsSync(file)) {
    checks.push(warn("config", `${file} missing — run \`agentblip setup\``));
  } else {
    try {
      config = loadConfig();
      checks.push(ok("config", `mode ${config.mode}, granularity ${config.granularity}`));
    } catch (err) {
      checks.push(fail("config", errorMessage(err)));
    }
  }
  const cfg = config ?? loadConfigSafe();

  if (cfg.mode === "relay") {
    checks.push(
      cfg.deviceToken
        ? ok("device token", "present")
        : fail("device token", "missing — run `agentblip setup`"),
    );
  } else if (cfg.mode === "slack") {
    checks.push(
      cfg.slackToken
        ? ok("slack token", "present")
        : fail("slack token", "missing — run `agentblip setup`"),
    );
  }

  try {
    const health = await getHealth(cfg.port);
    checks.push(
      ok("daemon", `running (pid ${health.pid}, up ${formatDuration(health.uptimeSec * 1000)})`),
    );
  } catch {
    checks.push(
      warn("daemon", `not running on 127.0.0.1:${cfg.port} — \`agentblip start --detach\``),
    );
  }

  if (cfg.mode === "relay") {
    try {
      const res = await fetch(new URL("/api/health", cfg.relayUrl), {
        signal: AbortSignal.timeout(HTTP_TIMEOUT_MS),
      });
      checks.push(
        res.ok
          ? ok("relay", cfg.relayUrl)
          : fail("relay", `${cfg.relayUrl} responded ${res.status}`),
      );
    } catch {
      checks.push(fail("relay", `${cfg.relayUrl} unreachable`));
    }
  }

  checks.push(
    areClaudeHooksInstalled()
      ? ok("claude code hooks", claudeSettingsPath())
      : warn("claude code hooks", "not installed — run `agentblip setup`"),
  );
  checks.push(
    isCodexNotifyInstalled()
      ? ok("codex notify", codexConfigPath())
      : warn("codex notify", "not installed — run `agentblip setup`"),
  );

  const failed = checks.some((check) => check.status === "fail");
  if (opts.json) {
    console.log(JSON.stringify({ ok: !failed, checks }, null, 2));
  } else {
    console.log("agentblip doctor\n");
    const nameWidth = Math.max(...checks.map((check) => check.name.length));
    for (const check of checks) {
      const icon =
        check.status === "ok"
          ? green("✓")
          : check.status === "warn"
            ? yellow("!")
            : red("✗");
      const detail = check.status === "ok" ? dim(check.detail) : check.detail;
      console.log(`  ${icon} ${check.name.padEnd(nameWidth)}  ${detail}`);
    }
  }
  if (failed) process.exitCode = 1;
}
