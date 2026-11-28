import fs from "node:fs";
import pkg from "../../package.json";
import { SessionStore, formatStatus } from "@workmesh/core";
import type { SessionEvent } from "@workmesh/core";
import { CODEX_NOTIFY_HOOK_EVENT, codexDaemonEvent, codexSessionsDir, createCodexWatcher } from "../adapters/codex";
import type { CodexWatcher } from "../adapters/codex";
import { claudeProjectsDir, createWorkflowWatcher } from "../adapters/workflow";
import type { WorkflowWatcher } from "../adapters/workflow";
import { createOpenCodeWatcher, defaultOpenCodeDbPath } from "../adapters/opencode";
import type { OpenCodeWatcher } from "../adapters/opencode";
import { createGeminiWatcher, defaultGeminiDir } from "../adapters/gemini";
import type { GeminiWatcher } from "../adapters/gemini";
import { createAntigravityWatcher, defaultAntigravityDir } from "../adapters/antigravity";
import type { AntigravityWatcher } from "../adapters/antigravity";
import { createGrokWatcher, defaultGrokDir } from "../adapters/grok";
import type { GrokWatcher } from "../adapters/grok";
import { createHarnessWatcher } from "../adapters/harness";
import type { HarnessWatcher } from "../adapters/harness";
import { buildCapacityReport, readFleetStatus } from "../lib/fleet";
import { advertisedPoolModes } from "./pool-rules";
import {
  autoUpdateSettings,
  capacityShareLevel,
  delegateSettings,
  messageSettings,
  formatOptionsFromConfig,
  hubShareLevel,
  hubStickyShare,
  loadConfig,
  loadConfigSafe,
  patchReviewConfig,
  poolSettings,
  readHubConfig,
  reviewSettings,
  safeConfig,
  saveConfig,
  updateWaitHours,
} from "../lib/config";
import type { Config, HubConfig, ReviewSettings } from "../lib/config";
import { HubForwarder } from "../hub/forwarder";
import { TeamPoller } from "../hub/team";
import { CoordClient } from "../hub/coord";
import { deviceFetch } from "../hub/device-auth";
import { CoordHooks } from "./coord-hooks";
import { runCoordOp } from "./coord-ops";
import { Delegate } from "./delegate";
import { MessageConsent, CONSENT_UNAVAILABLE } from "./message-consent";
import { MessageGate } from "./messages";
import { AcceptedHere } from "./accepted-here";
import { CheckoutIndex, HandoffRunner } from "./handoff-runner";
import { NewDeviceNotices } from "./new-devices";
import { Reviews } from "./reviews";
import { selectMemories } from "./memory";
import { codexHomeOfRollout } from "../hub/agents";
import { CodexEndGuard } from "./codex-liveness";
import { codexWaker } from "./codex-wake";
import type { CoordSummary, HookMeta } from "./server";
import { readGithubLogin } from "../lib/github";
import { createDaemonSecret, mirrorLegacySecret } from "../lib/daemon-auth";
import { loadOwnershipState, saveOwnershipState } from "../lib/ownership-state";
import {
  acceptedHandoffsPath,
  checkoutsPath,
  handoffsDir,
  hubForwardStatePath,
  messagesStatePath,
  newDevicesPath,
  sessionVersionsPath,
  stateDir,
  updateCheckPath,
  updateLogPath,
} from "../lib/paths";
import { detectInstall, managerBin } from "../lib/install-method";
import type { InstallInfo } from "../lib/install-method";
import { fetchMenubarRelease, fetchRegistryInfo, npmRegistry } from "../lib/registry";
import { readUpdateState } from "../lib/update-state";
import { surfaceFingerprint } from "../lib/surface";
import { SessionVersions } from "./session-versions";
import { UpdateChecker, spawnDetachedUpdate } from "./updates";
import { removeStateFile } from "../hub/persist";
import { findRunningDaemon, takeStopRequest } from "../lib/daemon-control";
import { SERVICE_ENV, cliEntry, stableNodePath } from "../lib/service";
import { readPidFile, removePidFile, writePidFile } from "../lib/pidfile";
import { createSink } from "../sinks";
import { ClaudeLiveness, claudeConfigDir, readLiveClaudeSessions } from "./claude-liveness";
import type { ClaudeProcess } from "./claude-liveness";
import { Pusher } from "./pusher";
import { createDaemonServer } from "./server";

/** Hook events whose answer can carry context for the agent (Claude Code's and Codex's hook JSON). */
const CONTEXT_HOOKS = new Set(["SessionStart", "UserPromptSubmit", "PostToolUse", "PreToolUse"]);

