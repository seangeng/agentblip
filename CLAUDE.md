# CLAUDE.md — agentblip

> Single source of truth for AI-assisted development. Keep updated as work progresses.

---

## Project Overview

- **Product**: agentblip — your Slack status, synced with your local AI agent sessions. Each session is a blip on your team's radar: "claude agent working", "3 agents working", "claude: finalizing CI/CD".
- **Domain**: agentblip.com
- **Repo**: github.com/seangeng/agentblip (open source, MIT)
- **npm**: `agentblip` (CLI)
- **Status**: building
- **Last updated**: 2026-07-06

---

## Tech Stack

| Layer | Technology | Notes |
|---|---|---|
| Runtime | Cloudflare Workers | Relay backend + site, one Worker |
| API Framework | Hono | Typed `Hono<{ Bindings: Env }>` |
| Language | TypeScript | Strict mode, no `any` |
| Frontend | React Router v7 (framework mode, SSR) | `@cloudflare/vite-plugin`, landing + /pair pages |
| Styling | Tailwind CSS v4 | `@tailwindcss/vite` |
| Validation | Zod v4 | Wire contracts in `packages/core/src/events.ts` |
| Storage | Cloudflare KV only | Pairing codes (TTL) + device records. No D1, no ORM |
| CLI | Commander.js + tsup | ESM single-file bundle, published as `agentblip` |
| Tests | Vitest | Pure-logic units in core + worker lib |

---

## Architecture

```
Claude Code hooks ─┐
Codex watcher ─────┤   POST /event      ┌────────────────────┐  POST /api/status   ┌──────────────┐
Any tool (curl) ───┼──────────────────▶ │ agentblip daemon   │ ───────────────────▶│ relay Worker │──▶ Slack API
                   │  localhost:4519    │ SessionStore →     │  pre-formatted      │ (or direct   │   users.profile.set
                   └                    │ formatStatus →sink │  SlackStatus only   │  Slack sink) │
                                        └────────────────────┘                     └──────────────┘
```

- **The daemon is the only thing that sees raw session data.** The relay receives a pre-formatted `SlackStatus` (text/emoji/expiration) — nothing else. Privacy by construction.
- Slack status carries a rolling `status_expiration` (default 5 min), so a dead daemon auto-clears your status.
- Three sinks: `relay` (hosted or self-hosted Worker), `slack` (direct user token, no server), `console` (dry run).

## Project Structure

```
├── CLAUDE.md                  # ← this file (keep updated)
├── README.md                  # flagship OSS readme
├── wrangler.jsonc             # Worker config: KV STORE, custom domains, secrets docs
├── workers/app.ts             # Worker entry: Hono /api + RR7 SSR catch-all
├── src/                       # Worker backend
│   ├── env.ts                 # Env bindings/secrets types
│   ├── api/                   # Hono routes: pair, slack oauth, status, health
│   └── lib/                   # kv store, slack client, token crypto, rate limit
├── app/                       # React Router v7 (SSR)
│   ├── root.tsx
│   ├── routes.ts
│   ├── routes/                # _index (landing), pair, privacy
│   └── app.css                # Tailwind v4
├── packages/
│   ├── core/                  # @agentblip/core — shared, dependency-light (zod only)
│   │   └── src/               # events (zod wire contracts), aggregate, format, redact
│   └── cli/                   # `agentblip` npm CLI (daemon + adapters + sinks)
│       └── src/
│           ├── commands/      # setup, start, status, emit, hook, pause, unlink, doctor
│           ├── adapters/      # claude-code (hooks), codex (notify+watcher)
│           └── sinks/         # relay, slack-direct, console
├── apps/
│   └── menubar/               # native SwiftUI macOS menu bar app (thin daemon client)
│       ├── Sources/AgentblipMenuBar/  # App, AppModel(poll loop), DaemonClient, Models, StatusIcon, MenuContent
│       └── scripts/make-app.sh        # SwiftPM build → agentblip.app (LSUIElement)
└── docs/                      # SELF_HOSTING.md, INTEGRATIONS.md, slack-app-manifest
```

## API Routes (Worker)

