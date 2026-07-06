import { runDaemon } from "../daemon";
import { loadConfig } from "../lib/config";
import { isDaemonUp, spawnDetachedDaemon } from "../lib/daemon-client";
import { logFilePath } from "../lib/paths";
import { dim, green } from "../lib/ui";

export interface StartOptions {
  detach?: boolean;
}

export async function runStart(opts: StartOptions): Promise<void> {
  const config = loadConfig();
  if (await isDaemonUp(config.port)) {
    console.log(`daemon already running on 127.0.0.1:${config.port}`);
    return;
  }
  if (opts.detach) {
    const up = await spawnDetachedDaemon(config);
    if (!up) {
      throw new Error(`daemon failed to start — check ${logFilePath()}`);
    }
    console.log(
      `${green(`daemon started on 127.0.0.1:${config.port}`)}${dim(` (log: ${logFilePath()})`)}`,
    );
    return;
  }
  await runDaemon(config);
}
