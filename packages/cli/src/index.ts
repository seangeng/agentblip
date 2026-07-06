import { Command } from "commander";
import pkg from "../package.json";
import { runDoctor } from "./commands/doctor";
import { runEmit } from "./commands/emit";
import { runHook } from "./commands/hook";
import { runPause, runResume } from "./commands/pause";
import { runSetup } from "./commands/setup";
import { runStart } from "./commands/start";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { runUnlink } from "./commands/unlink";
import { errorMessage, red } from "./lib/ui";

function wrap<A extends unknown[]>(
  fn: (...args: A) => Promise<void>,
): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (err) {
      console.error(red(`error: ${errorMessage(err)}`));
      process.exitCode = 1;
    }
  };
}

const program = new Command();

program
  .name("agentblip")
  .description("Your Slack status, synced with your local AI agent sessions.")
  .version(pkg.version);

program
  .command("setup")
  .description("Connect Slack, pick a privacy level, and install agent hooks")
  .action(wrap(runSetup));

program
  .command("start")
  .description("Run the sync daemon (foreground unless --detach)")
  .option("-d, --detach", "run the daemon in the background")
  .action(wrap(runStart));

program
  .command("stop")
  .description("Stop the background daemon (clears your Slack status)")
  .action(wrap(runStop));

program
  .command("status")
  .description("Show live agent sessions and the status agentblip would set")
  .option("--json", "machine-readable output")
  .action(wrap(runStatus));

program
  .command("emit")
  .description("Send a custom session event to the daemon")
  .option("--source <source>", "event source id", "custom")
  .option("--session-id <id>", "session identifier", "manual")
  .option("--kind <kind>", "start | working | waiting | idle | heartbeat | end")
  .option("--state <state>", "alias for --kind (working | waiting | idle)")
  .option("--activity <text>", "short activity label")
  .option("--project <name>", "project name")
  .action(wrap(runEmit));

program
  .command("hook")
  .description("Adapter entrypoint for agent hooks — never fails the host session")
  .argument("<source>", "claude-code | codex | custom")
  .argument("[payload]", "JSON payload (Codex notify passes it as an argument)")
  .action(runHook); // handles its own errors and always exits 0

program
  .command("pause")
  .description("Pause status updates and clear your Slack status")
  .action(wrap(runPause));

program
  .command("resume")
  .description("Resume status updates")
  .action(wrap(runResume));

program
  .command("unlink")
  .description("Revoke this device on the relay and remove the saved token")
  .action(wrap(runUnlink));

program
  .command("doctor")
  .description("Check config, daemon, relay, and hook installs")
  .option("--json", "machine-readable output")
  .action(wrap(runDoctor));

await program.parseAsync(process.argv);
