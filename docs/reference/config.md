# Config and environment

Workmesh keeps its settings in one JSON file, `~/.config/workmesh/config.json` (`$XDG_CONFIG_HOME/workmesh/config.json`
when that is set), mode `0600` because it holds your device tokens. `workmesh init`, `setup` and the `hub`, `handoffs`,
`roots`, `gates`, `wake` and `update --auto` commands write it for you; prefer them to editing by hand. After a hand
edit, run `workmesh restart`. The menu bar app changes `granularity`, `statusPolicy`, `showProject` and `repoPrefix` on
the running daemon without a restart.

The schema is `configSchema` in `packages/cli/src/lib/config.ts`. `npm run docs:ref:check` fails when a key there is
missing from this page.

## Team hub

Written by `workmesh hub connect` (or `init`). Don't copy this section between machines: each machine pairs on its own.

| Key | Default | What it is |
|---|---|---|
| `hub` | absent | Present once this machine is paired. A malformed section reads as "not paired". |
| `hub.url` | | The hub, e.g. `https://workmesh.b3os.org`. |
| `hub.deviceId` | | This machine's device id on the hub. |
| `hub.deviceToken` | | The token the daemon sends with every hub request. Treat it as a password. |
| `hub.machine` | hostname | The name the board shows (`init --machine`). |
| `hub.person` | | Who approved the pairing: `hub.person.name` and `hub.person.email`. |
| `hub.person.name` | | Your name on the board. |
| `hub.person.email` | | The login that approved the pairing. |
| `hub.project` | | The project and its sharing rule, as the hub sent it at pairing (B3: repos whose origin contains `github.com/b3-fun/`). |
| `hub.includeDirs` | `[]` | Folders shared on top of the rule (`workmesh hub include <dir>`). |
| `hub.excludeDirs` | `[]` | Folders never shared, whatever their remote (`workmesh hub exclude <dir>`). |
| `hub.pairedAt` | | When it paired (ms since epoch). |
| `hub.share` | `conversation` | `conversation` or `metadata` (`workmesh hub share <level>`). Absent means `conversation`. |
| `hub.stickyShare` | `true` | Whether a session stays shared once it touches a shared repo (`workmesh hub sticky on\|off`). |
| `hub.github` | | Your GitHub login, read from `gh` at pairing, for your avatar. |

## Delegation, gates, wake and updates