- `GET  /api/health` — public health check
- `POST /api/pair/start` — CLI begins pairing → `{code, deviceId, pollSecret, verifyUrl}` (IP rate-limited)
- `POST /api/pair/poll` — CLI polls → `{status, deviceToken?}` (token plaintext returned once)
- `GET  /api/slack/install?code=` — redirects to Slack OAuth (user_scope: `users.profile:write,users.profile:read`)
- `GET  /api/slack/callback` — OAuth exchange, links Slack user to pending pairing
- `GET  /api/slack/status` — `Bearer ab_…` device token; returns `{readable, status}` (`statusReadResponseSchema`) — current Slack status, read transiently for the daemon's ownership decision; `readable:false` = token predates the read scope (legacy blind pushes)
- `POST /api/status` — `Bearer ab_…` device token; body `{status: SlackStatus | null}`; null clears
- `POST /api/unlink` — revoke device; body `{clear?: boolean}` (default true) decides whether to wipe the status (CLI runs the ownership plan and sends `clear:false` for foreign/restored statuses)

### Daemon loopback API (127.0.0.1:4519, bearer secret except /health)

- `GET /health` · `GET /state` · `POST /event` · `POST /pause` · `POST /resume`
- `GET /config` — token-free `safeConfig` view · `POST /config` — live-tune `granularity`/`statusPolicy`/`showProject` (validated by `liveConfigPatchSchema`, applied via `pusher.applyConfig()`, persisted). Used by the menu bar app.

Wire contracts: `packages/core/src/events.ts` (zod schemas, shared CLI ↔ Worker).

## KV Schema (binding: STORE)

- `pair:{code}` → `{deviceId, pollSecretHash, status, deviceToken?, team?}` (TTL 15 min; `deviceToken` plaintext, only during OAuth→CLI handover — single-use with a 60s delivered-grace)
- `pairdev:{deviceId}` → code (TTL 900s) — pairing-code lookup for polling
- `pairstate:{nonce}` → code (TTL 600s) — OAuth CSRF state
- `device:{sha256(token)}` → `{slackUserId, teamId, teamName, encToken, createdAt, lastSeenAt, provisional?}` (provisional until first authenticated use, 24h TTL if never used)
- `rl:{scope}:{key}:{minute}` → counter (TTL 2 min)

## Key Decisions

| Date | Decision | Rationale |
|---|---|---|
| 2026-07-06 | KV-only, no D1/Better Auth in v1 | Relay is a token store, not an app DB. Self-hosters set up 1 KV namespace + 2 secrets. Accounts/dashboard can come later |
| 2026-07-06 | CLI formats status locally; relay is dumb | Server never sees session/project/tool data — only final status text. Best privacy story for OSS |
| 2026-07-06 | Device pairing flow (code → browser → Slack OAuth → token) | No accounts needed; mirrors happyuptime CLI claim flow |
| 2026-07-06 | Slack tokens AES-GCM-encrypted in KV (`TOKEN_ENCRYPTION_KEY` secret) | KV dump alone can't leak xoxp tokens |
| 2026-07-06 | Rolling `status_expiration` (5 min default) | Dead daemon → status auto-clears; no stale "working" lies |
| 2026-07-06 | Hook/adapter events → tiny localhost HTTP API | One integration surface; Claude Code hooks, Codex, and any custom tool all speak the same `POST /event` |
| 2026-07-07 | macOS menu bar app is a thin native SwiftUI client of the daemon's loopback API (apps/menubar), NOT a reimplementation | Preserves DRY — all logic stays in core/daemon; app is presentation+control only. SwiftPM executable + make-app.sh bundle (no Xcode/pbxproj), so it builds from CLI. Needed a live `GET`/`POST /config` on the daemon so the app retunes settings without a restart |
| 2026-07-08 | Fan-out reporting: a session carries an `agents` count + `phase`; `StatusSnapshot.agentCount` = Σ agents over working sessions is what "N agents working" shows. `agentblip report` is the orchestrator wrapper | Claude Code hooks fire per session and expose no subagent/workflow count (verified live: a 10-agent workflow folds into one session). Self-reporting is the only way to make the "N agents working" headline true for ultracode/CI fan-out. Plain sessions unchanged (agentCount == working) |
| 2026-07-06 | npm workspaces (core, cli) + root Worker app | Matches newest house projects (littledemo, motioness); core stays source-only, bundled by consumers |
| 2026-07-06 | RR7 SSR framework mode | Current house standard (extractvibe, stackhooks, ogrender) |
| 2026-07-06 | Static OG image v1 (no satori) | One marketing page; not worth the wasm weight yet |
| 2026-07-06 | Daemon port 4519 | Unassigned range, no common collisions |
| 2026-07-06 | Daemon loopback API requires an auto-generated bearer secret (`~/.local/state/agentblip/daemon.secret`, 0600) on `/event` `/state` `/pause` `/resume`; `/health` open | localhost isn't a trust boundary — blocks other local users and browser-based (DNS-rebinding) event injection |
| 2026-07-06 | Pairing handover: plaintext device token only in the pair record (≤15 min, single-use + 60s delivered-grace); device records provisional (24h TTL) until first authenticated use | Keeps privacy claims strictly true; abandoned pairings self-clean |
| 2026-07-06 | Status ownership protocol: new `users.profile:read` user scope; daemon reads current status before each push, core `planStatusUpdate()` (packages/core/src/ownership.ts) decides push/restore/clear/skip; `statusPolicy: "respect"` (default) never overwrites a foreign status and resumes when it clears, `"overwrite"` saves the displaced status and restores it on clear; a manual mid-session change always wins; tokens without the read scope degrade to legacy blind pushes (`readable:false`) | agentblip must never clobber a status it didn't set; the status field is shared with the human and other apps |

