# Integrating with agentblip

The daemon's localhost HTTP API is agentblip's stable public interface. Claude Code
hooks, the Codex adapter, and `agentblip emit` all speak it — and so can anything you
build. If your tool can make an HTTP request, it can be a blip.

## The daemon API

Loopback only, default `http://127.0.0.1:4519` (`port` in
`~/.config/agentblip/config.json`).

| Method & path | Body | Purpose |
|---|---|---|
| `POST /event` | session event (below) | Report a session event. `200` on accept, `400` on schema failure |
| `GET /state` | — | Current sessions and the formatted status, as JSON |
| `POST /pause` | — | Pause Slack updates (daemon keeps tracking) |
| `POST /resume` | — | Resume Slack updates |
| `GET /health` | — | Liveness probe |

## The event schema

`POST /event` bodies are validated against `sessionEventSchema` from
[`@agentblip/core`](../packages/core/src/events.ts):

| Field | Type | Required | Notes |
|---|---|---|---|
| `source` | string, 1–64 chars | yes | Adapter id: `"claude-code"`, `"codex"`, or your own slug |
| `sessionId` | string, 1–128 chars | yes | Stable per session — `(source, sessionId)` identifies the session |
| `kind` | enum | yes | `start` \| `working` \| `waiting` \| `idle` \| `heartbeat` \| `end` |
| `activity` | string, ≤200 chars | no | Short label of what's happening, e.g. `"editing format.ts"` |
| `project` | string, ≤120 chars | no | Usually the basename of the session's cwd |
| `ts` | positive int | no | Epoch **milliseconds**; defaults to receipt time |

Well-known sources get friendly display names in status text (`claude-code` →
`claude`, `codex`, `gemini-cli` → `gemini`, `cursor`, `opencode`); anything else
displays as-is.

## Event kinds

| `kind` | Meaning | Session state after |
|---|---|---|
| `start` | Session opened, not yet working | idle |
| `working` | Agent is actively doing something | working |
| `waiting` | Agent blocked on the human (permission prompt, question) | waiting |
| `idle` | Turn finished, session still open | idle |
| `heartbeat` | Refresh liveness without changing state | unchanged (idle if the session is new) |
| `end` | Session closed | removed |

Details worth knowing:

- **Activity is sticky while working.** A `working` event without an `activity`
  keeps the previous label — tool chatter often arrives label-less between richer
  events. `project` is sticky the same way.
- **Out-of-order events are dropped.** An event whose `ts` is older than the
  session's last event is ignored.
- **Only working sessions surface an activity.** The status shows the most recently
  updated working session's label.

## Staleness rules

The daemon assumes adapters die without saying goodbye, so liveness is enforced
(constants from `@agentblip/core`):

- A `working`/`waiting` session silent for **3 minutes** is demoted to idle and its
  activity cleared. During long operations, send `heartbeat` (or repeat `working`)
  more often than that.
- An idle session silent for **15 minutes** is evicted entirely.
- Independently, the Slack status itself carries a rolling **5-minute** expiration —
  if the whole daemon dies, Slack clears the status on its own.

Don't worry about event volume: the daemon debounces Slack pushes (10s default) and
only pushes when the formatted status actually changes. Fire events as often as you
like.

## curl examples

Start working:

```bash
curl -s -X POST http://127.0.0.1:4519/event \
  -H "content-type: application/json" \
  -d '{"source":"my-agent","sessionId":"run-42","kind":"working","activity":"training model","project":"acme-api"}'
```

Finish:

```bash
curl -s -X POST http://127.0.0.1:4519/event \
  -H "content-type: application/json" \
  -d '{"source":"my-agent","sessionId":"run-42","kind":"end"}'
```

Wrap any long-running command in a blip:

```bash
blip() {
  local label="$1"; shift
  local sid="shell-$$-$RANDOM"
  local url="http://127.0.0.1:4519/event"
  curl -s -o /dev/null -X POST "$url" -H "content-type: application/json" \
    -d "{\"source\":\"shell\",\"sessionId\":\"$sid\",\"kind\":\"working\",\"activity\":\"$label\",\"project\":\"$(basename "$PWD")\"}"
  "$@"
  local code=$?
  curl -s -o /dev/null -X POST "$url" -H "content-type: application/json" \
    -d "{\"source\":\"shell\",\"sessionId\":\"$sid\",\"kind\":\"end\"}"
  return $code
}

blip "running the eval suite" npm test
```

For shell scripting without hand-rolled curl, `agentblip emit` wraps `POST /event`,
and `agentblip hook <source>` adapts hook JSON on stdin into events.

## Writing an adapter

1. **Pick a stable `source` slug** (lowercase, ≤64 chars). It's how sessions are
   grouped and how the agent is named in status text.
2. **Reuse one `sessionId` per session or run.** New id → new blip; same id → state
   transitions on the same blip.
3. **Map your tool's lifecycle onto kinds**: `start` when a session opens, `working`
   with a short `activity` as work happens, `waiting` whenever the human must act,
   `idle` at turn end, `end` on close.
4. **Heartbeat through long silences** — anything quieter than 3 minutes gets demoted
   to idle by design.
5. **Leave secrets out of `activity` and `project`.** These strings can end up in a
   Slack status at `activity` granularity. Users can also scrub patterns client-side
   via `redactPatterns`, but the best redaction is the string you never sent.

The Claude Code and Codex adapters in
[`packages/cli/src/adapters/`](../packages/cli/src/adapters/) are the reference
implementations.
