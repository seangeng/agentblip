# agentblip

Your Slack status, synced with your local AI agent sessions. Each Claude Code, Codex, or custom agent session becomes a blip on your team's radar: `claude agent working`, `3 agents working`, `claude: finalizing CI/CD`.

```sh
npm install -g agentblip
agentblip setup            # pair with Slack, pick a privacy level, install hooks
agentblip start --detach   # run the sync daemon
agentblip status           # see live sessions and what your status would say
```

Privacy by construction: the local daemon is the only thing that sees raw session data — the relay only ever receives the final pre-formatted status text. Granularity levels (`off` / `presence` / `count` / `activity`) control how much your status reveals, and a rolling expiration auto-clears your status if the daemon dies.

Docs, self-hosting, and source: [agentblip.com](https://agentblip.com) · [github.com/seangeng/agentblip](https://github.com/seangeng/agentblip)

MIT © Sean Geng
