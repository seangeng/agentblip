import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { HubHandoffAccepted, HubHandoffAgent, HubReviewAgent, HubReviewResult, HubShareLevel } from "@workmesh/protocol";
import { HUB_DELEGATE_NOTE_MAX, HUB_REVIEW_AGENTS, HUB_REVIEW_ROUNDS_MAX } from "@workmesh/protocol";
import type { CoordClient } from "../hub/coord";
import type { ReviewSettings } from "../lib/config";
import { pickBestProvider, readFleetStatus } from "../lib/fleet";
import type { FleetSnapshot } from "../lib/fleet";
import { GitResolver } from "../hub/git";
import { scrubText } from "../hub/redact";
import { QUOTE_MARK, label, quoted } from "../lib/untrusted";
import type { HandoffRunnerLike } from "./delegate";
import { droppedEnvLine, handoffEnv } from "./handoff-env";
import type { HandoffPlan } from "./handoff-text";
import { postReview, prFacts, prepareReviewCheckout } from "./review-git";
import type { Run } from "./review-git";
import { parseReviewOutput, reviewComment, reviewPrompt } from "./review-text";

/**
 * v2 handoffs on this machine (docs/SPEC.md §31): an accepted handoff gets a fresh agent session. The runner finds
 * this machine's checkout of the handoff's repo (repos its sessions worked in, and `workmesh roots add <dir>`), makes
 * a git worktree on a new branch from the remote's default branch (so nobody's working tree is touched), and runs the
 * person's agent CLI headless in it: `claude -p` with a session id chosen up front (the hub links the handoff to that
 * session at `start`), or `codex exec`. The prompt goes in on standard input and the environment has no variable
 * whose name looks like a secret. The session is shared like any other in that repo, so it shows on the board.
 * At exit it reports `done` or `fail` with a short note (the agent's last words at the conversation level, else only
 * how it ended).
 *
 * Runs survive a daemon restart: each is a detached process wrapped in `sh`, which writes its exit code to a file, and
 * the runner's list is saved (0600) and re-read on start.
 */

export type HandoffAgent = HubHandoffAgent;

export interface RunnerSettings {
  /** Which agent CLI runs handoffs (default: claude when found, else codex). */
  agent?: HandoffAgent;
  /** Dirs whose repos (the dir itself, children, grandchildren) count as known checkouts. */
  roots: readonly string[];
  /** Run in a new git worktree (default true); false runs in the checkout itself. */
  worktree: boolean;
  /** Handoffs running at once on this machine (default 2). */
  maxRunning: number;
  /** Claude Code's permission mode for the headless session (default `auto`). */
  permissionMode: string;
  /** The model the agent runs on (`--model` for Claude Code, `-m` for Codex); absent: the agent's default. */
  model?: string;
  /** A run is stopped after this long (default 120 min). */
  maxMinutes: number;
  /** Variables the agent gets although their names look like secrets (`handoffs.env`; absent: none). */
  env?: readonly string[];
  /** This machine's sharing level: the done note carries the agent's last words only at `conversation`. */
  share: HubShareLevel;
  /** Review exchange (SPEC §53): which agent and model reviews run on, whether they post, how long they may take. */
  reviews?: ReviewSettings;
}

export interface RunRecord {
  id: string;
  agent: HandoffAgent;
  pid?: number;
  sessionKey?: string;
  dir: string;
  branch?: string;
  startedAt: number;
  logFile: string;
  exitFile: string;
  resultFile?: string;
  task: string;
  from: string;
  /** A review run (SPEC §53): read-only, reports a result, and its checkout is removed at the end. */
  kind?: "review";
  review?: {
    repo: string;
    pr: number;
    round: number;
    rounds: number;
    headSha?: string;
    /** Post the review on the PR when done (the reviewer opted in). */
    post: boolean;
    model?: string;
    /** The throwaway checkout (removed when the run ends). */
    checkout: string;
    /** For the comment: who asked and who ran it. */
    fromPerson: string;
    toPerson: string;
  };
}

export interface HandoffRunnerDeps {
  coord: () => CoordClient | undefined;
  settings: () => RunnerSettings;
  /** Repo → main checkout dirs this machine's sessions worked in (CheckoutIndex). */
  checkouts: CheckoutIndex;
  /** Where runs keep their logs and the saved list: `~/.local/state/workmesh/handoffs`. */
  dir: string;
  /** A session the runner started (shared from its first event: its dir is in a shared repo or the scratch dir). */
  onStarted?: (record: RunRecord) => void;
  which?: (bin: string) => string | undefined;
  spawnImpl?: typeof spawn;
  /** `git` runner (tests pass a fake). */
  git?: (args: string[], cwd: string, timeoutMs?: number) => Promise<{ ok: boolean; stdout: string; stderr: string }>;
  pathEnv?: () => Promise<string>;
  /** The daemon's own environment (tests pass their own). */
  env?: () => NodeJS.ProcessEnv;
  /**
   * Review exchange: the team's accepted memories for a repo, one line each (`[m12] convention: …`), for a review's
   * prompt. Absent or empty: none.
   */
  reviewMemories?: (repo: string, branch?: string) => string[];
  /** `gh` and `git` for a review (tests pass a fake). */
  run?: Run;
  /** Optional fleet capacity reader (defaults to qswap's fleet_status.json). */
  fleet?: () => FleetSnapshot | undefined;
  now?: () => number;
  log?: (message: string) => void;
}

const STATE_FILE = "running.json";
const POLL_MS = 5000;

/** `claude` / `codex` on this machine: PATH first, then where their installers put them. */
export function findBin(bin: string, pathEnv = process.env.PATH ?? "", home = os.homedir()): string | undefined {
  const dirs = [
    ...pathEnv.split(path.delimiter).filter(Boolean),
    path.join(home, ".local", "bin"),
    path.join(home, ".opencode", "bin"),
    path.join(home, ".claude", "local"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
    path.join(home, ".npm-global", "bin"),
    path.join(home, ".bun", "bin"),
    path.join(home, ".volta", "bin"),
  ];
  for (const d of dirs) {
    const p = path.join(d, bin);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return p;
    } catch {
      // next
    }
  }
  return undefined;
}

/** The person's login-shell PATH (a service daemon has a short one), else a sane default. */
export async function loginPath(): Promise<string> {
  const shell = process.env.SHELL && path.isAbsolute(process.env.SHELL) ? process.env.SHELL : "/bin/zsh";
  const fallback = [path.join(os.homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", process.env.PATH ?? "/usr/bin:/bin"].join(":");
  return new Promise((resolve) => {
    execFile(shell, ["-l", "-c", 'printf %s "$PATH"'], { timeout: 5000, encoding: "utf8" }, (err, stdout) => {
      const p = typeof stdout === "string" ? stdout.trim() : "";
      resolve(!err && p && !p.includes("\n") ? `${p}:${fallback}` : fallback);
    });
  });
}

function runGit(args: string[], cwd: string, timeoutMs = 60_000): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("git", args, { cwd, timeout: timeoutMs, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout ?? ""), stderr: String(stderr ?? "") });
    });
  });
}

