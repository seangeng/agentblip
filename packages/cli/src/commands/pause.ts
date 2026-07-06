import { loadConfigSafe } from "../lib/config";
import { pauseDaemon, resumeDaemon } from "../lib/daemon-client";
import { green } from "../lib/ui";

export async function runPause(): Promise<void> {
  const config = loadConfigSafe();
  try {
    await pauseDaemon(config.port);
  } catch {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} — nothing to pause`,
    );
  }
  console.log(green("paused — Slack status cleared; sessions are still tracked"));
}

export async function runResume(): Promise<void> {
  const config = loadConfigSafe();
  try {
    await resumeDaemon(config.port);
  } catch {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} — nothing to resume`,
    );
  }
  console.log(green("resumed — status updates active"));
}
