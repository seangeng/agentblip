import { Command, Option } from "commander";
import pkg from "../package.json";
import {
  runApprovals,
  runClaim,
  runClaims,
  runGates,
  runHandoff,
  runHandoffs,
  runReview,
  runReviewPolicy,
  runReviews,
  runInbox,
  runLease,
  runLeases,
  runMcp,
  runNote,
  runNotes,
  runSend,
  runUnlease,
  runWhoami,
  runAsk,
  runRemember,
  runRecall,
  runForget,
  runMemories,
} from "./commands/coord";
import { runDoctor } from "./commands/doctor";
import { runEmit } from "./commands/emit";
import { runHook } from "./commands/hook";
import { runInit } from "./commands/init";
import { runHandoffPolicy, runRequestRule, runRoots } from "./commands/roots";
import { runCapacity, runPool, runPoolRule, runRoute } from "./commands/mesh";
import { runWake, runWakeWait } from "./commands/wake";
import {
  EXAMPLE_HUB_URL,
  runHubConnect,
  runHubDisconnect,
  runHubExclude,
  runHubInclude,
  runHubShare,
  runHubStatus,
  runHubSticky,
} from "./commands/hub";
import { runPause, runResume } from "./commands/pause";
import { runReport } from "./commands/report";
import { runSetup } from "./commands/setup";
import { runServiceInstall, runServiceStatus, runServiceUninstall } from "./commands/service";
import { runRestart, runStart } from "./commands/start";
import { runStatus } from "./commands/status";
import { runStop } from "./commands/stop";
import { runUninstall } from "./commands/uninstall";
import { runUnlink } from "./commands/unlink";
import { runUpdate } from "./commands/update";
import { migrateLegacyDirs } from "./lib/migrate";
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

// Carry config and state over from the pre-rename agentblip directories once.
migrateLegacyDirs();

const program = new Command();

program
  .name("workmesh")
  .description("Your coding agents, live on your team's board and in your Slack status.")
  .version(pkg.version);

program
  .command("init")
  .description("Set this machine up for a team hub in one go: hooks, MCP tools, the daemon, and pairing (safe to run again)")
  .argument("<hub-url>", `the team's hub, e.g. ${EXAMPLE_HUB_URL}`)
  .option("--share <level>", "conversation | metadata (asked when omitted in a terminal)")
  .option("--codex", "install Codex hooks even when no Codex install is found")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-open", "print the approve link without opening a browser")
  .option("--machine <name>", "name this machine on the board (default: hostname)")
  .option("--claude-dir <path>", "Claude Code config dir to hook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--no-mcp", "don't register the workmesh MCP server")
  .option("--no-service", "run the daemon in the background, not under launchd / systemd")
  .option("--no-linger", "Linux: don't turn on lingering (the daemon then stops when you log out)")
  .option("--no-wake", "don't install the hook that wakes idle sessions for messages")
  .option("--repair", "pair again even if this machine is already paired with the hub")
  .action(wrap((url: string, opts: Parameters<typeof runInit>[1]) => runInit(url, opts)));

program
  .command("update")
  .description("Install the newest Workmesh the way it was installed, refresh hooks, MCP and the daemon, roll back if it fails (safe to run again)")
  .option("--check", "only say what's installed and what's out")
  .option("--json", "with --check: machine-readable output")
  .option("--to <version>", "a specific version instead of the latest")
  .option("--auto <on|off>", "let the daemon install releases on its own, at most daily (patch releases unless --minor)")
  .option("--minor", "with --auto on: minor releases too")
  .addOption(new Option("--auto-run", "started by the daemon").hideHelp())
  .addOption(new Option("--finish", "run by the newly installed version").hideHelp())
  .addOption(new Option("--from <version>", "with --finish: the previous version").hideHelp())
  .action(wrap((opts: Parameters<typeof runUpdate>[0]) => runUpdate(opts)));

program
  .command("setup")
  .description("Connect Slack, pick a privacy level, and install agent hooks")
  .option(
    "--relay-url <url>",
    "relay to pair with (self-hosters: your own Worker URL)",
  )
  .option("--hooks-only", "only install or refresh agent hooks and the MCP server (no prompts, config untouched)")
  .option("--claude-dir <path>", "Claude Code config dir to hook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--codex", "install Codex hooks even when no Codex install is found")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-mcp", "don't register the workmesh MCP server with Claude Code and Codex")
  .option("--no-service", "don't run the daemon under launchd / systemd")
  .option("--no-linger", "Linux: don't turn on lingering (the daemon then stops when you log out)")
  .option("--no-wake", "don't install the hook that wakes idle sessions for messages")
  .action(wrap(runSetup));