/**
 * Where this machine's checkouts are: the main checkout of every shared repo a session worked in (saved across
 * restarts), and repos under the person's roots. No `git` subprocess: `.git` is read directly (hub/git.ts).
 */
export class CheckoutIndex {
  private readonly file: string;
  private readonly git = new GitResolver({ ttlMs: 60_000 });
  private readonly known = new Map<string, Set<string>>();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | undefined;
  private scanned: { at: number; roots: string; found: Map<string, string[]> } | undefined;

  constructor(file: string) {
    this.file = file;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const [repo, dirs] of Object.entries(raw)) {
        if (Array.isArray(dirs)) this.known.set(repo, new Set(dirs.filter((d): d is string => typeof d === "string")));
      }
    } catch {
      // none yet
    }
  }

  /** A shared session's checkout: remember its main repository. Cheap (cached `.git` reads). */
  observe(dir: string | undefined, repo: string | undefined): void {
    if (!dir || !repo || !path.isAbsolute(dir)) return;
    const info = this.git.resolve(dir);
    if (!info?.repo || info.repo !== repo) return;
    const main = info.mainRoot;
    if (main.includes(`${path.sep}.local${path.sep}state${path.sep}workmesh${path.sep}`)) return;
    let set = this.known.get(repo);
    if (!set) {
      set = new Set();
      this.known.set(repo, set);
    }
    if (set.has(main)) return;
    set.add(main);
    this.dirty = true;
    this.scheduleSave();
  }

  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = undefined;
      this.save();
    }, 1000);
    this.saveTimer.unref?.();
  }

  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const out: Record<string, string[]> = {};
      for (const [repo, dirs] of this.known) out[repo] = [...dirs].slice(-10);
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch {
      // best effort
    }
  }

  /** The repos under `roots` (each root, its children and grandchildren), cached for a minute. */
  private scan(roots: readonly string[]): Map<string, string[]> {
    const key = roots.join("\u0000");
    const now = Date.now();
    if (this.scanned && this.scanned.roots === key && now - this.scanned.at < 60_000) return this.scanned.found;
    const found = new Map<string, string[]>();
    const visit = (dir: string, depth: number): void => {
      let isRepo = false;
      try {
        isRepo = fs.existsSync(path.join(dir, ".git"));
      } catch {
        return;
      }
      if (isRepo) {
        const info = this.git.resolve(dir);
        if (info?.repo && info.root === dir) {
          const list = found.get(info.repo) ?? [];
          list.push(info.mainRoot);
          found.set(info.repo, list);
        }
        return;
      }
      if (depth >= 2) return;
      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const e of entries.slice(0, 500)) {
        if (!e.isDirectory() || e.name.startsWith(".") || e.name === "node_modules") continue;
        visit(path.join(dir, e.name), depth + 1);
      }
    };
    for (const r of roots) visit(r, 0);
    this.scanned = { at: now, roots: key, found };
    return found;
  }

  /** A main checkout of `repo` that still exists here, or undefined. */
  find(repo: string, roots: readonly string[]): string | undefined {
    const candidates = [...(this.known.get(repo) ?? []), ...(this.scan(roots).get(repo) ?? [])];
    for (const dir of candidates) {
      const info = this.git.resolve(dir);
      if (info?.repo === repo) return info.mainRoot;
    }
    return undefined;
  }

  repos(): string[] {
    return [...this.known.keys()].sort();
  }
}

/**
 * The prompt a handoff's session starts with. The sender's names, task and context go into it through
 * `lib/untrusted.ts`: a name stays on the line that carries it, and every line of the task and of the context is
 * marked. So no line of them can read as one of the lines Workmesh adds around them, and nothing a reader cannot see
 * reaches the agent. The task is still this session's task, only fenced: the rule for a teammate's message is not
 * said over it.
 */
export function handoffPrompt(
  h: HubHandoffAccepted,
  where: { repo?: string; branch?: string; base?: string; dir: string },
  agent: HandoffAgent = "claude",
): string {
  const person = label(h.from.person);
  const session = h.from.sessionName ? label(h.from.sessionName) : "";
  const from = session ? `${person} (their agent ${session})` : person;
  const lines = [
    `Workmesh handoff from ${from}. The task (every line of it starts with ${QUOTE_MARK}):`,
    "",
    quoted(h.task),
    "",
  ];
  if (h.context) lines.push(`Context from ${person} (marked the same way):`, "", quoted(h.context), "");
  const facts: string[] = [];
  if (h.issue) facts.push(`Linear issue: ${h.issue} (claim it with the workmesh \`claim\` tool).`);
  if (where.repo && where.branch) {
    facts.push(`You are in a fresh git worktree of ${where.repo} on branch ${where.branch}, made from ${where.base ?? "the default branch"} for this handoff. Commit there; push the branch and open a draft PR when the work is ready for review, unless the task says otherwise.`);
  } else if (where.repo) {
    facts.push(`You are in this machine's checkout of ${where.repo}. Someone may be working here too: commit on a new branch, never on theirs.`);
  } else {
    facts.push("You are in an empty scratch directory made for this handoff.");
  }
  if (agent === "codex" && where.repo) {
    // Codex's sandbox keeps the repo's git metadata read-only (a worktree's too): commits and pushes go through its
    // escalation, which `--approve-for-me` sends to Codex's automatic reviewer. Without the hint a model gave up.
    facts.push(
      "Codex's sandbox keeps this repo's git metadata read-only: run `git commit` and `git push` with escalated sandbox permissions and a one-line justification; Codex's automatic reviewer approves routine commits and pushes.",
    );
  }
  if (h.mode === "readonly") {
    facts.push("This handoff is READ-ONLY: inspect, research, or review only — do not edit files, commit, push, or run mutating commands.");
  }
  facts.push(
    "You run headless: nobody will answer questions here. Use the workmesh tools to coordinate (lease files before larger edits, `send` to ask a teammate).",
    `End with a short summary of what you did and what's left: it goes back to ${person}.`,
  );
  lines.push(...facts);
  return lines.join("\n");
}

/**
 * The name of a handoff's session. It is on the agent's command line, where any process can read it, so it carries
 * no task text: the issue or the handoff's short id, and the sender as a label.
 */
export function handoffSessionName(h: Pick<HubHandoffAccepted, "id" | "issue" | "from">): string {
  return `handoff ${h.issue ?? shortId(h.id)} from ${label(h.from.person, 60)}`;
}

function shortId(id: string): string {
  return id.replace(/[^A-Za-z0-9]/g, "").slice(-8).toLowerCase() || "handoff";
}