/** How often the daemon checks Claude Code's session files for liveness. */
const CLAUDE_LIVENESS_INTERVAL_MS = 15_000;

export interface RunDaemonOptions {
  /** How long to wait for a daemon that is still shutting down. */
  exitWaitMs?: number;
}

/** Runs the daemon in the foreground until SIGINT/SIGTERM. */
export async function runDaemon(config: Config, opts: RunDaemonOptions = {}): Promise<void> {
  // A pidfile whose process is gone (or was reused by another program) is
  // ignored; a daemon still shutting down gets a few seconds to finish.
  let existingPid = await findRunningDaemon({ exitWaitMs: opts.exitWaitMs });
  if (existingPid !== undefined && process.env[SERVICE_ENV]) {
    // Under launchd / systemd (SPEC §24) while another daemon (a hook's, or one started by hand) has the port:
    // wait for it to go, then take over. Exiting instead would have the service restart this one every 10 s.
    console.log(`[${new Date().toISOString()}] daemon pid ${existingPid} is running; the service's daemon waits for it to exit`);
    while (existingPid !== undefined) {
      await new Promise((r) => setTimeout(r, 5000));
      existingPid = await findRunningDaemon({ exitWaitMs: 0 });
    }
  }
  if (existingPid !== undefined) {
    throw new Error(`daemon already running (pid ${existingPid}) — \`workmesh stop\` first`);
  }
  fs.mkdirSync(stateDir(), { recursive: true });

  const log = (message: string): void => {
    console.log(`[${new Date().toISOString()}] ${message}`);
  };

  const store = new SessionStore();
  const sink = createSink(config);
  // Mutable so the menu bar app / POST /config can retune formatting live; the
  // getState/getConfig closures below read these variables, not a snapshot.
  let liveConfig = config;
  let formatOpts = formatOptionsFromConfig(config);
  const pusher = new Pusher({
    store,
    sink,
    formatOpts,
    policy: config.statusPolicy,
    // Survives restarts: a crash while a foreign status was displaced must
    // still restore it. Corrupt/missing file falls back to the empty state.
    initialOwnership: loadOwnershipState(),
    persistOwnership: (state) => saveOwnershipState(state),
    debounceMs: config.debounceMs,
    log,
  });

  // Hub forward (team hub, apps/hub): runs beside the pusher, on its own timer; rebuilt
  // when `workmesh hub connect|disconnect|include|exclude` asks for a reload.
  let forwarder: HubForwarder | undefined;
  // v0.5: the team view for the menu bar (GET /relay/team), beside the forwarder.
  let teamPoller: TeamPoller | undefined;
  // v1 (SPEC §21, §23): leases, holds, claims, messages (GET /relay/sync), read by hooks from memory.
  let coord: CoordClient | undefined;
  const consent = new MessageConsent();
  // v0.6: the GitHub login `gh` reports, read once per start (the config's copy from `hub connect` until then).
  let githubLogin: string | undefined;
  let githubRead = false;
  // v0.10 (SPEC §24): Claude Code's live processes, from the liveness check below; the forwarder reports `alive`.
  const claudeOn = config.adapters.claudeCode.enabled;
  // One Claude Code config dir for liveness, the MCP caller lookup and workflows: the config's
  // (`setup --claude-dir`), else $CLAUDE_CONFIG_DIR, else ~/.claude.
  const claudeDir = config.adapters.claudeCode.configDir ?? claudeConfigDir();
  let liveClaude: Map<string, ClaudeProcess> | undefined = claudeOn ? readLiveClaudeSessions(claudeDir) : undefined;
  // v2 Delegate (SPEC §31): the settings are read from disk (at most every 2 s), so `workmesh roots|wake|handoffs`
  // apply without a restart.
  let settingsCache:
    | { at: number; v: ReturnType<typeof delegateSettings>; messages: ReturnType<typeof messageSettings>; reviews: ReviewSettings }
    | undefined;
  const readSettings = (): NonNullable<typeof settingsCache> => {
    const now = Date.now();
    if (!settingsCache || now - settingsCache.at > 2000) {
      const onDisk = loadConfigSafe();
      settingsCache = { at: now, v: delegateSettings(onDisk), messages: messageSettings(onDisk), reviews: reviewSettings(onDisk) };
    }
    return settingsCache;
  };
  const settings = (): ReturnType<typeof delegateSettings> => readSettings().v;
  // Who may reach this machine's sessions (SPEC §23): its own rules, and the record of who each session wrote to.
  const messages = new MessageGate({
    coord: () => coord,
    settings: () => readSettings().messages,
    // A session's mode as its transcript last said it (SPEC §26), read beside what its last hook said.
    mirrorMode: (key) => forwarder?.modeOf(key),
    file: messagesStatePath(),
    log,
  });
  const checkouts = new CheckoutIndex(checkoutsPath());
  const runner = new HandoffRunner({
    coord: () => coord,
    settings: () => ({ ...settings(), share: liveConfig.hub ? hubShareLevel(liveConfig.hub) : "metadata", reviews: readSettings().reviews }),
    checkouts,
    dir: handoffsDir(),
    // Review exchange (SPEC §53): the team's accepted conventions and gotchas for the repo go into a review's prompt.
    reviewMemories: (repo, branch) => {
      const brief = coord?.brief();
      if (!brief) return [];
      const picked = selectMemories(brief, { repo, ...(branch ? { branch } : {}) });
      return picked ? picked.text.split("\n").slice(1).map((l) => l.replace(/^- /, "")) : [];
    },
    log,
  });
  // Review exchange (SPEC §53): the machine's review policy, PRs opened here, requests and their answers.
  const reviews = new Reviews({
    coord: () => coord,
    settings: () => readSettings().reviews,
    getSession: (key) => store.get(key),
    isShared: (key) => forwarder?.isShared(key) ?? false,
    classify: (dir) => forwarder?.classify(dir),
    reviewAgent: () => runner.reviewAgent(),
    reviewRunOf: (key) => runner.reviewRunOf(key),
    isReviewRun: (id) => runner.isReviewRun(id),
    modelOf: (key) => forwarder?.modelOf(key),
    log,
  });
  /** Codex: the home each thread lives in, from its rollout path (a `CODEX_HOME` the daemon's env may not have). */
  const codexHomes = new Map<string, string>();
  const delegate = new Delegate({
    coord: () => coord,
    getSession: (key) => store.get(key),
    isShared: (key) => forwarder?.isShared(key) ?? false,
    repoOf: (dir) => forwarder?.classify(dir)?.repo,
    settings,
    runner,
    accepted: new AcceptedHere(acceptedHandoffsPath()),
    codexWake: config.adapters.codex.enabled ? codexWaker({ log, homeOf: (id) => codexHomes.get(`codex:${id}`) }) : undefined,
    log,
  });
  /** The cwd each session last reported (the checkout index learns a repo's checkout once per session and dir). */
  const lastCwd = new Map<string, string>();
  // SPEC §47: machines that joined this person's account. Told to the person once (the log, GET /team), and kept
  // away from agents: this store is the only place the sync's list goes.
  const newDevices = new NewDeviceNotices({ file: newDevicesPath(), log });

  let auth: { url: string; bootstrap: string; fetch: typeof fetch } | undefined;
  const startForwarder = (hub: HubConfig | undefined): void => {
    const previous = forwarder;
    forwarder = undefined;
    // A forwarder being replaced (hub include/exclude/connect) hands its state over in memory.
    const carried = previous?.exportState();
    previous?.detachState();
    if (previous) void previous.stop().catch(() => {});
    teamPoller?.stop();
    teamPoller = undefined;
    coord?.stop();
    coord = undefined;
    if (!hub) {
      auth = undefined;
      // Disconnected: nothing to carry on with.
      removeStateFile(hubForwardStatePath());
      return;
    }
    if (!auth || auth.url !== hub.url || auth.bootstrap !== hub.deviceToken) {
      auth = { url: hub.url, bootstrap: hub.deviceToken, fetch: deviceFetch(hub) };
    }
    const fwd = new HubForwarder({
      url: hub.url,
      token: hub.deviceToken,
      fetchImpl: auth.fetch,
      rule: hub.project,
      // Handoffs with no repo run in Workmesh's own scratch dirs, shared so they show on the board (SPEC §31).
      includeDirs: [...hub.includeDirs, handoffsDir()],
      excludeDirs: hub.excludeDirs,
      listSessions: () => store.list(),
      getSession: (key) => store.get(key),
      log,
      share: hubShareLevel(hub),
      stickyShare: hubStickyShare(hub),
      codexSessionsDir: config.adapters.codex.sessionsDir,
      github: githubLogin ?? hub.github,
      // v0.10 liveness and persistence (SPEC §24)
      client: `workmesh/${pkg.version}`,
      statePath: hubForwardStatePath(),
      aliveOf: (s) => (s.source === "claude-code" && liveClaude?.has(s.sessionId) ? true : undefined),
      isGone: (s) => s.source === "claude-code" && liveClaude !== undefined && !liveClaude.has(s.sessionId),
      seedSessions: (list) => {
        if (store.restore(list) > 0) pusher.notify();
      },
      capacity: () => {
        const disk = loadConfigSafe();
        const share = capacityShareLevel(disk);
        if (share === "off") return undefined;
        const fleet = readFleetStatus();
        return buildCapacityReport(fleet, share, advertisedPoolModes(poolSettings(disk), fleet));
      },
    });
    if (carried) fwd.restoreState({ state: carried });
    forwarder = fwd;
    teamPoller = new TeamPoller({
      url: hub.url,
      token: hub.deviceToken,
      fetchImpl: auth.fetch,
      log,
      // A hub that serves the team view reads v0.6 structure: subagents go as their own sessions.
      onAvailability: (available) => {
        fwd.setStructured(available);
        log(available ? "hub: team view on; sending subagents as sessions" : "hub: no team view; subagents fold into their sessions");
      },
    });
    teamPoller.start();
    coord = new CoordClient({
      url: hub.url,
      token: hub.deviceToken,
      fetchImpl: auth.fetch,
      deviceId: hub.deviceId,
      person: hub.person?.name,
      personEmail: hub.person?.email,
      active: () => fwd.hasLiveShared(),
      log,
      onSync: (next, previous) => {
        // Held messages first (what waited too long is dropped), then wakes and handoffs.
        try {
          messages.sweep();
        } catch {
          // Fail open: held messages are looked at again at the next sync.
        }
        delegate.onSync(next, previous);
        // Review exchange (SPEC §53): this machine's policy to the hub, and news of reviews its sessions asked for.
        try {
          reviews.onSync(next);
        } catch {
          // Looked at again at the next sync.
        }
      },
      policy: messages,
      beforeExternalDelivery: (key, sender) => {
        if (liveConfig.messages?.confirmActions) consent.arm(key, hub.deviceId, sender);
      },
      onNewDevices: (list, hubNow) => {
        newDevices.observe(list, { board: hub.url, self: hub.deviceId, hubNow });
      },
    });
    coord.start();
    runner.start();
    if (!githubRead) {
      githubRead = true;
      void readGithubLogin().then((login) => {
        if (!login) return;
        githubLogin = login;
        forwarder?.setGithub(login);
      });
    }
    forwarder.start();
    log(`hub forward on: ${hub.url} (project ${hub.project.name}, sharing ${hubShareLevel(hub)})`);
  };

  const hidden = new Set(config.hideProjects ?? []);
  // Codex: threads whose hooks run (their notify is redundant), and SessionEnds that may be a daemon restart.
  const codexHooked = new Set<string>();
  const codexEnds = new CodexEndGuard({ apply: (e) => applyNow(e), log });
  const applyEvent = (input: SessionEvent): void => {
    let event = input;
    if (event.source === "codex") {
      const key = `codex:${event.sessionId}`;
      const hookEvent = event.detail?.hookEvent;
      if (hookEvent && hookEvent !== CODEX_NOTIFY_HOOK_EVENT) {
        if (codexHooked.size > 2000) codexHooked.clear();
        codexHooked.add(key);
      }
      const kept = codexDaemonEvent(event, { known: store.get(key) !== undefined, hooked: codexHooked.has(key) });
      if (!kept) return;
      event = kept;
      const home = codexHomeOfRollout(event.detail?.transcriptPath);
      if (home && codexHomes.get(key) !== home) {
        if (codexHomes.size > 2000) codexHomes.clear();
        codexHomes.set(key, home);
      }
      if (codexEnds.intercept(event)) return;
    }
    applyNow(event);
  };
  const applyNow = (event: SessionEvent): void => {
    // A hidden project contributes no project text anywhere, its path and
    // hook detail included.
    const clean =
      event.project !== undefined && hidden.has(event.project)
        ? { ...event, project: undefined, cwd: undefined, detail: undefined }
        : event;
    store.apply(clean);
    pusher.notify();
    forwarder?.observe(clean);
    const key = `${clean.source}:${clean.sessionId}`;
    if (clean.cwd && forwarder && lastCwd.get(key) !== clean.cwd) {
      lastCwd.set(key, clean.cwd);
      if (lastCwd.size > 2000) lastCwd.clear();
      const target = forwarder.classify(clean.cwd);
      if (target?.repo) checkouts.observe(clean.cwd, target.repo);
    }
    delegate.observe(clean);
  };

  // v1: hooks get refusals and context from the cached coordination state (never a network call).
  const coordHooks = new CoordHooks({
    coord: () => coord,
    classify: (p) => forwarder?.classify(p),
    isShared: (key) => forwarder?.isShared(key) ?? false,
    projectName: () => liveConfig.hub?.project.name,
    // v3 (SPEC §36): which memories a session started with, reported in the background (a failure is dropped).
    memoriesUsed: (key, ids) => {
      void coord?.memoryUsed(key, ids);
    },
  });
  // 0.12 (SPEC §41): sessions that started under an older Workmesh are told once, at their next hook with context.
  const sessionVersions = new SessionVersions({ file: sessionVersionsPath(), current: pkg.version, surface: surfaceFingerprint() });
  const staleNote = (event: SessionEvent, hook: string, meta: HookMeta | undefined, denied: boolean): string | undefined => {
    const key = `${event.source}:${event.sessionId}`;
    if (hook === "SessionStart") sessionVersions.observeStart(key, { source: meta?.start, version: meta?.version, surface: meta?.surface });
    if (denied || event.detail?.agentId || !CONTEXT_HOOKS.has(hook)) return undefined;
    const startedAt = event.source === "claude-code" ? liveClaude?.get(event.sessionId)?.startedAt : undefined;
    return sessionVersions.note(key, event.source, startedAt);
  };
  const applyHookEvent = (event: SessionEvent, hook: string, meta?: HookMeta) => {
    // The hook names the session's permission mode: known before any message is handed to it (SPEC §23).
    messages.observe(event);
    let deny: string | undefined;
    try {
      deny = coordHooks.refuse(event, hook);
    } catch {
      deny = undefined; // fail open
    }
    if (!deny) {
      try {
        // v2: an action this person gated waits for an approval (SPEC §31).
        deny = delegate.gateRefusal(event, hook);
      } catch {
        deny = undefined; // fail open
      }
    }
    if (!deny) {
      // Review exchange (SPEC §53): a review run is read-only. An error here holds the call: a review never needs to
      // write, so failing closed costs it nothing.
      try {
        deny = reviews.gateRefusal(event, hook, meta?.handoff);
      } catch {
        deny = meta?.handoff && runner.isReviewRun(meta.handoff) ? "Workmesh couldn't check this call in a read-only review; it is held." : undefined;
      }
    }
    let checked: ReturnType<MessageConsent["check"]>;
    if (!deny && hook === "PreToolUse") {
      try {
        checked = consent.check(CoordHooks.agentKey(event), event.detail?.tool ?? "tool", meta?.actionDigest, coord);
      } catch {
        checked = { deny: CONSENT_UNAVAILABLE };
      }
      deny = checked?.deny;
    }
    if (deny) {
      // The tool won't run: keep the session alive, but nothing about the refused call goes anywhere.
      applyEvent({ ...event, kind: "heartbeat", activity: undefined, detail: undefined });
      log(`refused ${event.detail?.tool ?? "a tool"} in ${event.source}:${event.sessionId.slice(0, 8)}: ${deny.slice(0, 80)}`);
    } else {
      applyEvent(event);
      if (forwarder?.isShared(`${event.source}:${event.sessionId}`)) coord?.poke();
    }
    const context = coordHooks.answer(event, hook, deny);
    const answer = checked ? { ...context, ...checked, consentChecked: true } : context;
    let note: string | undefined;
    try {
      note = staleNote(event, hook, meta, deny !== undefined);
    } catch {
      note = undefined; // fail open
    }
    // Review exchange (SPEC §53): a PR this session just opened or made ready can get an agent review.
    let offer: string | undefined;
    try {
      offer = deny === undefined ? reviews.afterTool(event, hook) : undefined;
    } catch {
      offer = undefined;
    }
    if (offer) note = note ? `${note}\n\n${offer}` : offer;
    if (!note) return answer;
    return { ...answer, context: answer?.context ? `${note}\n\n${answer.context}`.slice(0, 9500) : note };
  };

  /** v1: holds on this machine's agents and messages waiting for them, for the menu bar. */
  const coordSummary = (): CoordSummary | undefined => {
    if (!coord) return undefined;
    const view = coord.view();
    const nameOf = (local: string | undefined): string | undefined =>
      local ? store.get(CoordClient.family(local))?.name : undefined;
    const holds: CoordSummary["holds"] = [];
    for (const h of view.state?.holds ?? []) {
      const local = coord.localKey(h.sessionKey);
      if (local === undefined || !coord.holdFor(local)) continue;
      holds.push({ session: local, name: nameOf(local), by: h.by, reason: h.reason, since: h.since });
    }
    const unread = coord
      .inboxItems()
      .filter((m) => !m.delivered && !m.held)
      .map((m) => ({
        id: m.id,
        session: m.localKey,
        name: nameOf(m.localKey),
        from: m.from.person,
        fromSession: m.from.sessionName,
        // Where the hub made it from, when no paired machine sent it (a Linear prompt).
        ...(m.via ? { via: m.via } : {}),
        text: m.text.slice(0, 500),
        ts: m.ts,
        delivered: m.delivered,
      }));
    // Held for the person: at most 50 rows, each with the start of its cleaned text.
    const held = messages
      .heldMessages(nameOf)
      .slice(0, 50)
      .map((m) => ({ ...m, text: m.text.slice(0, 1000) }));
    return { available: view.available, holds, unread, held, waitingMessages: coord.waitingMessages };
  };

  // 0.12 (SPEC §41): what's newer, from the hub or npm; the menu bar's release; opt-in auto-update.
  let install: InstallInfo | undefined;
  const installInfo = (): InstallInfo => (install ??= detectInstall(cliEntry()));
  const runArgv = [stableNodePath(), installInfo().entry, "update"];
  const updates = new UpdateChecker({
    current: pkg.version,
    install: installInfo,
    hubLatest: () => {
      const v = teamPoller?.view();
      const latest = v?.team?.latestClient;
      return latest ? { version: latest, at: v?.fetchedAt } : undefined;
    },
    settings: () => autoUpdateSettings(loadConfigSafe()),
    waitHours: () => updateWaitHours(loadConfigSafe()),
    // The registry npm is set up with here (a mirror in ~/.npmrc counts), read when the check runs (≤ every 6 h).
    fetchNpm: async () => fetchRegistryInfo(await npmRegistry(managerBin("npm"))),
    ...(process.platform === "darwin" ? { fetchMenubar: () => fetchMenubarRelease() } : {}),
    // The version the check found old enough, by name: `latest` may have moved on to a newer one by the time it runs.
    startAuto: (to) => spawnDetachedUpdate([...runArgv, "--auto-run", "--to", to], updateLogPath()),
    lastRun: () => readUpdateState().last,
    runArgv,
    file: updateCheckPath(),
    log,
  });

  // Written before listen: the file must exist by the time /health answers,
  // and a stale secret from a failed start is harmless.
  const secret = createDaemonSecret();
  mirrorLegacySecret(secret);

  const server = createDaemonServer({
    secret,
    applyEvent,
    getState: () => {
      store.sweep();
      const snapshot = store.snapshot();
      return {
        snapshot,
        formatted: formatStatus(snapshot, formatOpts),
        paused: pusher.paused,
        pausedUntil: pusher.paused ? pusher.pausedUntil : undefined,
        lastError: pusher.lastError,
      };
    },
    getLastError: () => pusher.lastError,
    getOwnership: () => pusher.ownershipSummary(),
    pause: (until) => {
      log(until === undefined ? "paused via API" : `snoozed via API until ${new Date(until).toISOString()}`);
      return pusher.pause(until);
    },
    resume: () => {
      pusher.resume();
    },
    dismiss: (key) => {
      const removed = store.remove(key);
      if (removed) {
        log(`dismissed ${key} via API`);
        pusher.notify();
      }
      return removed;
    },
    getConfig: () => safeConfig(liveConfig),
    getHub: () => (forwarder ? { enabled: true, ...forwarder.status() } : { enabled: false }),
    getTeam: (open) => {
      const hub = liveConfig.hub;
      if (!forwarder || !teamPoller || !hub) return { enabled: false };
      if (open) teamPoller.markOpen();
      const st = forwarder.status();
      const view = teamPoller.view();
      return {
        enabled: true,
        hubUrl: hub.url,
        boardUrl: hub.url,
        hubName: hub.project.name,
        deviceId: hub.deviceId,
        share: st.share,
        connected: !st.halted && st.lastSendOk === true,
        halted: st.halted || view.halted,
        available: view.available,
        fetchedAt: view.fetchedAt,
        error: view.error,
        pollMs: view.pollMs,
        team: view.team,
        coord: coordSummary(),
        delegate: delegate.summary((local) => store.get(local)?.name),
        newDevices: newDevices.active(coord?.hubNow()),
        pool: (() => {
          const disk = loadConfigSafe();
          const p = poolSettings(disk);
          return { enabled: p.enabled, rulesCount: p.rules.length, capacityShare: capacityShareLevel(disk) };
        })(),
      };
    },
    applyHookEvent,
    getUpdate: () => updates.status(),
    coordOp: (req) =>
      runCoordOp(req, {
        coord: () => coord,
        hub: () => liveConfig.hub,
        getSession: (key) => store.get(key),
        listSessions: () => store.list(),
        classify: (p) => forwarder?.classify(p),
        isShared: (key) => forwarder?.isShared(key) ?? false,
        claudeSessions: () => readLiveClaudeSessions(claudeDir),
        onAccepted: (h, by, seen) => delegate.accepted(h, by, seen),
        runHereQuestion: (h) => delegate.runHereAsk(h),
        onRunHere: (h, by) => delegate.runHere(h, by),
        runningHandoffs: () => runner.running(),
        handoffStart: (h, lead) => delegate.onAccept(h, lead),
        sent: (key, to, info) => messages.sent(key, to, info),
        reviews: {
          request: (key, args, o) => reviews.request(key, args, o),
          settings: () => reviewSettings(loadConfigSafe()),
          save: (patch) => {
            const next = patchReviewConfig(loadConfig(), patch);
            saveConfig(next);
            settingsCache = undefined;
            return reviewSettings(next);
          },
        },
        held: {
          list: () => messages.heldMessages((local) => store.get(local)?.name),
          deliver: (id) => {
            const r = messages.deliver(id);
            // An idle session with a waiter gets it now.
            if (r.ok) delegate.check();
            return r;
          },
          drop: (id) => messages.drop(id),
        },
      }),
    wakeWait: (session, timeoutMs, signal) => delegate.wait(session, timeoutMs, signal),
    dismissNewDevice: (id) => {
      const removed = newDevices.dismiss(id);
      if (removed) log("new machine notice dismissed via API");
      return removed;
    },
    reloadHub: () => {
      const hub = readHubConfig();
      if (hub === "unreadable") throw new Error("config file is unreadable — hub settings unchanged");
      liveConfig = { ...liveConfig, hub };
      startForwarder(hub);
      if (!hub) log("hub forward off");
      return forwarder ? { enabled: true, ...forwarder.status() } : { enabled: false };
    },
    setConfig: (patch) => {
      // `workmesh hub …` writes the hub section while the daemon runs: take
      // it from disk so saving a live patch never drops a pairing.
      const hubOnDisk = readHubConfig();
      const onDisk = hubOnDisk === "unreadable" ? liveConfig : loadConfigSafe();
      liveConfig = {
        ...liveConfig,
        ...patch,
        hub: hubOnDisk === "unreadable" ? liveConfig.hub : hubOnDisk,
        // v2 sections the CLI writes while the daemon runs (roots, wake, gates, who may reach a session).
        handoffs: onDisk.handoffs,
        wake: onDisk.wake,
        messages: onDisk.messages,
        gates: onDisk.gates,
        reviews: onDisk.reviews,
        update: onDisk.update,
        capacity: onDisk.capacity,
        pool: onDisk.pool,
      };
      formatOpts = formatOptionsFromConfig(liveConfig);
      pusher.applyConfig(formatOpts, liveConfig.statusPolicy);
      saveConfig(liveConfig);
      log(`config updated via API: ${Object.keys(patch).join(", ") || "(none)"}`);
      return safeConfig(liveConfig);
    },
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  // Only now — after the sink was created and the port is bound — claim the
  // pidfile: a failed or racing start must never clobber the live daemon's.
  writePidFile(process.pid);

  try {
    pusher.start();
    startForwarder(config.hub);
    updates.start();

    let watcher: CodexWatcher | undefined;
    const sessionsDir = config.adapters.codex.sessionsDir ?? codexSessionsDir();
    // Codex makes its sessions dir at its first run, which may come after the daemon started (a new install, or a
    // daemon kept running by launchd): look again every minute until it is there.
    let codexDirTimer: ReturnType<typeof setInterval> | undefined;
    const watchCodex = (): boolean => {
      if (watcher || !fs.existsSync(sessionsDir)) return watcher !== undefined;
      watcher = createCodexWatcher(sessionsDir, applyEvent, log);
      log(`watching codex sessions in ${sessionsDir}`);
      return true;
    };
    if (config.adapters.codex.enabled && !watchCodex()) {
      codexDirTimer = setInterval(() => {
        if (watchCodex() && codexDirTimer) clearInterval(codexDirTimer);
      }, 60_000);
      codexDirTimer.unref?.();
    }

    let wfWatcher: WorkflowWatcher | undefined;
    const projectsDir = config.adapters.workflow.projectsDir ?? claudeProjectsDir(claudeDir);
    if (config.adapters.workflow.enabled && fs.existsSync(projectsDir)) {
      wfWatcher = createWorkflowWatcher(projectsDir, applyEvent, log);
      log(`watching Claude Code workflows in ${projectsDir}`);
    }

    let ocWatcher: OpenCodeWatcher | undefined;
    if (config.adapters.opencode?.enabled !== false) {
      const ocDb = config.adapters.opencode?.dbPath ?? defaultOpenCodeDbPath();
      ocWatcher = createOpenCodeWatcher({ dbPath: ocDb, onEvent: applyEvent, log });
      if (fs.existsSync(ocDb)) log(`watching OpenCode sessions in ${ocDb}`);
    }

    let geminiWatcher: GeminiWatcher | undefined;
    if (config.adapters.gemini?.enabled !== false) {
      const gDir = config.adapters.gemini?.dir ?? defaultGeminiDir();
      geminiWatcher = createGeminiWatcher({ dir: gDir, onEvent: applyEvent, log });
    }

    let agyWatcher: AntigravityWatcher | undefined;
    if (config.adapters.antigravity?.enabled !== false) {
      const agyDir = config.adapters.antigravity?.dir ?? defaultAntigravityDir();
      agyWatcher = createAntigravityWatcher({ dir: agyDir, onEvent: applyEvent, log });
    }

    let grokWatcher: GrokWatcher | undefined;
    if (config.adapters.grok?.enabled !== false) {
      const grokDir = config.adapters.grok?.dir ?? defaultGrokDir();
      grokWatcher = createGrokWatcher({ dir: grokDir, onEvent: applyEvent, log });
    }

    let harnessWatcher: HarnessWatcher | undefined;
    if (config.adapters.harness?.enabled !== false) {
      harnessWatcher = createHarnessWatcher({ onEvent: applyEvent, log });
    }

    // End Claude Code sessions whose process died without a SessionEnd, keep
    // ones Claude Code reports busy from going stale mid tool call, and pick
    // up session names for the menu bar.
    let livenessTimer: NodeJS.Timeout | undefined;
    if (config.adapters.claudeCode.enabled) {
      const liveness = new ClaudeLiveness();
      const checkLiveness = (): void => {
        const now = Date.now();
        const live = readLiveClaudeSessions(claudeDir);
        liveClaude = live;
        const actions = liveness.step(store.list(), live, now);
        for (const [key, name] of actions.names) store.annotate(key, { name });
        for (const key of actions.touch) store.touch(key, now);
        for (const key of actions.reap) {
          store.remove(key);
          delegate.sessionGone(key);
          log(`ended ${key}: its Claude Code process is gone`);
        }
        if (actions.reap.length > 0) pusher.notify();
      };
      livenessTimer = setInterval(checkLiveness, CLAUDE_LIVENESS_INTERVAL_MS);
      livenessTimer.unref();
    }

    log(
      `Workmesh daemon listening on 127.0.0.1:${config.port} (sink: ${sink.name}, granularity: ${config.granularity}, statusPolicy: ${config.statusPolicy})`,
    );

    let shuttingDown = false;
    const shutdown = (signal: string): void => {
      if (shuttingDown) return;
      shuttingDown = true;
      log(`${signal} received — clearing status and shutting down`);
      void (async () => {
        if (livenessTimer) clearInterval(livenessTimer);
        updates.stop();
        sessionVersions.flush();
        messages.flush();
        if (codexDirTimer) clearInterval(codexDirTimer);
        codexEnds.stop();
        server.close();
        try {
          await watcher?.close();
          await wfWatcher?.close();
          ocWatcher?.stop();
          geminiWatcher?.stop();
          agyWatcher?.stop();
          grokWatcher?.stop();
          harnessWatcher?.stop();
        } catch {
          // best effort
        }
        try {
          teamPoller?.stop();
          coord?.stop();
          runner.stop();
          checkouts.save();
          await Promise.all([pusher.shutdown(), forwarder?.stop()]);
        } catch {
          // best effort
        }
        // Only our own claim: a daemon started right after ours closed its
        // port may already have written its pid.
        if (readPidFile() === process.pid) removePidFile();
        // Under launchd / systemd (SPEC §24): a SIGTERM that isn't `workmesh stop` (a kill, a crash
        // handler) exits non-zero, so the service brings the daemon back.
        const stopped = takeStopRequest(process.pid);
        process.exit(process.env[SERVICE_ENV] && signal === "SIGTERM" && !stopped ? 75 : 0);
      })();
    };
    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
    process.on("unhandledRejection", (reason) => {
      log(`unhandled rejection: ${String(reason)}`);
    });
  } catch (err) {
    // Startup failed after the pidfile was claimed — clean up, but only our
    // own claim (a concurrent daemon may have re-written it).
    if (readPidFile() === process.pid) removePidFile();
    throw err;
  }
}
