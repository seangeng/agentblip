import { loadConfigSafe } from "../lib/config";
import { getState } from "../lib/daemon-client";
import type { DaemonState } from "../lib/daemon-client";
import { bold, dim, formatDuration, renderTable, yellow } from "../lib/ui";

export interface StatusOptions {
  json?: boolean;
}

export async function runStatus(opts: StatusOptions): Promise<void> {
  const config = loadConfigSafe();
  let state: DaemonState;
  try {
    state = await getState(config.port);
  } catch {
    const error = `daemon not running on 127.0.0.1:${config.port} — start it with \`agentblip start --detach\``;
    if (opts.json) console.log(JSON.stringify({ ok: false, error }));
    else {
      console.log(
        `${yellow("daemon not running")} on 127.0.0.1:${config.port} — start it with ${bold("agentblip start --detach")}`,
      );
    }
    process.exitCode = 1;
    return;
  }

  if (opts.json) {
    console.log(JSON.stringify({ ok: true, ...state }, null, 2));
    return;
  }

  if (state.paused) {
    console.log(yellow("paused — status updates suspended (`agentblip resume`)"));
  }
  const formatted = state.formatted;
  if (formatted) {
    const expires = formatted.expirationSec
      ? dim(` (expires in ${formatDuration(formatted.expirationSec * 1000 - Date.now())})`)
      : "";
    console.log(`would set: ${formatted.emoji} ${bold(formatted.text)}${expires}`);
  } else {
    console.log(`would set: ${dim("(clear — no active sessions)")}`);
  }

  console.log("");
  if (state.snapshot.sessions.length === 0) {
    console.log(dim("no live agent sessions"));
    return;
  }
  const rows = state.snapshot.sessions.map((s) => [
    s.source,
    s.state,
    s.activity ?? "—",
    s.project ?? "—",
    `${formatDuration(Date.now() - s.updatedAt)} ago`,
  ]);
  console.log(renderTable(["SOURCE", "STATE", "ACTIVITY", "PROJECT", "UPDATED"], rows));
}