function pidAlive(pid: number | undefined): boolean {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export class HandoffRunner implements HandoffRunnerLike {
  private readonly deps: HandoffRunnerDeps;
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly records = new Map<string, RunRecord>();
  /** Ids being started (a `start` call or worktree in flight). */
  private readonly starting = new Set<string>();
  private readonly ids = new Set<string>();
  /** Review handoffs being started (before their record exists): their tool calls are a review's already. */
  private readonly startingReviews = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(deps: HandoffRunnerDeps) {
    this.deps = deps;
    this.now = deps.now ?? Date.now;
    this.log = deps.log ?? (() => {});
    this.load();
  }

  private get stateFile(): string {
    return path.join(this.deps.dir, STATE_FILE);
  }

  private load(): void {
    try {
      const raw = JSON.parse(fs.readFileSync(this.stateFile, "utf8")) as RunRecord[];
      for (const r of Array.isArray(raw) ? raw : []) {
        if (r && typeof r.id === "string" && typeof r.exitFile === "string") this.records.set(r.id, r);
      }
    } catch {
      // nothing running
    }
    this.syncIds();
  }

  private persist(): void {
    try {
      fs.mkdirSync(this.deps.dir, { recursive: true, mode: 0o700 });
      const tmp = `${this.stateFile}.tmp`;
      fs.writeFileSync(tmp, `${JSON.stringify([...this.records.values()], null, 2)}\n`, { mode: 0o600 });
      fs.renameSync(tmp, this.stateFile);
    } catch {
      // best effort
    }
  }

  private syncIds(): void {
    this.ids.clear();
    for (const id of this.records.keys()) this.ids.add(id);
    for (const id of this.starting) this.ids.add(id);
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.poll(), POLL_MS);
    this.timer.unref?.();
    this.poll();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  running(): ReadonlySet<string> {
    return this.ids;
  }

  list(): RunRecord[] {
    return [...this.records.values()];
  }

  hasRoom(): boolean {
    return this.ids.size < Math.max(0, this.deps.settings().maxRunning);
  }

  private resolveAgentBin(agent: HandoffAgent, which: (b: string) => string | undefined): { agent: HandoffAgent; bin: string; viaHarness?: string } | undefined {
    const directMap: Record<HandoffAgent, { bins: readonly string[]; harnessFallback?: string }> = {
      claude: { bins: ["claude"] },
      codex: { bins: ["codex"] },
      opencode: { bins: ["opencode"] },
      gemini: { bins: ["gemini"], harnessFallback: "gemini" },
      antigravity: { bins: ["agy"], harnessFallback: "agy" },
      grok: { bins: ["grok"], harnessFallback: "grok" },
      cursor: { bins: ["cursor-agent"], harnessFallback: "cursor" },
      copilot: { bins: ["copilot"], harnessFallback: "copilot" },
      windsurf: { bins: ["windsurf"], harnessFallback: "windsurf" },
      amp: { bins: ["amp"], harnessFallback: "amp" },
      aider: { bins: ["aider"], harnessFallback: "aider" },
      cline: { bins: ["cline"], harnessFallback: "cline" },
      harness: { bins: ["harness"] },
    };
    const entry = directMap[agent];
    if (!entry) return undefined;
    for (const b of entry.bins) {
      const bin = which(b);
      if (bin) return { agent, bin };
    }
    if (entry.harnessFallback) {
      const hrn = which("harness");
      if (hrn) return { agent, bin: hrn, viaHarness: entry.harnessFallback };
    }
    return undefined;
  }

  private agentFor(
    kind?: "review",
    h?: Pick<HubHandoffAccepted, "preferredAgent" | "taskKind" | "from">,
  ): { agent: HandoffAgent; bin: string; viaHarness?: string } | undefined {
    const which = this.deps.which ?? ((b: string) => findBin(b));
    const settings = this.deps.settings();
    if (kind === "review") {
      // 1. Explicit preferredAgent on the review handoff when valid for reviews.
      if (h?.preferredAgent && (HUB_REVIEW_AGENTS as readonly string[]).includes(h.preferredAgent)) {
        const found = this.resolveAgentBin(h.preferredAgent, which);
        if (found) return found;
      }
      // 2. Explicit review agent setting (unless set to "auto").
      const reviewPref = settings.reviews?.agent;
      if (reviewPref && reviewPref !== "auto") {
        const found = this.resolveAgentBin(reviewPref, which);
        if (found) return found;
        return undefined;
      }
      // 3. Cross-harness quota-aware routing via qswap fleet_status.json when `reviews.agent === "auto"`
      //    or when a fleet snapshot is injected via deps.fleet.
      if (reviewPref === "auto" || this.deps.fleet) {
        const fleet = this.deps.fleet ? this.deps.fleet() : readFleetStatus();
        const callerPrefix = h?.from?.sessionKey?.split(":")[0];
        const caller =
          callerPrefix === "claude-code" ? "claude" : callerPrefix && callerPrefix !== "workmesh" ? callerPrefix : undefined;
        const best = pickBestProvider(fleet, {
          taskKind: "review",
          allowed: HUB_REVIEW_AGENTS,
          ...(caller ? { caller } : {}),
        });
        if (best) {
          const found = this.resolveAgentBin(best.provider, which);
          if (found) return found;
        }
      }
      // 4. Fallback to handoffs.agent (if review-capable), then installed review CLIs.
      const fallbackHandoff =
        settings.agent && (HUB_REVIEW_AGENTS as readonly string[]).includes(settings.agent) ? settings.agent : undefined;
      const order: HandoffAgent[] = fallbackHandoff ? [fallbackHandoff] : [...HUB_REVIEW_AGENTS];
      for (const agent of order) {
        const found = this.resolveAgentBin(agent, which);
        if (found) return found;
      }
      return undefined;
    }
    // 1. Explicit preferredAgent on the handoff (e.g. from local pool matcher or `delegate` MCP tool).
    if (h?.preferredAgent) {
      const found = this.resolveAgentBin(h.preferredAgent, which);
      if (found) return found;
    }
    // 2. User-pinned agent in settings.
    if (settings.agent) {
      const found = this.resolveAgentBin(settings.agent, which);
      if (found) return found;
      return undefined;
    }
    // 3. Quota-aware routing via qswap's fleet_status.json when taskKind is provided.
    if (h?.taskKind) {
      const fleet = this.deps.fleet ? this.deps.fleet() : readFleetStatus();
      const best = pickBestProvider(fleet, { taskKind: h.taskKind });
      if (best) {
        const found = this.resolveAgentBin(best.provider, which);
        if (found) return found;
      }
    }
    // 4. Default fallback order across installed CLIs.
    for (const agent of ["claude", "codex", "opencode", "gemini", "cursor", "amp", "aider", "harness"] as const) {
      const found = this.resolveAgentBin(agent, which);
      if (found) return found;
    }
    return undefined;
  }

  cannotRun(h: HubHandoffAccepted): string | undefined {
    if (this.deps.settings().maxRunning <= 0) return "handoffs.maxRunning is 0";
    if (h.kind === "review") {
      if (this.deps.settings().reviews?.accept === "never") return "this machine runs no reviews (`workmesh reviews policy never`)";
      if (!h.repo || !h.review) return "the review names no repo or PR";
    }
    if (!this.agentFor(h.kind === "review" ? "review" : undefined, h)) {
      const settings = this.deps.settings();
      const want = h.kind === "review" ? (settings.reviews?.agent ?? settings.agent) : (h.preferredAgent ?? settings.agent);
      return want ? `no ${want} CLI found on this machine` : "no supported agent CLI (claude, codex, opencode, harness) is installed here";
    }
    // A review makes its own checkout (from this machine's checkout when it has one, else from GitHub).
    if (h.kind === "review") return undefined;
    if (h.repo && !this.deps.checkouts.find(h.repo, this.deps.settings().roots)) {
      return `no checkout of ${h.repo} here (\`workmesh roots add <dir>\` names where your repos live)`;
    }
    return undefined;
  }

  /**
   * What accepting `h` would start here, for the person to read before they accept: the agent and permission mode a
   * run would use, and where it would run. It reads the same settings as a run and starts nothing.
   */
  plan(h: HubHandoffAccepted): HandoffPlan {
    const settings = this.deps.settings();
    const picked = this.agentFor(h.kind === "review" ? "review" : undefined, h);
    const cannot = this.cannotRun(h);
    if (h.kind === "review") {
      return { ...(picked ? { agent: picked.agent } : {}), where: "review", ...(h.review ? { pr: h.review.pr } : {}), ...(cannot ? { cannot } : {}) };
    }
    return {
      ...(picked ? { agent: picked.agent } : {}),
      ...(picked?.agent === "claude" ? { permissionMode: h.mode === "readonly" ? "plan" : settings.permissionMode } : {}),
      where: !h.repo ? "scratch" : settings.worktree ? "worktree" : "checkout",
      ...(cannot ? { cannot } : {}),
    };
  }

  /** Claims the run on the hub (`start`), prepares the directory, and launches the agent. Never throws. */
  run(h: HubHandoffAccepted): void {
    if (this.ids.has(h.id)) return;
    this.starting.add(h.id);
    this.syncIds();
    void this.runUnsafe(h)
      .catch((err: unknown) => {
        this.log(`handoff ${h.id}: ${err instanceof Error ? err.message : String(err)}`);
      })
      .finally(() => {
        this.starting.delete(h.id);
        this.syncIds();
      });
  }

  private async runUnsafe(h: HubHandoffAccepted): Promise<void> {
    if (h.kind === "review") return this.runReview(h);
    const coord = this.deps.coord();
    const picked = this.agentFor(undefined, h);
    if (!coord || !picked) return;
    const settings = this.deps.settings();
    const sessionId = picked.agent === "claude" ? randomUUID() : undefined;
    const sessionKey = sessionId ? `claude-code:${sessionId}` : undefined;
    // The hub decides who runs it: the first `start` wins.
    const claim = await coord.handoff({ action: "start", id: h.id, ...(sessionKey ? { sessionKey } : {}) });
    if (!claim.ok || !claim.body.ok) {
      const why = claim.ok ? (claim.body.ok ? "" : claim.body.error) : claim.error;
      this.log(`handoff ${h.id}: not starting here (${why || "the hub said no"})`);
      return;
    }
    const fail = async (note: string): Promise<void> => {
      this.log(`handoff ${h.id}: ${note}`);
      await coord.handoff({ action: "fail", id: h.id, note: note.slice(0, HUB_DELEGATE_NOTE_MAX) });
    };

    // Where it runs.
    const runDir = path.join(this.deps.dir, shortId(h.id));
    fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
    let dir: string;
    let branch: string | undefined;
    let base: string | undefined;
    if (h.repo) {
      const checkout = this.deps.checkouts.find(h.repo, settings.roots);
      if (!checkout) return fail(`no checkout of ${h.repo} on this machine`);
      if (settings.worktree) {
        const git = this.deps.git ?? runGit;
        await git(["fetch", "--quiet", "origin"], checkout, 60_000);
        const head = await git(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], checkout, 10_000);
        base = head.ok && head.stdout.trim() ? head.stdout.trim() : "HEAD";
        branch = `workmesh/handoff-${shortId(h.id)}`;
        dir = `${checkout}-handoff-${shortId(h.id)}`;
        const add = await git(["worktree", "add", "-b", branch, dir, base], checkout, 60_000);
        if (!add.ok) {
          // A second try (a retried handoff) reuses the branch and directory if they are there.
          if (!fs.existsSync(dir)) return fail(`git worktree add failed: ${add.stderr.trim().split("\n").pop() ?? "error"}`);
        }
      } else {
        dir = checkout;
      }
    } else {
      dir = path.join(runDir, "work");
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    }

    const prompt = handoffPrompt(h, { repo: h.repo, branch, base, dir }, picked.agent);
    const logFile = path.join(runDir, "agent.log");
    const exitFile = path.join(runDir, "exit-code");
    const resultFile = path.join(runDir, "result.txt");
    // The prompt goes to the agent on standard input, from a file only this user can read. On the command line any
    // process on the machine could read the task in the process list.
    const promptFile = path.join(runDir, "prompt.txt");
    try {
      fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
      fs.chmodSync(promptFile, 0o600);
    } catch {
      // The start is already claimed on the hub: say that nothing runs, rather than leave it as started.
      return fail("couldn't write the prompt file on this machine");
    }
    try {
      fs.rmSync(exitFile, { force: true });
    } catch {
      // fine
    }
    const name = handoffSessionName(h);
    const permMode = h.mode === "readonly" ? "plan" : settings.permissionMode;
    const promptArgMode =
      picked.agent === "opencode" ||
      picked.agent === "gemini" ||
      picked.agent === "cursor" ||
      picked.agent === "amp" ||
      picked.agent === "aider" ||
      picked.agent === "harness" ||
      Boolean(picked.viaHarness);
    let argv: string[];
    if (picked.agent === "claude") {
      argv = [
        picked.bin, "-p", "--session-id", sessionId!, "--output-format", "json", "--permission-mode", permMode, "--name", name,
        ...(settings.model ? ["--model", settings.model] : []),
      ];
    } else if (picked.agent === "codex") {
      argv = codexExecArgs(picked.bin, { dir, resultFile, model: settings.model, approveForMe: await codexHasApproveForMe(picked.bin) });
      if (h.mode === "readonly") argv.push("--sandbox", "read-only");
    } else if (picked.agent === "opencode") {
      argv = [
        picked.bin, "run", "--format", "json", "--auto", "--title", name,
        ...(settings.model ? ["--model", settings.model] : []),
      ];
    } else if (picked.agent === "harness" || picked.viaHarness) {
      const hAgent = picked.viaHarness ?? "codex";
      argv = [
        picked.bin, "new", hAgent, "--name", name, dir,
        ...(h.mode === "readonly" ? ["--mode", "plan"] : ["--mode", "auto"]),
        "--",
      ];
    } else if (picked.agent === "gemini") {
      argv = [
        picked.bin,
        ...(settings.model ? ["-m", settings.model] : []),
        ...(h.mode === "readonly" ? ["--sandbox"] : ["--yolo"]),
        "-p",
      ];
    } else if (picked.agent === "cursor") {
      argv = [picked.bin, "-p", ...(settings.model ? ["--model", settings.model] : [])];
    } else if (picked.agent === "amp") {
      argv = [picked.bin, "-x"];
    } else if (picked.agent === "aider") {
      argv = [picked.bin, "--yes-always", ...(settings.model ? ["--model", settings.model] : []), "--message"];
    } else {
      // Direct `agy`, `grok`, `copilot`, `windsurf`, or `cline` CLI when installed.
      argv = [picked.bin, ...(settings.model ? ["--model", settings.model] : [])];
    }
    // Build the child environment from runtime settings, provider sign-in and the owner’s explicit additions.
    const passed = handoffEnv((this.deps.env ?? (() => process.env))(), picked.agent, settings.env);
    const nextDepth = String((Number.parseInt(process.env.WORKMESH_DELEGATION_DEPTH ?? "0", 10) || 0) + 1);
    const env: NodeJS.ProcessEnv = {
      ...passed.env,
      PATH: await (this.deps.pathEnv ?? loginPath)(),
      WORKMESH_HANDOFF: h.id,
      WORKMESH_DELEGATION_DEPTH: nextDepth,
      WM_EXIT_FILE: exitFile,
      WM_PROMPT_FILE: promptFile,
    };
    delete env.CLAUDECODE;
    delete env.CLAUDE_CODE_SESSION_ID;
    delete env.CODEX_THREAD_ID;
    const out = fs.openSync(logFile, "a", 0o600);
    const input = fs.openSync(promptFile, "r");
    let pid: number | undefined;
    try {
      if (passed.dropped.length > 0) {
        // Names only, so the person can see what to add to `handoffs.env`.
        fs.writeSync(out, `${droppedEnvLine(passed.dropped)}\n`);
        this.log(`handoff ${h.id}: ${passed.dropped.length} environment variable(s) not passed to the agent (names in ${logFile})`);
      }
      const shCmd = promptArgMode
        ? '"$@" "$(cat "$WM_PROMPT_FILE")"; echo $? > "$WM_EXIT_FILE"'
        : '"$@"; echo $? > "$WM_EXIT_FILE"';
      const child = (this.deps.spawnImpl ?? spawn)("/bin/sh", ["-c", shCmd, "workmesh-handoff", ...argv], {
        cwd: dir,
        env,
        detached: true,
        stdio: [input, out, out],
      });
      child.on("error", () => {});
      child.unref();
      pid = child.pid;
    } finally {
      fs.closeSync(out);
      fs.closeSync(input);
    }
    if (!pid) return fail(`couldn't start ${picked.agent}`);
    const record: RunRecord = {
      id: h.id,
      agent: picked.agent,
      pid,
      sessionKey,
      dir,
      branch,
      startedAt: this.now(),
      logFile,
      exitFile,
      ...(picked.agent === "codex" ? { resultFile } : {}),
      task: h.task.slice(0, 200),
      from: h.from.person,
    };
    this.records.set(h.id, record);
    this.persist();
    this.log(`handoff ${h.id}: ${picked.agent} started in ${dir} (pid ${pid})`);
    this.deps.onStarted?.(record);
  }

  /** A Codex run learned its thread id (its first event): tell the hub which session it is. */
  attachSession(id: string, sessionKey: string): void {
    const r = this.records.get(id);
    if (!r || r.sessionKey) return;
    r.sessionKey = sessionKey;
    this.persist();
    void this.deps.coord()?.handoff({ action: "start", id, sessionKey });
  }

  /** Checks running handoffs: finished ones report done/fail, ones over time are stopped. */
  poll(): void {
    const coord = this.deps.coord();
    const settings = this.deps.settings();
    for (const r of [...this.records.values()]) {
      if (r.agent === "codex" && !r.sessionKey) {
        const thread = codexThreadFromLog(r.logFile);
        if (thread) this.attachSession(r.id, `codex:${thread}`);
      }
      let code: number | undefined;
      try {
        const text = fs.readFileSync(r.exitFile, "utf8").trim();
        if (text) code = Number.parseInt(text, 10);
      } catch {
        code = undefined;
      }
      const alive = pidAlive(r.pid);
      if (code === undefined && alive) {
        const limit = r.kind === "review" ? (settings.reviews?.maxMinutes ?? 30) : settings.maxMinutes;
        if (this.now() - r.startedAt > limit * 60_000 && r.pid) {
          try {
            process.kill(-r.pid, "SIGTERM");
          } catch {
            try {
              process.kill(r.pid, "SIGTERM");
            } catch {
              // gone
            }
          }
          this.log(`handoff ${r.id}: stopped after ${limit} min`);
        }
        continue;
      }
      if (!coord) continue;
      this.records.delete(r.id);
      this.persist();
      this.syncIds();
      if (r.kind === "review") {
        void this.finishReview(r, code, coord).catch((err: unknown) => this.log(`review ${r.id}: ${err instanceof Error ? err.message : String(err)}`));
        continue;
      }
      const ok = code === 0;
      const summary = settings.share === "conversation" ? resultText(r) : undefined;
      const how = code === undefined ? "the agent stopped without an exit code" : ok ? "finished" : `the agent exited ${code}`;
      const where = r.branch ? ` Branch ${r.branch}.` : "";
      const note = (summary ? `${summary}` : `${how}.${where}`).slice(0, HUB_DELEGATE_NOTE_MAX);
      this.log(`handoff ${r.id}: ${how}`);
      void coord.handoff({ action: ok ? "done" : "fail", id: r.id, ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}), note });
    }
  }

  // --- review exchange (SPEC §53) ----------------------------------------------------

  /** The review run a session is, by its key (`claude-code:<id>`, `codex:<thread>`), or undefined. */
  reviewRunOf(sessionKey: string): string | undefined {
    for (const r of this.records.values()) if (r.kind === "review" && r.sessionKey === sessionKey) return r.id;
    return undefined;
  }

  /** A handoff id is a review running here (or being started). */
  isReviewRun(id: string): boolean {
    return this.records.get(id)?.kind === "review" || this.startingReviews.has(id);
  }

  /** The agent and model this machine's reviews run on, for the review policy it tells the hub. */
  reviewAgent(): { agent?: HubReviewAgent; model?: string } {
    const picked = this.agentFor("review");
    const reviewAgent: HubReviewAgent | undefined =
      picked && (HUB_REVIEW_AGENTS as readonly string[]).includes(picked.agent)
        ? (picked.agent as HubReviewAgent)
        : undefined;
    const settings = this.deps.settings();
    const model = settings.reviews?.model ?? settings.model;
    return { ...(reviewAgent ? { agent: reviewAgent } : {}), ...(model ? { model } : {}) };
  }

  /**
   * A review handoff (SPEC §53): claims the run, makes a fresh checkout of the PR's head that can't push, and starts
   * the reviewer's agent headless in it with the review prompt, read-only: Claude Code without its edit tools, Codex
   * in its workspace sandbox with no network and no escalation, or another supported CLI (OpenCode, Gemini CLI,
   * Antigravity, Grok, Cursor, Amp) with read-only flags and the daemon's review gate.
   */
  private async runReview(h: HubHandoffAccepted): Promise<void> {
    const coord = this.deps.coord();
    const picked = this.agentFor("review", h);
    const review = h.review;
    if (!coord || !picked || !review || !h.repo) return;
    this.startingReviews.add(h.id);
    try {
      const settings = this.deps.settings();
      const rs = settings.reviews;
      const sessionId = picked.agent === "claude" ? randomUUID() : undefined;
      const sessionKey = sessionId ? `claude-code:${sessionId}` : undefined;
      const claim = await coord.handoff({ action: "start", id: h.id, ...(sessionKey ? { sessionKey } : {}) });
      if (!claim.ok || !claim.body.ok) {
        const why = claim.ok ? (claim.body.ok ? "" : claim.body.error) : claim.error;
        this.log(`review ${h.id}: not starting here (${why || "the hub said no"})`);
        return;
      }
      const fail = async (note: string): Promise<void> => {
        this.log(`review ${h.id}: ${note}`);
        await coord.handoff({ action: "fail", id: h.id, note: note.slice(0, HUB_DELEGATE_NOTE_MAX) });
      };
      const runDir = path.join(this.deps.dir, shortId(h.id));
      fs.mkdirSync(runDir, { recursive: true, mode: 0o700 });
      const checkoutDir = path.join(runDir, "checkout");
      fs.rmSync(checkoutDir, { recursive: true, force: true });
      const env0 = (this.deps.env ?? (() => process.env))();
      const pathEnv = await (this.deps.pathEnv ?? loginPath)();
      // gh and git run as the person (their own sign-in), never prompting.
      const toolEnv: NodeJS.ProcessEnv = { ...env0, PATH: pathEnv, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1" };
      const run = this.deps.run;
      const gh = findBin("gh", pathEnv) ?? "gh";
      const facts = await prFacts(h.repo, review.pr, { ...(run ? { run } : {}), gh, env: toolEnv });
      const checkout = this.deps.checkouts.find(h.repo, settings.roots);
      const prepared = await prepareReviewCheckout({
        repo: h.repo,
        pr: review.pr,
        dir: checkoutDir,
        ...(checkout ? { checkout } : {}),
        ...(facts?.headRef ? { headRef: facts.headRef } : {}),
        ...(facts?.baseRef ? { baseRef: facts.baseRef } : {}),
        ...(run ? { run } : {}),
        env: toolEnv,
      });
      if ("error" in prepared) return fail(`Couldn't check out PR #${review.pr} on this machine: ${prepared.error}`);
      const rounds = review.rounds ?? HUB_REVIEW_ROUNDS_MAX;
      let memories: string[] = [];
      try {
        memories = this.deps.reviewMemories?.(h.repo, facts?.headRef) ?? [];
      } catch {
        memories = [];
      }
      const reviewAgent: HubReviewAgent = (HUB_REVIEW_AGENTS as readonly string[]).includes(picked.agent)
        ? (picked.agent as HubReviewAgent)
        : "claude";
      const prompt = reviewPrompt(h, {
        repo: h.repo,
        pr: review.pr,
        round: review.round,
        rounds,
        headSha: prepared.headSha,
        ...(prepared.baseRef ? { baseRef: prepared.baseRef } : {}),
        ...(facts?.baseRef ? { baseName: facts.baseRef } : {}),
        ...(facts?.title ? { title: facts.title } : {}),
        ...(facts?.body ? { body: facts.body } : {}),
        ...(facts?.authorLogin ? { authorLogin: facts.authorLogin } : {}),
        files: facts?.files ?? [],
        botReviews: facts?.botReviews ?? [],
        memories,
        agent: reviewAgent,
      });
      const logFile = path.join(runDir, "agent.log");
      const exitFile = path.join(runDir, "exit-code");
      const resultFile = path.join(runDir, "result.txt");
      const promptFile = path.join(runDir, "prompt.txt");
      const schemaFile = path.join(runDir, "review-schema.json");
      try {
        fs.writeFileSync(promptFile, prompt, { mode: 0o600 });
        fs.chmodSync(promptFile, 0o600);
        fs.writeFileSync(schemaFile, `${JSON.stringify(REVIEW_OUTPUT_SCHEMA)}\n`, { mode: 0o600 });
        fs.rmSync(exitFile, { force: true });
        fs.rmSync(resultFile, { force: true });
      } catch {
        return fail("couldn't write the review's prompt on this machine");
      }
      const model = rs?.model ?? settings.model;
      const name = `review ${h.repo.split("/")[1] ?? h.repo}#${review.pr} for ${label(h.from.person, 60)}`;
      const promptArgMode =
        picked.agent === "opencode" ||
        picked.agent === "gemini" ||
        picked.agent === "cursor" ||
        picked.agent === "amp" ||
        Boolean(picked.viaHarness);
      let argv: string[];
      if (picked.agent === "claude") {
        argv = claudeReviewArgs(picked.bin, { sessionId: sessionId!, name, model });
      } else if (picked.agent === "codex") {
        argv = codexReviewArgs(picked.bin, { dir: checkoutDir, resultFile, schemaFile, model });
      } else if (picked.viaHarness) {
        argv = [picked.bin, "new", picked.viaHarness, "--name", name, checkoutDir, "--mode", "plan", "--"];
      } else if (picked.agent === "opencode") {
        argv = [picked.bin, "run", "--format", "json", "--title", name, ...(model ? ["--model", model] : [])];
      } else if (picked.agent === "gemini") {
        argv = [picked.bin, "--sandbox", ...(model ? ["-m", model] : []), "-p"];
      } else if (picked.agent === "cursor") {
        argv = [picked.bin, "-p", ...(model ? ["--model", model] : [])];
      } else if (picked.agent === "amp") {
        argv = [picked.bin, "-x"];
      } else {
        argv = [picked.bin, ...(model ? ["--model", model] : [])];
      }
      const passed = handoffEnv(env0, picked.agent, settings.env);
      const env: NodeJS.ProcessEnv = {
        ...passed.env,
        PATH: pathEnv,
        WORKMESH_HANDOFF: h.id,
        WORKMESH_REVIEW: "1",
        WM_EXIT_FILE: exitFile,
        WM_PROMPT_FILE: promptFile,
        GIT_TERMINAL_PROMPT: "0",
        GH_PROMPT_DISABLED: "1",
      };
      delete env.CLAUDECODE;
      delete env.CLAUDE_CODE_SESSION_ID;
      delete env.CODEX_THREAD_ID;
      const out = fs.openSync(logFile, "a", 0o600);
      const input = fs.openSync(promptFile, "r");
      let pid: number | undefined;
      try {
        if (passed.dropped.length > 0) fs.writeSync(out, `${droppedEnvLine(passed.dropped)}\n`);
        const shCmd = promptArgMode
          ? '"$@" "$(cat "$WM_PROMPT_FILE")"; echo $? > "$WM_EXIT_FILE"'
          : '"$@"; echo $? > "$WM_EXIT_FILE"';
        const child = (this.deps.spawnImpl ?? spawn)("/bin/sh", ["-c", shCmd, "workmesh-review", ...argv], {
          cwd: checkoutDir,
          env,
          detached: true,
          stdio: [input, out, out],
        });
        child.on("error", () => {});
        child.unref();
        pid = child.pid;
      } finally {
        fs.closeSync(out);
        fs.closeSync(input);
      }
      if (!pid) return fail(`couldn't start ${picked.agent} for the review`);
      const record: RunRecord = {
        id: h.id,
        agent: picked.agent,
        pid,
        sessionKey,
        dir: checkoutDir,
        startedAt: this.now(),
        logFile,
        exitFile,
        resultFile,
        task: `review ${h.repo}#${review.pr}`,
        from: h.from.person,
        kind: "review",
        review: {
          repo: h.repo,
          pr: review.pr,
          round: review.round,
          rounds,
          headSha: prepared.headSha,
          post: rs?.postToGitHub === true,
          ...(model ? { model } : {}),
          checkout: checkoutDir,
          fromPerson: h.from.person,
          toPerson: h.to.person,
        },
      };
      this.records.set(h.id, record);
      this.persist();
      this.syncIds();
      this.log(`review ${h.id}: ${picked.agent} reviewing ${h.repo}#${review.pr} at ${prepared.headSha.slice(0, 12)} (pid ${pid})`);
      this.deps.onStarted?.(record);
    } finally {
      this.startingReviews.delete(h.id);
    }
  }

  /** A review run ended: read its findings, post them when the reviewer opted in, report them, remove the checkout. */
  private async finishReview(r: RunRecord, code: number | undefined, coord: CoordClient): Promise<void> {
    const review = r.review;
    if (!review) return;
    const text = agentAnswer(r);
    const settings = this.deps.settings();
    try {
      if (!text || (code !== 0 && !/"findings"|```/.test(text))) {
        const how = code === undefined ? "the agent stopped without an exit code" : `the agent exited ${code}`;
        this.log(`review ${r.id}: ${how}, no findings`);
        await coord.handoff({ action: "fail", id: r.id, ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}), note: `The review didn't finish: ${how}.` });
        return;
      }
      const reviewAgent: HubReviewAgent = (HUB_REVIEW_AGENTS as readonly string[]).includes(r.agent)
        ? (r.agent as HubReviewAgent)
        : "claude";
      let result: HubReviewResult = parseReviewOutput(text, {
        agent: reviewAgent,
        ...(review.model ? { model: review.model } : {}),
        ...(review.headSha ? { headSha: review.headSha } : {}),
      });
      if (review.post && settings.reviews?.postToGitHub === true) {
        const bodyFile = path.join(path.dirname(r.logFile), "comment.md");
        try {
          fs.writeFileSync(
            bodyFile,
            reviewComment({ from: { person: review.fromPerson, sessionKey: undefined, sessionName: undefined }, to: { person: review.toPerson }, review }, result),
            { mode: 0o600 },
          );
          const pathEnv = await (this.deps.pathEnv ?? loginPath)();
          const env = { ...(this.deps.env ?? (() => process.env))(), PATH: pathEnv, GH_PROMPT_DISABLED: "1" };
          const posted = await postReview(review.repo, review.pr, bodyFile, { ...(this.deps.run ? { run: this.deps.run } : {}), gh: findBin("gh", pathEnv) ?? "gh", env });
          if (posted.ok) result = { ...result, posted: true };
          this.log(`review ${r.id}: ${posted.ok ? "posted on the PR as a comment" : `couldn't post on the PR (${posted.error ?? "gh failed"})`}`);
        } catch (err) {
          this.log(`review ${r.id}: couldn't post on the PR (${err instanceof Error ? err.message : String(err)})`);
        }
      }
      const rep = await coord.review({ action: "report", id: r.id, ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}), result });
      if (rep.ok && rep.body.ok) {
        this.log(`review ${r.id}: reported (${result.verdict}, ${result.findings.length} findings)`);
      } else {
        const why = rep.ok ? (rep.body.ok ? "" : rep.body.error) : rep.error;
        this.log(`review ${r.id}: the hub didn't take the report (${why || "no answer"}); marking it done with the summary`);
        await coord.handoff({ action: "done", id: r.id, ...(r.sessionKey ? { sessionKey: r.sessionKey } : {}), note: result.summary.slice(0, HUB_DELEGATE_NOTE_MAX) });
      }
    } finally {
      // The checkout was made for this review only, under Workmesh's own state dir.
      if (review.checkout.startsWith(this.deps.dir + path.sep)) fs.rmSync(review.checkout, { recursive: true, force: true });
    }
  }
}

