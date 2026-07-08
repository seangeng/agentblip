import { sessionEventSchema } from "@agentblip/core";
import { loadConfig } from "../lib/config";
import { ensureDaemon, postEvent } from "../lib/daemon-client";
import { dim, green } from "../lib/ui";

export interface ReportOptions {
  id: string;
  source: string;
  agents?: string;
  phase?: string;
  activity?: string;
  project?: string;
  done?: boolean;
}

/**
 * Orchestrator reporter: an ultracode workflow, a CI fan-out, or any script
 * that spawns concurrent agents calls this so agentblip's "N agents working"
 * reflects the real fleet — something hooks can't see. `--done` clears it.
 *
 *   agentblip report --agents 5 --phase "verify" --activity "reviewing findings"
 *   agentblip report --done
 */
export async function runReport(opts: ReportOptions): Promise<void> {
  const config = loadConfig();
  const agents =
    opts.agents !== undefined ? Number.parseInt(opts.agents, 10) : undefined;

  const parsed = sessionEventSchema.safeParse({
    source: opts.source,
    sessionId: opts.id,
    kind: opts.done ? "end" : "working",
    activity: opts.activity,
    project: opts.project,
    agents,
    phase: opts.phase,
    ts: Date.now(),
  });
  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((i) => `${i.path.join(".")}: ${i.message}`)
      .join("; ");
    throw new Error(`invalid report (${detail})`);
  }

  if (!(await ensureDaemon(config))) {
    throw new Error(
      `daemon not running on 127.0.0.1:${config.port} and could not be auto-started — \`agentblip start --detach\``,
    );
  }
  await postEvent(config.port, parsed.data);

  if (opts.done) {
    console.log(green(`cleared ${opts.source}:${opts.id}`));
    return;
  }
  const n = agents ?? 1;
  const bits = [`${n} agent${n === 1 ? "" : "s"}`];
  if (opts.phase) bits.push(opts.phase);
  if (opts.activity) bits.push(opts.activity);
  console.log(`${green("reported")} ${bits.join(" · ")} ${dim(`(${opts.source}:${opts.id})`)}`);
}
