import fs from "node:fs";
import { SessionStore, formatStatus } from "@agentblip/core";
import type { SessionEvent } from "@agentblip/core";
import { codexSessionsDir, createCodexWatcher } from "../adapters/codex";
import type { CodexWatcher } from "../adapters/codex";
import { formatOptionsFromConfig } from "../lib/config";
import type { Config } from "../lib/config";
import { createDaemonSecret } from "../lib/daemon-auth";
import { stateDir } from "../lib/paths";
import {
  isProcessAlive,
  readPidFile,
  removePidFile,
  writePidFile,
} from "../lib/pidfile";
import { createSink } from "../sinks";
import { Pusher } from "./pusher";
import { createDaemonServer } from "./server";

/** Runs the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(config: Config): Promise<void> {
  const existingPid = readPidFile();
  if (existingPid !== undefined && existingPid !== process.pid && isProcessAlive(existingPid)) {
    throw new Error(`daemon already running (pid ${existingPid}) — \`agentblip stop\` first`);
  }
  fs.mkdirSync(stateDir(), { recursive: true });

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };

  const store = new SessionStore();
  const sink = createSink(config);
  const formatOpts = formatOptionsFromConfig(config);
  const pusher = new Pusher({
    store,
    sink,
    formatOpts,
    debounceMs: config.debounceMs,
    log,
  });

  const hidden = new Set(config.hideProjects ?? []);
  const applyEvent = (event: SessionEvent): void => {
    const clean =
      event.project !== undefined && hidden.has(event.project)
        ? { ...event, project: undefined }
        : event;
    store.apply(clean);
    pusher.notify();
  };

  // Written before listen: the file must exist by the time /health answers,
  // and a stale secret from a failed start is harmless.
  const secret = createDaemonSecret();

  const server = createDaemonServer({
    secret,
    applyEvent,
    getState: () => {
      store.sweep();
      const snapshot = store.snapshot();
      return {
        snapshot,
        formatted: formatStatus(snapshot, formatOpts),
        paused: pusher.paused,
        lastError: pusher.lastError,
      };
    },
    getLastError: () => pusher.lastError,
    pause: () => pusher.pause(),
    resume: () => {
      pusher.resume();
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Only now — after the sink was created and the port is bound — claim the
  // pidfile: a failed or racing start must never clobber the live daemon's.
  writePidFile(process.pid);

  try {
    pusher.start();

    let watcher: CodexWatcher | undefined;
    const sessionsDir = config.adapters.codex.sessionsDir ?? codexSessionsDir();
    if (config.adapters.codex.enabled && fs.existsSync(sessionsDir)) {
      watcher = createCodexWatcher(sessionsDir, applyEvent, log);
      log(`watching codex sessions in ${sessionsDir}`);
    }

    log(
      `agentblip daemon listening on 127.0.0.1:${config.port} (sink: ${sink.name}, granularity: ${config.granularity})`,
    );

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} received — clearing status and shutting down`);
      void (async () => {
        server.close();
        try {
          await watcher?.close();
        } catch {
          // best effort
        }
        try {
          await pusher.shutdown();
        } catch {
          // best effort
        }
        removePidFile();
        process.exit(0);
      })();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
      log(`unhandled rejection: ${String(reason)}`);
    });
  } catch (err) {
    // Startup failed after the pidfile was claimed — clean up, but only our
    // own claim (a concurrent daemon may have re-written it).
    if (readPidFile() === process.pid) removePidFile();
    throw err;
  }
}