/**
 * `codex exec` for a handoff (SPEC §31). Live on codex-cli 0.164 (11-25), `-s workspace-write` with approvals off let
 * a run edit files but never commit: Codex keeps the repo's git metadata read-only (a worktree's gitdir too, even
 * with `--add-dir`), and gave it no network to push. `--approve-for-me` keeps that sandbox and sends each escalation
 * (a commit, a push) to Codex's automatic reviewer, the counterpart of Claude Code's `auto` permission mode that a
 * Claude handoff runs in; the sandbox gets network access like a Claude run has. A Codex without the flag runs as
 * before.
 *
 * The prompt is not an argument: the last one is `-`, which tells `codex exec` to read the prompt from standard
 * input (its own source says so: "If not provided as an argument (or if `-` is used), instructions are read from
 * stdin").
 */
export function codexExecArgs(
  bin: string,
  o: { dir: string; resultFile: string; model?: string; approveForMe?: boolean },
): string[] {
  return [
    bin, "exec", "--json", "-C", o.dir,
    ...(o.approveForMe ? ["--approve-for-me"] : ["-s", "workspace-write"]),
    "--skip-git-repo-check", "-o", o.resultFile,
    "-c", "sandbox_workspace_write.network_access=true",
    ...(o.model ? ["-m", o.model] : []),
    "-",
  ];
}

