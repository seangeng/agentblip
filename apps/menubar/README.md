# agentblip menu bar app (macOS)

A tiny native SwiftUI menu bar app — the "on-air light" for your AI agents, on
your own screen. It's a **thin client of the local daemon**: it holds no logic
of its own, just polls the daemon's loopback API and renders the blip.

```
menu bar app ──GET /state, /config──▶ agentblip daemon (127.0.0.1:4519) ──▶ Slack
            ◀──POST /pause /resume /config──
```

All the real work — session aggregation, status formatting, the ownership guard
— stays in `@agentblip/core` and the daemon. The app is presentation + control
only, so there's zero logic to keep in sync.

## What it shows

- **Menu bar blip**: hollow gray (idle) · green with a count (agents working) ·
  amber (waiting on you) · dimmed (paused / standing down) · faint (daemon off).
- **Dropdown**: the current Slack status line, a "standing down" banner when the
  ownership guard is respecting a status you set, the live session list, and
  controls — pause/resume syncing, detail level (off/presence/count/activity),
  and the overwrite-vs-respect policy. Changes apply live via the daemon's
  `POST /config` (no restart).

## Requirements

- macOS 13 (Ventura) or later — uses SwiftUI `MenuBarExtra`.
- The `agentblip` CLI installed and the daemon running (`npm i -g agentblip`,
  then `agentblip setup` / `agentblip start`). The app finds the daemon via the
  same `~/.local/state/agentblip/daemon.secret` and `~/.config/agentblip/config.json`
  the CLI uses (XDG paths respected).

## Build & run

```bash
cd apps/menubar
swift build                 # compile
./scripts/make-app.sh       # → dist/agentblip.app (a menu-bar agent, LSUIElement)
open dist/agentblip.app
```

The build is unsigned, so on first launch macOS Gatekeeper will complain —
right-click the app → **Open**, or `xattr -dr com.apple.quarantine dist/agentblip.app`.
For distribution we'd notarize it or ship a Homebrew cask (`brew install --cask agentblip`).

## Layout

```
Sources/AgentblipMenuBar/
  App.swift          # @main MenuBarExtra scene
  AppModel.swift     # poll loop + control actions (ObservableObject)
  DaemonClient.swift # authed HTTP to the loopback API
  Models.swift       # Codable mirrors of /state and /config + BlipState
  Paths.swift        # XDG-aware secret/config resolution (matches the CLI)
  StatusIcon.swift   # renders the colored blip NSImage
  MenuContent.swift  # the dropdown UI
scripts/make-app.sh  # bundles the binary into agentblip.app
```
