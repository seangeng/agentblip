import fs from "node:fs";
import {
  areClaudeHooksInstalled,
  claudeSettingsPath,
} from "../adapters/claude-code";
import { codexConfigPath, isCodexNotifyInstalled } from "../adapters/codex";
import { loadConfig, loadConfigSafe } from "../lib/config";
import type { Config } from "../lib/config";
import { getHealth, sinkConfigured } from "../lib/daemon-client";
import { configPath } from "../lib/paths";
import { createSink } from "../sinks";
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

  checks.push(
    ok(
      "status policy",
      cfg.statusPolicy === "respect"
        ? "respect — never overwrites a status agentblip didn't set"
        : "overwrite — displaces an existing status while agents work, restores it after",
    ),
  );

  try {
    const health = await getHealth(cfg.port);
    checks.push(
      ok("daemon", `running (pid ${health.pid}, up ${formatDuration(health.uptimeSec * 1000)})`),
    );
    if (health.lastError) {
      checks.push(fail("sink", health.lastError));
    }
    if (health.ownership?.backedOff) {
      checks.push(
        warn(
          "ownership",
          "standing down — your existing Slack status is untouched; agentblip resumes when it clears",
        ),
      );
    }
  } catch {
    checks.push(
      warn("daemon", `not running on 127.0.0.1:${cfg.port} — \`agentblip start --detach\``),
    );
  }

  // Legacy-read probe: a token without users.profile:read still pushes, but
  // the ownership guard can't see an existing status (legacy blind pushes).
  if (cfg.mode !== "console" && sinkConfigured(cfg)) {
    try {
      const read = await createSink(cfg).getStatus();
      checks.push(
        read.readable
          ? ok("status read", "token can read the current status (ownership guard active)")
          : warn(
              "status read",
              "token lacks users.profile:read — existing statuses can't be detected (legacy mode); run `agentblip setup` to re-pair",
            ),
      );
    } catch (err) {
      checks.push(warn("status read", errorMessage(err)));
    }
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