const approveForMe = new Map<string, Promise<boolean>>();

/** Whether this codex's `exec` takes `--approve-for-me` (asked once per binary). */
export function codexHasApproveForMe(bin: string): Promise<boolean> {
  let p = approveForMe.get(bin);
  if (!p) {
    p = new Promise((resolve) => {
      execFile(bin, ["exec", "--help"], { timeout: 10_000, encoding: "utf8", maxBuffer: 1024 * 1024 }, (err, stdout) =>
        resolve(!err && String(stdout).includes("--approve-for-me")),
      );
    });
    approveForMe.set(bin, p);
  }
  return p;
}

/** The agent's last words: Claude's `--output-format json` result, or Codex's last message file; redacted. */
export function resultText(r: Pick<RunRecord, "agent" | "logFile" | "resultFile">): string | undefined {
  let raw: string | undefined;
  try {
    if (r.agent === "codex" && r.resultFile) {
      raw = fs.readFileSync(r.resultFile, "utf8");
    } else {
      const text = readTail(r.logFile, 256 * 1024);
      for (const line of text.split("\n").reverse()) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t) as { type?: unknown; result?: unknown };
          if (j.type === "result" && typeof j.result === "string") {
            raw = j.result;
            break;
          }
        } catch {
          // not this line
        }
      }
    }
  } catch {
    return undefined;
  }
  return scrubText(raw?.replace(/\s+/g, " "), { max: HUB_DELEGATE_NOTE_MAX })?.text;
}