| Key | Default | What it is |
|---|---|---|
| `handoffs` | absent | Handoff settings for this machine. Absent means the defaults below. |
| `handoffs.accept` | `ask` | `ask` waits for your Accept on every handoff, your own too. `auto-self` starts handoffs you sent yourself with no click and waits on teammates'. It trusts every machine and token of yours: each of them, and any agent running there, can start an agent on this machine. `never` runs none here (`workmesh handoffs policy`). |
| `handoffs.runAccepted` | `confirm` | What this machine does with a handoff that was accepted somewhere else, such as on the board. `confirm`: it waits here until you say "run it here" (`workmesh handoffs run <id>`, or the menu bar). `auto`: this machine starts it. `auto` trusts the hub's word that you accepted it. |
| `handoffs.agent` | `claude` when found, else `codex` | The agent CLI that runs a handoff. |
| `handoffs.roots` | `[]` | Folders whose git repos count as checkouts for handoffs (`workmesh roots add <dir>`). |
| `handoffs.worktree` | `true` | Run each handoff in a new git worktree on its own branch. |
| `handoffs.maxRunning` | `2` | Handoffs running at once on this machine (0 to 10). |
| `handoffs.permissionMode` | `auto` | Claude Code `--permission-mode` for a handoff's session. The default stays `auto`: `acceptEdits` can't commit in a headless run, and you read the whole handoff and see the mode before you accept. |
| `handoffs.env` | `[]` | Additional environment variables a handoff agent may inherit. By default it receives shell, locale and toolchain settings plus its model provider’s sign-in. For example, listing `SSH_AUTH_SOCK` grants the child access to the SSH agent. The run's log names what was left out. |
| `handoffs.requestRules` | `[]` | Standing rules for requests from teammates without a relay (SPEC §56): this machine accepts and starts a request from that exact email, optionally in one repo, up to a size, at most so many a day, with no click. Each entry is `{ from, repo?, maxSize, perDay }`. Add rules with `workmesh handoffs rule add`, which asks at a terminal. |
| `handoffs.model` | the agent's default | The model a handoff runs on, e.g. `sonnet`. |
| `handoffs.maxMinutes` | `120` | How long a handoff run may take (5 to 1440). |
| `reviews` | absent | Agent reviews of teammates' PRs this machine runs, and the reviews its sessions ask for. Absent means the defaults below. Only you change it, from your own terminal (`workmesh reviews policy`): an agent's call is refused, and the hub never sets it. |
| `reviews.accept` | `ask` | `ask` waits for your Accept on every review asked of you, as any handoff does. `auto` starts one on this machine with no click: it is read-only (a fresh checkout of the PR's head, no push, merge, approval or GitHub write), and it trusts the hub's routing and every teammate who can ask for one. `never` runs none here, and the hub asks someone else. |
| `reviews.postToGitHub` | `false` | Post this machine's finished reviews on the PR as a plain review comment through your own `gh`. Never an approval. |
| `reviews.agent` | `handoffs.agent`, else `claude` when found, else `codex` | The agent CLI reviews run on. A Claude Code review reads only; a Codex review may run the PR's tests inside its sandbox with no network. |
| `reviews.model` | `handoffs.model`, else the agent's default | The model reviews run on. |
| `reviews.auto` | absent | Ask for an agent review by itself when a session here opens a PR (not a draft) or marks one ready. Absent: your board setting and the team's repos where every ready PR gets one. |
| `reviews.count` | `1` | Reviewers one request asks: 1 or 2. |
| `reviews.maxMinutes` | `30` | How long a review run may take (5 to 240). |
| `wake` | `true` | Wake an idle session when a message that may wake it, an approval or a handoff result arrives (`workmesh wake on\|off`). Whose messages may wake is `messages.wake`. |
| `gates` | absent | Your own patterns for the `custom` approval gate. The gates themselves live on the hub (`workmesh gates set …`). |
| `gates.custom` | `[]` | Case-insensitive regexes over a shell command, up to 50. |
| `update` | absent | Updates the daemon installs on its own. Absent means off. |
| `update.auto` | `false` | `workmesh update --auto on\|off`. |
| `update.scope` | `patch` | `patch` takes 0.12.0 to 0.12.3; `minor` (`--auto on --minor`) takes 0.13.0 too. Never a new major. |
| `update.waitHours` | `24` | How many hours a release must be out before `doctor`, `status` and the menu bar offer it, and before auto-update installs it. `0` turns the wait off; 720 is the most. `workmesh update` run by hand never waits. No command sets it: edit the file. See [New releases wait a day](../guide/updating-and-uninstalling.md#new-releases-wait-a-day). |

## Messages

Who may reach this machine's sessions. Your machine decides: a sender, or the hub, can only ask. The daemon reads
these keys again within a few seconds of a change, so a hand edit needs no restart.

| Key | Default | What it is |
|---|---|---|
| `messages` | absent | Rules for teammates' messages on this machine. Absent means the defaults below. |
| `messages.wake` | `replies` | Whose message may start a turn in an idle session, while `wake` is on. `replies`: your own messages, and a reply from a person (or their agent) that the session wrote to in the last 7 days. When Workmesh knows that person's email, a reply must come from it. `team`: any teammate's. `self`: only your own. Or a list of people, by email or by the name the board shows: `["sam.lee@example.org", "Bo"]`. An email matches that person only. A name stands for the one person on the team with that name. The team here is the people the hub lists, which can leave out someone with no paired machine: write their email instead. When Workmesh knows that person's email, a message must carry it, so a message made from a Linear prompt does not pass on the name alone. When two or more people share it, it matches none of them, and the daemon log says once to write the email instead. GitHub logins don't match. Set the first three with `workmesh wake replies\|team\|self`. A message that may not wake still reaches the session at its next prompt or tool call. |
| `messages.hold` | `bypass` | Which sessions get a teammate's message only after you said so. `bypass`: a session that runs with permission prompts skipped (Claude Code's `bypassPermissions` or `dontAsk` mode, a Codex thread with no sandbox). `unattended`: also `auto` mode. `always`: every session. `never`: none. A held message shows in the menu bar and in `workmesh inbox --held`, and your agent never sees it unless you deliver it. Your own messages are never held. |
| `messages.confirmActions` | `false` | After a teammate’s message reaches a session, require your signed-in board approval for each subsequent native tool call in that session or its subagents. Compare the request ID and tool arguments in the session before approving. Requests last five minutes and each approval releases one exact call. Start a fresh session for unrelated work. |
| `messages.holdMinutes` | `60` | How long a held message waits for you before it is dropped, in minutes (1 to 10080). |
| `messages.from` | `team` | Whose messages this machine takes at all. `team`: anyone on the team. `self`: only your own. Or a list of people, by email or by name, read as for `messages.wake`. A message from anyone else is dropped on this machine, never delivered, and named in the daemon log once an hour per sender. |

## Daemon and agents

| Key | Default | What it is |
|---|---|---|
| `port` | `4519` | The daemon's loopback port. |
| `autoStartDaemon` | `true` | A hook starts the daemon when it isn't running (a failed start waits 60 s before the next try). |
| `adapters` | all on | Which sources the daemon watches. |
| `adapters.claudeCode` | | Claude Code sessions and workflow journals. |
| `adapters.claudeCode.enabled` | `true` | |
| `adapters.claudeCode.configDir` | `$CLAUDE_CONFIG_DIR`, else `~/.claude` | The Claude Code profile the daemon reads (`setup --claude-dir`). |
| `adapters.codex` | | Codex session logs (a fallback for Codex builds without hooks). |
| `adapters.codex.enabled` | `true` | |
| `adapters.codex.sessionsDir` | `~/.codex/sessions` | |
| `adapters.workflow` | | Live agent counts for Claude Code workflow runs. |
| `adapters.workflow.enabled` | `true` | |
| `adapters.workflow.projectsDir` | `~/.claude/projects` | |
| `adapters.opencode` | | OpenCode sessions read-only from `opencode.db` (DeepSeek API, etc.). |
| `adapters.opencode.enabled` | `true` | |
| `adapters.opencode.dbPath` | `~/.local/share/opencode/opencode.db` | |
| `adapters.gemini` | | Gemini CLI sessions read-only from `~/.gemini/tmp/*/chats/session-*.json`. |
| `adapters.gemini.enabled` | `true` | |
| `adapters.gemini.dir` | `~/.gemini` | |
| `adapters.antigravity` | | Antigravity (Gemini) sessions read-only from `~/.gemini/antigravity/conversation_summaries.db` and transcript tails. |
| `adapters.antigravity.enabled` | `true` | |
| `adapters.antigravity.dir` | `~/.gemini/antigravity` | |
| `adapters.grok` | | Grok Bot sessions read-only from `~/.grokbot/local-exec-daemon.json`. |
| `adapters.grok.enabled` | `true` | |
| `adapters.grok.dir` | `~/.grokbot` | |
| `adapters.harness` | | Bridges non-Claude/non-Codex Harness CLI sessions (`antigravity`, `gemini-cli`, `grok`, `cursor`, `copilot`, `windsurf`, `amp`, `aider`, `cline`, `zed`, etc.) via `harness ps --json`. |
| `adapters.harness.enabled` | `true` | |

## Capacity and delegation pool

Opt-in subscription headroom sharing and teammate compute delegation (SPEC §61–62). Off until you enable them at your own terminal.

| Key | Default | What it is |
|---|---|---|
| `capacity` | absent | Opt-in capacity reporting from `qswap`'s `~/.ai-quota-swap/fleet_status.json`. |
| `capacity.share` | `off` | `off` (nothing sent), `availability` (coarse buckets + reset countdown only), or `detailed` (+ headroom % and est. API value; never emails or keys). Set with `workmesh capacity share <level>`. |
| `pool` | absent | Opt-in team delegation pool: auto-accepts teammates' read-only and worktree PR tasks while your live `qswap` headroom stays above your reserve floor. |
| `pool.enabled` | `false` | Turn on or off with `workmesh pool on\|off`. |
| `pool.rules` | `[]` | Local pool rules added interactively at your terminal with `workmesh pool rule add` (sender/team, providers, modes `readonly`/`worktree`, optional repo filter, `minHeadroom`, `expiringFloor`, `perDay`). |

## Slack status

Only used when you set up a Slack status with `workmesh setup`. A machine set up with `init` alone has `mode`
`console`: nothing goes to Slack. See [Slack status](../guide/slack-status.md).

| Key | Default | What it is |
|---|---|---|
| `mode` | `console` | `relay` (through agentblip.com or your own relay), `slack` (your own Slack app's user token, no server) or `console` (no Slack). |
| `relayUrl` | `https://agentblip.com` | The Slack-status relay in `relay` mode. |
| `deviceToken` | | The relay's device token, from `setup`. |
| `slackToken` | | Your Slack user token in `slack` mode. |
| `granularity` | `count` | How much the status says: `off`, `presence`, `count` or `activity`. |
| `statusPolicy` | `respect` | `respect` never overwrites a status Workmesh didn't set; `overwrite` replaces it and puts it back after. |
| `showProject` | `false` | Append the project name. |
| `repoPrefix` | `true` | In `activity` mode, lead with the repo name. |
| `statusTtlSec` | `300` | Slack clears the status this many seconds after the last push (0: never). |
| `debounceMs` | `10000` | Minimum time between Slack pushes. |
| `templates` | | Status text, with `{agent}`, `{activity}`, `{project}`, `{working}`, `{total}` and `{waiting}` placeholders. |
| `templates.presence` | `heads down with agents` | |
| `templates.workingOne` | `{agent} agent working` | |
| `templates.workingMany` | `{working} agents working` | |
| `templates.waitingSuffix` | ` · {waiting} waiting on me` | |
| `templates.activityOne` | `{agent}: {activity}` | |
| `templates.activityMany` | `{working} agents · {activity}` | |
| `templates.repoActivityOne` | `{project}: {activity}` | |
| `templates.repoActivityMany` | `{working} agents · {project}: {activity}` | |
| `templates.waitingOnly` | `{waiting} agent(s) waiting on me` | |
| `emoji` | | Status emoji in Slack's `:name:` form. |
| `emoji.working` | `:robot_face:` | |
| `emoji.waiting` | `:raised_hand:` | |
| `redactPatterns` | | Strings or regexes scrubbed from the Slack status text (case-insensitive). |
| `hideProjects` | | Projects that still count toward "N agents working" but never name themselves in the status. |

`redactPatterns` and `hideProjects` apply to the Slack status. What reaches the team hub is redacted separately, on
your machine, by fixed rules: see [Sharing and privacy](../guide/sharing-and-privacy.md).

## Environment variables

| Variable | What it does |
|---|---|
| `WORKMESH_PORT` | The daemon port, over `port` in the config. |
| `WORKMESH_RELAY_URL` | The Slack-status relay, over `relayUrl`. |
| `WORKMESH_TOKEN` | The relay device token, over `deviceToken`. |
| `WORKMESH_STATUS_POLICY` | `respect` or `overwrite`, over `statusPolicy`. |
| `WORKMESH_NO_SERVICE` | `1` keeps the daemon out of launchd and systemd (tests, or a machine that runs the daemon its own way). |
| `WORKMESH_LAUNCHD_LABEL` | A launchd label other than `org.npclabs.workmesh.daemon`, for a second, separate install on one Mac (the smoke tests use it). |
| `WORKMESH_REGISTRY` | The npm registry `workmesh update` reads and installs from (else `npm_config_registry`, else npmjs.org). |
| `WORKMESH_RELEASES_URL` | Where the daemon looks up the menu bar app's release (the smoke tests point it at a mock). |
| `CLAUDE_CONFIG_DIR` | The Claude Code profile to hook and read, else `~/.claude`. |
| `CODEX_HOME` | Codex's home, else `~/.codex`. |
| `XDG_CONFIG_HOME`, `XDG_STATE_HOME` | Move `~/.config/workmesh` and `~/.local/state/workmesh`. |
| `NO_COLOR` | Plain output. |

Each `WORKMESH_*` setting above also reads the pre-rename `AGENTBLIP_*` name when the new one is unset.

Set by Workmesh itself, useful when you debug:

| Variable | Where |
|---|---|
| `WORKMESH_SERVICE` | In the daemon's environment when launchd or systemd runs it. |
| `WORKMESH_HANDOFF` | In a handoff run's environment: the handoff id. A session with it is never woken (nobody is there to answer). Its hooks send the id to the daemon, which holds a review run's writes. |
| `WORKMESH_DELEGATION_DEPTH` | Nesting depth of delegated agent runs (starts at `1` inside a delegated run; prevents recursive delegation loops). |
| `WORKMESH_REVIEW` | `1` in a review run's environment (a read-only review of a teammate's PR). |

## Files

| Path | What it holds |
|---|---|
| `~/.config/workmesh/config.json` | This page's settings and your tokens (`0600`). |
| `~/.local/state/workmesh/daemon.secret` | The bearer secret for the daemon's loopback API (`0600`). |
| `~/.local/state/workmesh/daemon.log` | The daemon's log when it runs without a service. Under launchd it logs to `~/Library/Logs/workmesh-daemon.log`; under systemd, to the journal (`journalctl --user -u workmesh`). |
| `~/.local/state/workmesh/hub-forward.json` | Shared sessions and unsent events, so a restart loses nothing (`0600`). |
| `~/.local/state/workmesh/messages.json` | Who each session wrote to in the last 7 days, so their answer counts as a reply, and the messages held for you (`0600`). |
| `~/.local/state/workmesh/new-devices.json` | The machines that joined your account and that this machine already told you about, so each is told once (`0600`). |
| `~/.local/state/workmesh/update.log`, `update/previous/` | The last `workmesh update` run and the copy it rolls back to. |
| `~/.local/state/workmesh/handoffs/` | Handoff runs on this machine. |
| `~/.local/state/workmesh/handoffs-accepted.json` | The ids of the handoffs that were accepted on this machine, each with a hash of the text that was accepted (`0600`). Only those are started here, and only while their text is the same. |
| `~/Library/LaunchAgents/org.npclabs.workmesh.daemon.plist` | The daemon service on macOS. |
| `~/.config/systemd/user/workmesh.service` | The daemon service on Linux. |
