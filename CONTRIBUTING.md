# Contributing to agentblip

Thanks for helping. This is a small, sharp codebase — the goal is to keep it that way.

## Dev setup

Node.js 20+ (CI runs 22):

```bash
git clone https://github.com/seangeng/agentblip.git
cd agentblip
npm ci
npm run dev        # Worker + React Router site (relay + landing/pair pages)
```

CLI development:

```bash
npm run dev -w packages/cli        # tsup watch
node packages/cli/dist/index.js    # run the built CLI
```

## Layout

```
workers/app.ts     Worker entry: Hono /api + React Router SSR catch-all
src/               Worker backend — api/ (pair, slack oauth, status, health),
                   lib/ (kv store, slack client, token crypto, rate limit)
app/               React Router v7 site (landing, /pair, privacy)
packages/core/     @agentblip/core — zod wire contracts (events.ts), session
                   aggregation (aggregate.ts), status formatting (format.ts).
                   The shared contract: CLI and Worker both import from here.
packages/cli/      the `agentblip` npm package — daemon, commands,
                   adapters (claude-code, codex), sinks (relay, slack, console)
docs/              SELF_HOSTING.md, INTEGRATIONS.md, slack-app-manifest.json
```

## Checks

```bash
npm run typecheck   # RR typegen + tsc -b + all workspaces
npm test            # vitest across workspaces + worker units
npm run build       # Worker/site build
npm run build -w agentblip   # CLI build
```

All four must pass — CI runs exactly these.

## PRs

- Keep them focused; one change per PR.
- New logic in `packages/core` or `src/lib` gets vitest coverage.
- TypeScript strict, no `any`. Zod v4 for anything crossing a wire.
- Wire-contract changes live in `packages/core/src/events.ts` and must update both
  sides (CLI + Worker) in the same PR.
- Update the docs when behavior changes — README, INTEGRATIONS, SELF_HOSTING.
- The privacy invariant is non-negotiable: the relay only ever receives a
  pre-formatted `SlackStatus` (text, emoji, expiration). PRs that send session,
  project, or tool data past the daemon will be declined.