function readTail(file: string, bytes: number): string {
  const fd = fs.openSync(file, "r");
  try {
    const size = fs.fstatSync(fd).size;
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    return buf.toString("utf8");
  } finally {
    fs.closeSync(fd);
  }
}

/** `codex exec --json`'s first event names the thread: `{"type":"thread.started","thread_id":"…"}`. */
export function codexThreadFromLog(file: string): string | undefined {
  try {
    const fd = fs.openSync(file, "r");
    try {
      const buf = Buffer.alloc(16 * 1024);
      const n = fs.readSync(fd, buf, 0, buf.length, 0);
      for (const line of buf.toString("utf8", 0, n).split("\n")) {
        const t = line.trim();
        if (!t.startsWith("{")) continue;
        try {
          const j = JSON.parse(t) as { type?: unknown; thread_id?: unknown };
          if (j.type === "thread.started" && typeof j.thread_id === "string" && /^[\w-]{8,64}$/.test(j.thread_id)) return j.thread_id;
        } catch {
          // next
        }
      }
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return undefined;
  }
  return undefined;
}

/** The only tools a Claude Code review has (SPEC §53): reading, and a shell for the commands below. */
export const REVIEW_CLAUDE_TOOLS = "Read,Grep,Glob,Bash";
/**
 * The shell commands a Claude Code review may run without asking; in `dontAsk` mode everything else is refused. They
 * read the checkout and its history. A PR's own code (its tests, its build) doesn't run outside a sandbox: Claude
 * Code reviews read, and a Codex review may run tests inside its sandbox with no network (B3-7235).
 */
export const REVIEW_CLAUDE_ALLOWED = [
  "Read",
  "Grep",
  "Glob",
  ...["git diff", "git log", "git show", "git status", "git blame", "git ls-files", "git rev-parse", "git merge-base", "git grep", "ls", "wc", "head", "tail", "cat"].map((c) => `Bash(${c}:*)`),
].join(",");

/**
 * `claude -p` for a review (SPEC §53): only the read tools and the read-only commands above (`dontAsk` refuses the
 * rest without a prompt), the person's own settings and hooks only (`--setting-sources user`: settings, hooks and MCP
 * servers in the PR's checkout don't load, so the PR can't run anything as the reviewer), and no MCP servers. The
 * prompt comes on standard input.
 */
export function claudeReviewArgs(bin: string, o: { sessionId: string; name: string; model?: string | undefined }): string[] {
  return [
    bin, "-p", "--session-id", o.sessionId, "--output-format", "json", "--permission-mode", "dontAsk",
    "--setting-sources", "user", "--strict-mcp-config", "--tools", REVIEW_CLAUDE_TOOLS, "--allowedTools", REVIEW_CLAUDE_ALLOWED,
    "--name", o.name,
    ...(o.model ? ["--model", o.model] : []),
  ];
}

/** The shape a Codex review's final answer must take (`--output-schema`): the findings the hub takes (SPEC §52). */
export const REVIEW_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["verdict", "summary", "tests", "findings"],
  properties: {
    verdict: { type: "string", enum: ["no_issues", "comments", "changes_suggested"] },
    summary: { type: "string" },
    tests: { type: "string", enum: ["passed", "failed", "not_run"] },
    findings: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "severity", "summary", "suggestion"],
        properties: {
          file: { type: ["string", "null"] },
          line: { type: ["integer", "null"] },
          severity: { type: "string", enum: ["high", "medium", "low", "nit"] },
          summary: { type: "string" },
          suggestion: { type: ["string", "null"] },
        },
      },
    },
  },
} as const;