## Cloudflare Resources

| Resource | Binding | Notes |
|---|---|---|
| KV | STORE | id in wrangler.jsonc (create per-deploy) |
| Var | BASE_URL | https://agentblip.com |
| Var | SLACK_CLIENT_ID | public by design |
| Secret | SLACK_CLIENT_SECRET | via wrangler secret put |
| Secret | TOKEN_ENCRYPTION_KEY | base64 32 bytes, AES-GCM |

## Development

- `npm run dev` — RR7 + Worker dev server
- `npm test` — core + worker unit tests (vitest)
- `npm run typecheck` — RR typegen + tsc -b + workspaces
- `npm run deploy` — build + wrangler deploy
- CLI dev: `npm run dev -w packages/cli` (tsup watch), `node packages/cli/dist/index.js`

## Current State

### Working (deployed to agentblip.com)
- [x] core: events/aggregate/format/redact/slack + 19 tests
- [x] Worker relay: pairing (provisional records, delivered-grace, code normalization), Slack OAuth, status API, rate limits — 52 tests
- [x] CLI: daemon (bearer-secret loopback API), claude-code + codex adapters, relay/slack/console sinks, 10 commands — 99 tests
- [x] Landing + /pair + /privacy (RR7 SSR), deployed with custom domain
- [x] GitHub github.com/seangeng/agentblip public, CI + push-to-deploy green (secrets set)
- [x] E2E smoke: daemon lifecycle + live relay pairing/auth verified

### Pending (needs Sean)
- [ ] Slack app creation from docs/slack-app-manifest.json → set SLACK_CLIENT_ID var + SLACK_CLIENT_SECRET secret, redeploy (OAuth leg untestable until then)
- [ ] npm publish of packages/cli (needs npm auth)
- [ ] www.agentblip.com DNS propagation (record created at deploy; verify)

## Work Log

### 2026-07-06 — Project start → shipped v0.1 skeleton-to-production in one day
- Named agentblip (domain bought, whois-verified); recon of house style across 12 sibling projects
- Scaffolded per house standard; core package with full unit tests
- Parallel 4-agent build (worker API / landing / CLI / docs+CI), integration pass
- 5-dimension adversarial review: 39 agents, 33 confirmed findings → all fixed (see Decisions)
- Deployed to agentblip.com (KV cb8fd24c…, secrets set; SLACK_CLIENT_SECRET is a placeholder until the Slack app exists)
- Next: Slack app creds, npm publish, real-world dogfood with Claude Code hooks