const service = program
  .command("service")
  .description("Run the daemon under launchd (macOS) or systemd --user (Linux), so it comes back after a crash, kill or reboot");

service
  .command("install")
  .description("Install (or refresh) the daemon service and start it; stops a daemon running outside it first")
  .option("--no-linger", "Linux: don't turn on lingering (the daemon then stops when you log out)")
  .action(wrap(async (opts: { linger?: boolean }) => {
    if (!(await runServiceInstall({ linger: opts.linger }))) process.exitCode = 1;
  }));

service
  .command("uninstall")
  .description("Stop the daemon service and remove it (hooks start a daemon as before)")
  .action(wrap(runServiceUninstall));

service
  .command("status")
  .description("Whether the daemon service is installed, loaded and running")
  .option("--json", "machine-readable output")
  .action(wrap(runServiceStatus));

program
  .command("uninstall")
  .description("Remove Workmesh's hooks and MCP server from Claude Code and Codex, and its daemon service, keeping every other hook (backs up each file)")
  .option("--claude-dir <path>", "Claude Code config dir to unhook (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .option("--no-codex", "leave Codex's files alone")
  .option("--no-service", "keep the daemon service (launchd / systemd) installed")
  .action(wrap(runUninstall));

program
  .command("start")
  .description("Run the sync daemon (foreground unless --detach)")
  .option("-d, --detach", "run the daemon in the background")
  .action(wrap(runStart));

program
  .command("stop")
  .description("Stop the background daemon and wait for it to exit (clears your Slack status)")
  .action(wrap(async () => {
    await runStop();
  }));

program
  .command("restart")
  .description("Stop the daemon, wait for it to exit, and start it again in the background")
  .action(wrap(runRestart));

program
  .command("status")
  .description("Show live agent sessions and the status Workmesh would set")
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
  .option("--agents <n>", "concurrent agents this session represents")
  .option("--phase <label>", "orchestrator phase label")
  .action(wrap(runEmit));

program
  .command("report")
  .description("Report a fan-out of concurrent agents (workflows, CI) so \"N agents working\" is accurate")
  .option("--id <id>", "run/session id (one per concurrent fleet)", "run")
  .option("--source <source>", "event source id", "workflow")
  .option("--agents <n>", "number of concurrent agents", "1")
  .option("--phase <label>", "current phase, e.g. \"verify\" or \"2/4\"")
  .option("--activity <text>", "short activity label")
  .option("--project <name>", "project name")
  .option("--done", "clear this report (the fleet finished)")
  .action(wrap(runReport));

program
  .command("hook")
  .description("Adapter entrypoint for agent hooks — never fails the host session")
  .argument("<source>", "claude-code | codex-hooks | codex (notify) | custom")
  .argument("[payload]", "JSON payload (Codex notify passes it as an argument)")
  .action(runHook); // handles its own errors and always exits 0

program
  .command("pause")
  .description("Pause status updates and clear your Slack status")
  .option("--for <length>", "snooze, then resume on its own: 30m | 1h | tomorrow (9 AM)")
  .action(wrap(runPause));

program
  .command("resume")
  .description("Resume status updates")
  .action(wrap(runResume));

program
  .command("unlink")
  .description("Revoke this device on the relay and remove the saved token")
  .action(wrap(runUnlink));

const hub = program
  .command("hub")
  .description("Show your agent sessions on a team hub (the Workmesh board), from repos you share: metadata, or the conversation too");

hub
  .command("connect")
  .description("Pair this machine with a hub (device code, approved in the browser)")
  .argument("<url>", `hub URL, e.g. ${EXAMPLE_HUB_URL}`)
  .option("--no-open", "print the approve link without opening a browser")
  .option("--machine <name>", "name this machine on the board (default: hostname)")
  .option("--share <level>", "conversation | metadata (asked when omitted in a terminal)")
  .action(wrap(runHubConnect));

hub
  .command("share")
  .description("Show or set what this machine shares: conversation (prompts, agent text, redacted) or metadata")
  .argument("[level]", "conversation | metadata")
  .action(wrap(runHubShare));

hub
  .command("sticky")
  .description("Show or set whether a session stays shared after it touches a shared repo (on, the default) or is shared turn by turn (off)")
  .argument("[value]", "on | off")
  .action(wrap(runHubSticky));

hub
  .command("status")
  .description("Pairing, project, last send, queued and dropped events, shared sessions")
  .option("--json", "machine-readable output")
  .action(wrap(runHubStatus));

hub
  .command("disconnect")
  .description("Stop forwarding and remove the hub token from this machine")
  .action(wrap(runHubDisconnect));

hub
  .command("include")
  .description("Also share sessions and files under a directory")
  .argument("<dir>", "directory (absolute, relative, or ~/…)")
  .action(wrap(runHubInclude));

hub
  .command("exclude")
  .description("Never share anything under a directory, whatever its git remote")
  .argument("<dir>", "directory (absolute, relative, or ~/…)")
  .action(wrap(runHubExclude));

// v1 Coordinate (SPEC §21, §23): through the daemon, which holds the hub token. Inside an agent session (its Bash),
// these speak for that session; at a terminal, for you.
program
  .command("leases")
  .description("Active file leases on your team: who holds which paths, for how long")
  .option("--repo <owner/name>", "only this repo")
  .option("--json", "machine-readable output")
  .action(wrap(runLeases));

program
  .command("lease")
  .description("Lease files, directories or globs for this agent session (edits by other sessions are refused)")
  .argument("<paths...>", "paths or globs, absolute or relative to this directory")
  .option("--reason <text>", "what you're doing, shown to teammates")
  .option("--minutes <n>", "how long (1-240, default 30)")
  .option("--repo <owner/name>", "the repo, when the paths are repo-relative")
  .option("--json", "machine-readable output")
  .action(wrap(runLease));

program
  .command("unlease")
  .description("Release this agent session's leases (the paths given, or all of them)")
  .argument("[paths...]", "paths you leased")
  .option("--id <leaseId>", "one lease")
  .option("--repo <owner/name>", "only this repo")
  .option("--json", "machine-readable output")
  .action(wrap(runUnlease));

program
  .command("claims")
  .description("Linear issues claimed by your team's agents")
  .option("--json", "machine-readable output")
  .action(wrap(runClaims));

program
  .command("claim")
  .description("Claim a Linear issue for this agent session (--release to let it go)")
  .argument("<issue>", "e.g. B3-123")
  .option("--note <text>", "what you're doing on it")
  .option("--release", "release the claim instead")
  .option("--json", "machine-readable output")
  .action(wrap(runClaim));

program
  .command("send")
  .description("Send a message. Teammates review it before delivery unless they trust the sender.")
  .argument("<to>", "a person (display name or email), an agent's session name, or a hub session key")
  .argument("<text...>", "the message")
  .option("--kind <kind>", "person | agent | session, when <to> is ambiguous")
  .option("--thread <id>", "reply in a thread")
  .option("--json", "machine-readable output")
  .action(wrap(runSend));

program
  .command("inbox")
  .description("Messages waiting for this machine's agents (or, inside an agent session, for that session); deliver or drop one held for you")
  .argument("[action]", "deliver | drop: answer a message held for you")
  .argument("[id]", "the held message's id, or the end of it")
  .option("--held", "list the messages held for you, with their ids")
  .option("--json", "machine-readable output")
  .action(wrap(runInbox));

program
  .command("note")
  .description("Leave a note every teammate's agent can read")
  .argument("<text...>", "the note")
  .option("--tag <tag...>", "one-word tags")
  .option("--json", "machine-readable output")
  .action(wrap(runNote));

program
  .command("notes")
  .description("Your team's newest shared notes")
  .option("--tag <tag>", "only this tag")
  .option("--json", "machine-readable output")
  .action(wrap(runNotes));

program
  .command("ask")
  .description("Ask the team board about teammates' agents, in plain words (read-only)")
  .argument("<question...>", "e.g. what is An's agent doing on B3-7167?")
  .option("--json", "machine-readable output")
  .action(wrap(runAsk));

// v3 Memory (SPEC §36): the team's shared knowledge base. A `remember` or a `forget` is a proposal, from a terminal and
// from an agent's shell alike; a person accepts it on the board (§35).
program
  .command("remember")
  .description("Write down a decision, convention, gotcha, rule or fact for your team's agents (a person accepts it on the board)")
  .argument("<title...>", "the memory in one line")
  .option("--kind <kind>", "decision | convention | gotcha | rule | fact")
  .option("--body <text>", "why, how, where it bit (up to 2,000 characters)")
  .option("--project", "team-wide, not just this repo")
  .option("--repo [owner/name]", "this repo (the default inside a shared one), or the one named")
  .option("--path <paths...>", "only these files, directories or globs (relative to this directory)")
  .option("--issue <ids...>", "linked Linear issues, e.g. B3-123")
  .option("--pr <prs...>", "linked PRs: links, owner/name#N, or #N in this repo")
  .option("--tag <tags...>", "one-word tags")
  .option("--supersedes <id>", "a memory this one replaces, e.g. m12")
  .option("--json", "machine-readable output")
  .action(wrap(runRemember));

program
  .command("recall")
  .description("Search your team's accepted memories (this repo's first)")
  .argument("<words...>", "what to look for")
  .option("--kind <kinds...>", "only these kinds")
  .option("--limit <n>", "how many (1-20, default 8)")
  .option("--repo <owner/name>", "rank this repo first")
  .option("--json", "machine-readable output")
  .action(wrap(runRecall));

program
  .command("forget")
  .description("Propose retiring a team memory that no longer holds (a person retires it on the board)")
  .argument("<id>", "e.g. m12")
  .option("--reason <text>", "why it no longer holds")
  .option("--json", "machine-readable output")
  .action(wrap(runForget));

program
  .command("memories")
  .description("Your team's accepted memories, newest first")
  .option("--kind <kind>", "only this kind")
  .option("--tag <tag>", "only this tag")
  .option("--repo <owner/name>", "only this repo's (project: team-wide ones)")
  .option("--json", "machine-readable output")
  .action(wrap(runMemories));

program
  .command("whoami")
  .description("Who you are on the team hub, and which agent session this is")
  .option("--json", "machine-readable output")
  .action(wrap(runWhoami));

// v2 Delegate (SPEC §31): handoffs, approval gates, waking idle sessions.
program
  .command("handoff")
  .description("Hand a task to a teammate (or `me`: one of your other machines); their machine starts an agent for it once they accept")
  .argument("<to>", "a person (display name or email), or me")
  .argument("<task...>", "what to do")
  .option("--repo <owner/name>", "the repo (default: this directory's)")
  .option("--issue <id>", "a Linear issue, e.g. B3-123")
  .option("--context <text>", "anything else the agent should know")
  .option("--json", "machine-readable output")
  .action(wrap(runHandoff));
const handoffs = program
  .command("handoffs")
  .description("Handoffs offered to you and sent by you; read one in full, accept or decline it, or run one accepted elsewhere")
  .argument("[action]", "list | show | accept | decline | run")
  .argument("[id]", "the handoff, for show, accept, decline and run")
  .option("--note <text>", "why (decline)")
  .option("--json", "machine-readable output")
  .action(wrap((action: string | undefined, id: string | undefined, opts: { note?: string; json?: boolean }) => runHandoffs(action, id, opts)));
handoffs
  .command("rule")
  .description("Standing rules for requests from teammates without a relay: accept and start some with no click (added only at a terminal)")
  .argument("[action]", "list | add | remove")
  .argument("[n]", "for remove: the rule's number")
  .option("--from <email>", "add: whose requests (their exact email)")
  .option("--repo <owner/name>", "add: only in this repo")
  .option("--size <size>", "add: up to small, medium or large (default small)")
  .option("--per-day <n>", "add: at most this many a day (default 3)")
  .action(
    wrap((action: string | undefined, n: string | undefined, opts: { from?: string; repo?: string; size?: string; perDay?: string }) =>
      runRequestRule(action, n, opts),
    ),
  );
handoffs
  .command("policy")
  .description("Which handoffs this machine takes without a click: ask (the default: none), auto-self (your own), never")
  .argument("[policy]", "ask | auto-self | never")
  .action(wrap(runHandoffPolicy));
// Review exchange (SPEC §53): agents review each other's PRs, read-only; agent reviews never approve.
program
  .command("review")
  .description("Ask a teammate's agent for a read-only review of a PR (never an approval); the findings come back to the asking session")
  .argument("[pr]", "212, owner/name#212 or the PR's URL (default: the PR this session opened)")
  .option("--repo <owner/name>", "the repo (default: the PR's, else this directory's)")
  .option("--focus <text>", "what to look at")
  .option("--reviewer <person...>", "up to two people (default: CODEOWNERS, recent work, who is free)")
  .option("--count <n>", "how many reviewers: 1 (default) or 2")
  .option("--json", "machine-readable output")
  .action(wrap(runReview));
const reviews = program
  .command("reviews")
  .description("Agent reviews you asked for and ones asked of you; read one's findings")
  .argument("[action]", "list | show")
  .argument("[id]", "the review, for show")
  .option("--json", "machine-readable output")
  .action(wrap((action: string | undefined, id: string | undefined, opts: { json?: boolean }) => runReviews(action, id, opts)));
reviews
  .command("policy")
  .description("Which reviews this machine runs without a click (ask, the default; auto; never), and whether it posts them on the PR")
  .argument("[accept]", "auto | ask | never")
  .option("--post <on|off>", "post finished reviews on the PR as a comment through your gh (default off; never an approval)")
  .option("--agent <agent>", "the agent CLI reviews run on (claude, codex, opencode, gemini, antigravity, grok, cursor, amp, auto, or default)")
  .option("--model <name>", "the model reviews run on")
  .option("--auto <on|off|hub>", "ask for a review when a PR you open here is ready (hub: your board setting)")
  .option("--count <n>", "reviewers per request: 1 or 2")
  .option("--json", "machine-readable output")
  .action(wrap(runReviewPolicy));
program
  .command("roots")
  .description("Where your repos live, so a handoff finds its checkout here (repos your sessions worked in count too)")
  .argument("[action]", "list | add | remove")
  .argument("[dir]", "a directory (absolute, relative, or ~/…)")
  .action(wrap(runRoots));
program
  .command("gates")
  .description("Approval gates on your own agents: they ask before they merge, deploy, publish, force-push or spend")
  .argument("[action]", "list | set | off (or a list, e.g. merge,deploy)")
  .argument("[gates]", "for set: merge,deploy,publish,force_push,spend,custom")
  .option("--json", "machine-readable output")
  .action(wrap(runGates));
program
  .command("approvals")
  .description("Approvals your agents asked for, and ones you can decide; approve or deny one")
  .argument("[action]", "list | approve | deny")
  .argument("[id]", "the approval, for approve and deny")
  .option("--note <text>", "why (shown to the agent)")
  .option("--json", "machine-readable output")
  .action(wrap(runApprovals));
program
  .command("wake")
  .description("Show or set whether an idle session wakes (on by default), and whose messages may wake it (replies by default)")
  .argument("[value]", "on | off, or who may wake: replies | team | self")
  .action(wrap(runWake));
program
  .command("wake-wait", { hidden: true })
  .description("Claude Code asyncRewake Stop hook: wait for this session's next message (never fails the session)")
  .argument("<source>", "claude-code")
  .action(runWakeWait);

program
  .command("mcp")
  .description("Serve the team coordination tools over MCP (stdio), for Claude Code and Codex")
  .action(wrap(runMcp));

program
  .command("capacity")
  .description("View local qswap subscription headroom and opt in to sharing capacity with your team hub")
  .argument("[action]", "status | share")
  .argument("[level]", "with share: off | availability | detailed")
  .option("--json", "machine-readable output")
  .action(wrap((action: string | undefined, level: string | undefined, opts: { json?: boolean }) => runCapacity(action, level, opts)));

program
  .command("route")
  .description("Recommend the best local AI subscription for a task from qswap's fleet_status.json")
  .option("--task <kind>", "coding | review | long_context | research | bulk (default: coding)")
  .option("--caller <agent>", "calling agent for cross-harness diversity (e.g. claude)")
  .option("--json", "machine-readable output")
  .action(wrap((opts: { task?: string; caller?: string; json?: boolean }) => runRoute(opts)));

const poolCmd = program
  .command("pool")
  .description("Opt in to letting teammates delegate worktree PR and read-only tasks to your spare subscriptions")
  .argument("[action]", "status | on | off")
  .option("--json", "machine-readable output")
  .action(wrap((action: string | undefined, opts: { json?: boolean }) => runPool(action, opts)));

poolCmd
  .command("rule")
  .description("Manage local capacity pool rules (terminal-only consent; checked against live qswap headroom)")
  .argument("[action]", "list | add | remove")
  .argument("[n]", "rule number to remove")
  .option("--from <team|email>", "teammate email or `team` (default: team)")
  .option("--providers <list>", "comma-separated providers: claude,codex,opencode,antigravity,grok")
  .option("--modes <list>", "comma-separated modes: readonly,worktree (default: readonly,worktree)")
  .option("--repo <owner/name>", "optional repo or org/* filter")
  .option("--min-headroom <pct>", "reserve headroom % kept for yourself (default: 30)")
  .option("--expiring-floor <pct>", "lower reserve % when quota resets within 12h or has expiring credits (default: 10)")
  .option("--per-day <n>", "max pooled tasks per day (default: 10)")
  .action(wrap((action: string | undefined, n: string | undefined, opts: Parameters<typeof runPoolRule>[2]) => runPoolRule(action, n, opts)));

program
  .command("doctor")
  .description("Check config, daemon, relay, and hook installs")
  .option("--json", "machine-readable output")
  .option("--claude-dir <path>", "Claude Code config dir to check (default: $CLAUDE_CONFIG_DIR, else ~/.claude)")
  .action(wrap(runDoctor));

await program.parseAsync(process.argv);