/**
 * `codex exec` for a review (SPEC §53): the workspace sandbox (writes only inside the throwaway checkout, for tests
 * and builds), no network, no escalation (`approval_policy = "never"`: a command the sandbox refuses stays refused),
 * and the final answer in the review's JSON shape. The prompt is read from standard input (`-`).
 */
export function codexReviewArgs(bin: string, o: { dir: string; resultFile: string; schemaFile: string; model?: string | undefined }): string[] {
  return [
    bin, "exec", "--json", "-C", o.dir, "-s", "workspace-write", "-c", 'approval_policy="never"',
    "--skip-git-repo-check", "-o", o.resultFile, "--output-schema", o.schemaFile,
    ...(o.model ? ["-m", o.model] : []),
    "-",
  ];
}

/** A run's whole last answer (not cut, not redacted: the review's reader does both), or undefined. */
export function agentAnswer(r: Pick<RunRecord, "agent" | "logFile" | "resultFile">): string | undefined {
  try {
    if (r.agent === "codex" && r.resultFile) {
      const t = fs.readFileSync(r.resultFile, "utf8");
      return t.trim() ? t : undefined;
    }
    const text = readTail(r.logFile, 1024 * 1024);
    for (const line of text.split("\n").reverse()) {
      const t = line.trim();
      if (!t.startsWith("{")) continue;
      try {
        const j = JSON.parse(t) as { type?: unknown; result?: unknown; structured_output?: unknown };
        if (j.type !== "result") continue;
        if (j.structured_output && typeof j.structured_output === "object") return JSON.stringify(j.structured_output);
        if (typeof j.result === "string") return j.result;
      } catch {
        // not this line
      }
    }
    if (r.agent !== "claude") {
      // Non-Claude CLIs (OpenCode, Gemini CLI, Grok, Cursor, Amp) print their response to stdout.
      const cleaned = text
        .split("\n")
        .filter((l) => !l.startsWith("workmesh: dropped"))
        .join("\n")
        .trim();
      return cleaned || undefined;
    }
  } catch {
    return undefined;
  }
  return undefined;
}
