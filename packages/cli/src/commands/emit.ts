import { eventKindSchema, sessionEventSchema } from "@agentblip/core";
import { loadConfig } from "../lib/config";
import { ensureDaemon, postEvent } from "../lib/daemon-client";
import { green } from "../lib/ui";

export interface EmitOptions {
  source: string;
  sessionId: string;
  kind?: string;
  state?: string;
  activity?: string;
  project?: string;
  agents?: string;
  phase?: string;
}

export async function runEmit(opts: EmitOptions): Promise<void> {
  const config = loadConfig();
  const parsed = sessionEventSchema.safeParse({
    source: opts.source,
    sessionId: opts.sessionId,
    kind: opts.kind ?? opts.state ?? "working",
    activity: opts.activity,
    project: opts.project,
    agents: opts.agents !== undefined ? Number.parseInt(opts.agents, 10) : undefined,
    phase: opts.phase,
    ts: Date.now(),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(
      `invalid event (${detail}) — valid kinds: ${eventKindSchema.options.join(", ")}`,
    );
  }
  if (!(await ensureDaemon(config))) {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} and could not be auto-started — \`agentblip start --detach\``,
    );
  }
  await postEvent(config.port, parsed.data);
  console.log(
    green(`sent ${parsed.data.kind} event for ${parsed.data.source}:${parsed.data.sessionId}`),
  );
}
