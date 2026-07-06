import { loadConfigSafe } from "../lib/config";
import { isDaemonUp } from "../lib/daemon-client";
import { isProcessAlive, readPidFile, removePidFile } from "../lib/pidfile";
import { dim, green, sleep, yellow } from "../lib/ui";

const STOP_WAIT_MS = 5000;

export async function runStop(): Promise<void> {
  const pid = readPidFile();
  if (pid === undefined) {
    const config = loadConfigSafe();
    if (await isDaemonUp(config.port)) {
      console.log(
        yellow(
          `a daemon is answering on 127.0.0.1:${config.port} but no pidfile was found — stop it manually`,
        ),
      );
      process.exitCode = 1;
    } else {
      console.log(dim("daemon not running"));
    }
    return;
  }

  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removePidFile();
    console.log(dim("daemon not running (stale pidfile removed)"));
    return;
  }

  const deadline = Date.now() + STOP_WAIT_MS;
  while (Date.now() < deadline) {
    await sleep(100);
    if (!isProcessAlive(pid)) {
      removePidFile();
      console.log(green(`daemon stopped (pid ${pid})`));
      return;
    }
  }
  console.log(yellow(`daemon (pid ${pid}) did not exit within ${STOP_WAIT_MS / 1000}s`));
  process.exitCode = 1;
}
