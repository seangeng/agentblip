# agentblip

**Your Slack status, synced with your local AI agents.** Every session is a blip on your team's radar.

[![npm](https://img.shields.io/npm/v/agentblip)](https://www.npmjs.com/package/agentblip)
[![CI](https://github.com/seangeng/agentblip/actions/workflows/ci.yml/badge.svg)](https://github.com/seangeng/agentblip/actions/workflows/ci.yml)
[![MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

[**agentblip.com**](https://agentblip.com) · [npm](https://www.npmjs.com/package/agentblip) · [GitHub](https://github.com/seangeng/agentblip)

Your team can't see your agents. You kick off three Claude Code sessions, go heads-down
reviewing what they produce, and on Slack you look… idle. Meanwhile someone pings you
mid-run, an agent sits blocked on a permission prompt for twenty minutes, and nobody —
including you — knows. Presence used to mean "at the keyboard." Now half the work is
delegated, and the green dot has nothing to say about it.

agentblip turns local agent sessions into your Slack status — the little green light
for the AI era:

| Your status reads | When |
|---|---|
| 🤖 `claude agent working` | one session busy |
| 🤖 `3 agents working` | three sessions busy |
| 🤖 `claude: finalizing CI/CD` | `activity` granularity — what it's actually doing |
| ✋ `1 agent(s) waiting on me` | an agent is blocked on you |

## Quick start

```bash
npm i -g agentblip
agentblip setup           # walks through Slack connect + hook install
agentblip start --detach  # daemon runs in the background
```

That's it. Claude Code sessions appear automatically via hooks; Codex via its notify
hook plus a session watcher. Anything else can report itself with one HTTP request
(see [Integrations](#integrations)). When every agent finishes, your status clears.

## How it works

```
Claude Code hooks ─┐
Codex watcher ─────┤   POST /event      ┌────────────────────┐  POST /api/status   ┌──────────────┐
Any tool (curl) ───┼──────────────────▶ │ agentblip daemon   │ ───────────────────▶│ relay Worker │──▶ Slack API
                   │  localhost:4519    │ SessionStore →     │  pre-formatted      │ (or direct   │   users.profile.set
                   └                    │ formatStatus →sink │  SlackStatus only   │  Slack sink) │
                                        └────────────────────┘                     └──────────────┘
```

The daemon is the only thing that sees raw session data. Hooks and adapters report
events to `127.0.0.1:4519`; the daemon aggregates your sessions and formats the status
text **locally**, applying your granularity, templates, and redaction patterns before
anything touches the network. The relay receives exactly three fields — text, emoji,
expiration — and passes them to Slack's `users.profile.set`. It cannot see your
prompts, tool calls, file paths, or projects, because they never leave your machine
unless you chose a granularity that puts them in the status text itself. (At
`"presence"` the relay sees the same fixed string all day.)

Every push carries a rolling expiration (5 minutes by default). If your laptop sleeps,
the daemon crashes, or wifi drops, Slack clears the status on its own — no stale
"working" lies. Server-side, the relay stores nothing about you beyond your Slack
user/team ids and an AES-GCM-encrypted Slack token keyed to your device, and you can
revoke that any time with `agentblip unlink`.

## Granularity & customization

One knob controls how much your status reveals:

| `granularity` | Your status reads |
|---|---|
| `off` | never set |
| `presence` | 🤖 `heads down with agents` |
| `count` (default) | 🤖 `claude agent working` · 🤖 `3 agents working` |
| `activity` | 🤖 `claude: finalizing CI/CD` · 🤖 `3 agents · finalizing CI/CD` |

At `count` and `activity`, agents blocked on you append ` · 1 waiting on me`; when
nothing is working and agents are only waiting, the status flips to
✋ `1 agent(s) waiting on me`.

Everything lives in `~/.config/agentblip/config.json` (`XDG_CONFIG_HOME` respected),
created by `agentblip setup`. The comments below are documentation — the real file is
plain JSON:

```jsonc
{
  // How much your status reveals: "off" | "presence" | "count" | "activity".
  "granularity": "count",

  // Append the project name: "claude agent working (agentblip)".
  // Project is usually the basename of the session's cwd.
  "showProject": false,

  // Rolling expiration in seconds — Slack auto-clears the status if the daemon
  // stops refreshing it (sleep, crash, dead wifi). 0 = never expire.
  "statusTtlSec": 300,

  // Minimum ms between Slack pushes (users.profile.set allows ~50/min).
  "debounceMs": 10000,

  // Local daemon port (loopback only).
  "port": 4519,

  // Strings or regexes scrubbed from activity/project text before it can reach
  // your status. Case-insensitive; strings that don't compile as regexes match
  // literally. Matches become "…".
  "redactPatterns": ["secret-project", "client-\\w+"],

  // Status emoji, Slack ":name:" form.
  "emoji": { "working": ":robot_face:", "waiting": ":raised_hand:" },

  // Status text templates. Placeholders in {braces}; unknown ones are left as-is.
  "templates": {
    "presence": "heads down with agents",              // fixed text for "presence"
    "workingOne": "{agent} agent working",             // {agent} {activity} {project}
    "workingMany": "{working} agents working",         // {working} {total}
    "waitingSuffix": " · {waiting} waiting on me",     // {waiting} — appended while agents wait
    "activityOne": "{agent}: {activity}",              // {agent} {activity} {project}
    "activityMany": "{working} agents · {activity}",   // {working} {activity}
    "waitingOnly": "{waiting} agent(s) waiting on me"  // {waiting} — nothing working, agents blocked
  }
}
```

Status text is truncated to Slack's 100-character cap. `{agent}` is a friendly display
name (`claude-code` → `claude`, `codex` → `codex`, `gemini-cli` → `gemini`); unknown
sources display as-is.

## Integrations

### Claude Code — automatic

`agentblip setup` installs hooks into your Claude Code settings. Seven hook events map
onto the session lifecycle:

| Claude Code hook | Event sent |
|---|---|
| `SessionStart` | `start` |
| `UserPromptSubmit` | `working` |
| `PreToolUse` | `working` (tool as activity) |
| `PostToolUse` | `working` (keeps liveness fresh) |
| `Notification` | `waiting` (permission prompt, question) |
| `Stop` | `idle` |
| `SessionEnd` | `end` |

Each hook pipes its JSON to `agentblip hook claude-code`, which forwards a normalized
event to the daemon. Multiple concurrent sessions just work — each is tracked by its
session id.

### Codex — notify + watcher

`agentblip setup` adds a `notify` hook to your Codex config (`agentblip hook codex` is
the entrypoint), which reports turn completions. Because notify alone can't see when a
turn *starts*, the daemon also watches Codex session logs to mark sessions working in
real time.

### Anything else — one HTTP request

The daemon's localhost API is a stable public interface. Report any process as an
agent session:

```bash
curl -X POST http://127.0.0.1:4519/event \
  -H "content-type: application/json" \
  -d '{
    "source": "my-tool",
    "sessionId": "run-42",
    "kind": "working",
    "activity": "backfilling embeddings",
    "project": "acme-api"
  }'
```

Send `{"kind": "end"}` with the same `source` + `sessionId` when it finishes. Full
schema, event semantics, staleness rules, and adapter-writing guide:
[docs/INTEGRATIONS.md](docs/INTEGRATIONS.md).

## CLI reference

| Command | Does |
|---|---|
| `agentblip setup` | Interactive setup: connect Slack (hosted, self-hosted, or direct token) + install agent hooks |
| `agentblip start [--detach]` | Run the daemon, foreground or in the background |
| `agentblip stop` | Stop the background daemon |
| `agentblip status [--json]` | Show daemon state, live sessions, and the current status |
| `agentblip emit` | Send a session event by hand (testing, scripts) |
| `agentblip hook <source>` | stdin→event adapter wired into agent hooks (e.g. `agentblip hook claude-code`) |
| `agentblip pause` | Pause Slack updates without stopping the daemon |
| `agentblip resume` | Resume Slack updates |
| `agentblip unlink` | Revoke this device's token and clear the status |
| `agentblip doctor [--json]` | Diagnose config, daemon, hooks, and connectivity |

## Self-hosting & direct mode

The relay is one Cloudflare Worker with one KV namespace — fork the repo, create the
namespace and two secrets, deploy, and point `agentblip setup` at your own domain. The
full walkthrough is in [docs/SELF_HOSTING.md](docs/SELF_HOSTING.md). If you'd rather
run no server at all, direct mode has the daemon call Slack's API straight from your
machine with your own Slack app's user token — no relay in the loop.

## Contributing

PRs welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for dev setup, the repo map, and
what a good PR looks like. The one hard rule: the relay must never see anything beyond
the final formatted status.

## License

MIT © 2026 [Sean Geng](https://seangeng.com)
