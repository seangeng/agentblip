import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { stableNodePath } from "./node-path";

/**
 * The daemon as an OS service (SPEC §24): launchd on macOS, a systemd --user
 * unit on Linux. A crash or kill brings it back within seconds, a login or
 * reboot starts it, and `workmesh stop` (a clean exit) leaves it stopped until
 * the next start, hook or login. Hooks still start a daemon when none answers
 * (they ask the service to, when it is installed).
 */

export const LAUNCHD_LABEL = "org.npclabs.workmesh.daemon";

/**
 * The launchd label: `org.npclabs.workmesh.daemon`, or `WORKMESH_LAUNCHD_LABEL` for a second, separate install on one
 * Mac (a test run in a temporary HOME must never replace the real daemon's job, whose label is per user, not per HOME).
 */
export function launchdLabel(env: NodeJS.ProcessEnv = process.env): string {
  const v = env.WORKMESH_LAUNCHD_LABEL;
  return v && /^[A-Za-z0-9][\w.-]{2,100}$/.test(v) ? v : LAUNCHD_LABEL;
}
export const SYSTEMD_UNIT = "workmesh.service";
/** Set in the service's environment so the daemon knows it runs under the service manager. */
export const SERVICE_ENV = "WORKMESH_SERVICE";

export type ServiceKind = "launchd" | "systemd";

export interface ServiceStatus {
  kind: ServiceKind | null;
  /** Linux: what systemd can do for this user (absent elsewhere). */
  systemd?: SystemdUser;
  /** The plist or unit file exists. */
  installed: boolean;
  /** The service manager has it loaded. */
  loaded: boolean;
  /** Its running process, when the manager reports one. */
  pid?: number;
  file?: string;
  /** What the file runs: `[node, entry]`. */
  program?: string[];
}

/** Runs a service-manager command; injected in tests. Throws on a non-zero exit. */
export type Runner = (cmd: string, args: string[]) => string;

const defaultRunner: Runner = (cmd, args) =>
  execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000, env: commandEnv(cmd) });

/**
 * Linux: the user's runtime dir, where the user's systemd listens (/run/user/<uid>). A shell from `su`, `sudo -u`,
 * cron or some SSH setups has no XDG_RUNTIME_DIR even while the user manager runs (lingering), and `systemctl --user`
 * then fails with "Failed to connect to bus".
 */
export function userRuntimeDir(env: NodeJS.ProcessEnv = process.env, id = uid(), exists = fs.existsSync): string | undefined {
  if (env.XDG_RUNTIME_DIR) return env.XDG_RUNTIME_DIR;
  const dir = `/run/user/${id}`;
  return exists(dir) ? dir : undefined;
}

function commandEnv(cmd: string): NodeJS.ProcessEnv {
  if (cmd !== "systemctl" || process.env.XDG_RUNTIME_DIR) return process.env;
  const dir = userRuntimeDir();
  return dir ? { ...process.env, XDG_RUNTIME_DIR: dir } : process.env;
}

/** Linux: what systemd can do for this user's daemon. */
export interface SystemdUser {
  /** `systemctl` exists (no: a container, WSL without systemd, a minimal VM). */
  systemctl: boolean;
  /** `systemctl --user` reaches the user's service manager. */
  manager: boolean;
  /**
   * Lingering (`loginctl enable-linger`): the user's services start at boot and keep running after the last logout.
   * Off, systemd stops the daemon about 10 s after you log out of your last session (an SSH box: the board shows you
   * offline). Undefined: unknown.
   */
  linger: boolean | undefined;
  /** Why the manager can't be reached (systemctl's first error line). */
  error?: string;
}

/** The first line of a failed command's stderr (or its message). */
export function commandError(err: unknown): string {
  const e = err as { stderr?: unknown; message?: unknown } | undefined;
  const stderr = typeof e?.stderr === "string" ? e.stderr : Buffer.isBuffer(e?.stderr) ? e.stderr.toString("utf8") : "";
  const line = stderr.split("\n").map((l) => l.trim()).find(Boolean);
  return (line ?? (typeof e?.message === "string" ? e.message.split("\n")[0] : String(err))).slice(0, 200);
}

const isMissing = (err: unknown) => (err as NodeJS.ErrnoException | undefined)?.code === "ENOENT";

/** Whether `user` lingers: logind keeps a file per lingering user. */
export function lingerOf(user = os.userInfo().username, opts: { run?: Runner; lingerDir?: string } = {}): boolean | undefined {
  const dir = opts.lingerDir ?? "/var/lib/systemd/linger";
  if (fs.existsSync(path.join(dir, user))) return true;
  if (fs.existsSync(dir)) return false;
  // No linger dir (nobody ever lingered here): ask logind, which knows either way.
  try {
    const out = (opts.run ?? defaultRunner)("loginctl", ["show-user", user, "-p", "Linger", "--value"]).trim();
    if (out === "yes") return true;
    if (out === "no") return false;
  } catch (err) {
    // "not logged in or lingering": a user logind doesn't know lingers no more than one it does.
    if (!isMissing(err)) return false;
  }
  return undefined;
}

/** Linux: probes `systemctl --user` and lingering. */
export function probeSystemdUser(opts: { run?: Runner; user?: string; lingerDir?: string } = {}): SystemdUser {
  const run = opts.run ?? defaultRunner;
  try {
    run("systemctl", ["--user", "show-environment"]);
    return { systemctl: true, manager: true, linger: lingerOf(opts.user, { run, lingerDir: opts.lingerDir }) };
  } catch (err) {
    if (isMissing(err)) return { systemctl: false, manager: false, linger: undefined, error: "systemctl not found" };
    return { systemctl: true, manager: false, linger: lingerOf(opts.user, { run, lingerDir: opts.lingerDir }), error: commandError(err) };
  }
}

/**
 * Turns lingering on for this user (`loginctl enable-linger`, no password prompt): logind then starts the user's
 * manager at once and at every boot, and keeps it after logout. Most distros let a user do this for themselves;
 * elsewhere it needs `sudo loginctl enable-linger <user>`.
 */
export function enableLinger(opts: { run?: Runner } = {}): { ok: true } | { ok: false; error: string } {
  try {
    (opts.run ?? defaultRunner)("loginctl", ["--no-ask-password", "enable-linger"]);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: commandError(err) };
  }
}

/** Thrown when this machine has no service manager the daemon can use; nothing was written. */
export class ServiceUnavailableError extends Error {
  constructor(
    message: string,
    /** What the person can do about it, as a command or a sentence. */
    readonly fix?: string,
  ) {
    super(message);
    this.name = "ServiceUnavailableError";
  }
}

/** `WORKMESH_NO_SERVICE=1` turns the service off (tests; a machine that manages the daemon its own way). */
export function serviceKind(platform: NodeJS.Platform = process.platform): ServiceKind | null {
  if (process.env.WORKMESH_NO_SERVICE === "1" && platform === process.platform) return null;
  if (platform === "darwin") return "launchd";
  if (platform === "linux") return "systemd";
  return null;
}

export function launchAgentPath(home = os.homedir()): string {
  return path.join(home, "Library", "LaunchAgents", `${launchdLabel()}.plist`);
}

export function serviceLogPath(home = os.homedir()): string {
  return path.join(home, "Library", "Logs", "workmesh-daemon.log");
}

export function systemdUnitPath(home = os.homedir()): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "systemd", "user", SYSTEMD_UNIT);
}

/** The node binary a service should run (lib/node-path.ts): Homebrew's /opt/homebrew/bin/node, not its Cellar path. */
export { stableNodePath } from "./node-path";

/** The CLI entry this process runs (dist/index.js in a build). */
export function cliEntry(): string {
  return fileURLToPath(import.meta.url);
}

/** Environment the service carries over: a sane PATH (for `gh`, `harness`, `claude`, `opencode`, `qswap`) and the directories Workmesh reads. */
export function serviceEnv(node: string, env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const home = env.HOME;
  const userDirs = home ? [path.join(home, ".local", "bin"), path.join(home, ".opencode", "bin")] : [];
  const dirs = [...userDirs, path.dirname(node), "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin", "/sbin"];
  const out: Record<string, string> = { PATH: [...new Set(dirs)].join(":"), [SERVICE_ENV]: "1" };
  // HOME too (0.12): launchd gives a job the account's home, which is the same unless Workmesh runs under another HOME.
  for (const k of ["HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "WORKMESH_CONFIG", "WORKMESH_LAUNCHD_LABEL"]) {
    const v = env[k];
    if (v) out[k] = v;
  }
  return out;
}

const xml = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function renderPlist(opts: { node: string; entry: string; env: Record<string, string>; log: string }): string {
  const env = Object.entries(opts.env)
    .map(([k, v]) => `    <key>${xml(k)}</key><string>${xml(v)}</string>`)
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${xml(launchdLabel())}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${xml(opts.node)}</string>
    <string>${xml(opts.entry)}</string>
    <string>start</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
${env}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key><false/>
  </dict>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>${xml(opts.log)}</string>
  <key>StandardErrorPath</key><string>${xml(opts.log)}</string>
</dict>
</plist>
`;
}

export function renderSystemdUnit(opts: { node: string; entry: string; env: Record<string, string> }): string {
  const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  const env = Object.entries(opts.env)
    .map(([k, v]) => `Environment=${q(`${k}=${v}`)}`)
    .join("\n");
  return `[Unit]
Description=Workmesh daemon (agent sessions to your team's board and Slack status)
After=network-online.target

[Service]
ExecStart=${q(opts.node)} ${q(opts.entry)} start
${env}
Restart=on-failure
RestartSec=10

[Install]
WantedBy=default.target
`;
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : 0);
const launchdTarget = () => `gui/${uid()}/${launchdLabel()}`;

/** The ExecStart of an installed unit (node, entry), read back for doctor. */
function unitProgram(text: string): string[] | undefined {
  const m = /^ExecStart=(.*)$/m.exec(text);
  if (!m) return undefined;
  const args = [...m[1]!.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((x) => x[1]!.replace(/\\(.)/g, "$1"));
  return args.length >= 2 ? args.slice(0, 2) : undefined;
}

/** The ProgramArguments of an installed plist (node, entry), read back for doctor. */
function plistProgram(text: string): string[] | undefined {
  const m = /<key>ProgramArguments<\/key>\s*<array>([\s\S]*?)<\/array>/.exec(text);
  if (!m) return undefined;
  return [...m[1]!.matchAll(/<string>([^<]*)<\/string>/g)].map((x) => x[1]!.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&"));
}

export function serviceStatus(
  opts: { home?: string; run?: Runner; kind?: ServiceKind | null; probe?: SystemdUser; lingerDir?: string } = {},
): ServiceStatus {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    let text: string | undefined;
    try {
      text = fs.readFileSync(file, "utf8");
    } catch {
      // not installed
    }
    let loaded = false;
    let pid: number | undefined;
    if (text !== undefined) {
      try {
        const out = run("launchctl", ["print", launchdTarget()]);
        loaded = true;
        const m = /^\s*pid = (\d+)/m.exec(out);
        if (m) pid = Number(m[1]);
      } catch {
        // not loaded
      }
    }
    return { kind, installed: text !== undefined, loaded, pid, file, program: text ? plistProgram(text)?.slice(0, 2) : undefined };
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(home);
    const installed = fs.existsSync(file);
    let loaded = false;
    let pid: number | undefined;
    const systemd = opts.probe ?? probeSystemdUser({ run, lingerDir: opts.lingerDir });
    if (installed && systemd.manager) {
      try {
        const out = run("systemctl", ["--user", "show", SYSTEMD_UNIT, "-p", "ActiveState", "-p", "MainPID"]);
        loaded = /ActiveState=(active|activating|reloading)/.test(out);
        const m = /MainPID=(\d+)/.exec(out);
        if (m && m[1] !== "0") pid = Number(m[1]);
      } catch {
        // systemd --user unavailable
      }
    }
    return { kind, systemd, installed, loaded, pid, file, program: installed ? unitProgram(fs.readFileSync(file, "utf8")) : undefined };
  }
  return { kind: null, installed: false, loaded: false };
}

export interface InstallResult {
  kind: ServiceKind;
  file: string;
  /** The file was written (new or changed). */
  wrote: boolean;
}

/**
 * Writes the service file and (re)loads it, which starts the daemon. The
 * caller stops a daemon that runs outside the service first (one daemon only).
 */
export function installService(
  opts: {
    home?: string;
    run?: Runner;
    kind?: ServiceKind | null;
    node?: string;
    entry?: string;
    env?: NodeJS.ProcessEnv;
    /** How long to wait for launchd to unload the old job (tests pass 0). */
    waitMs?: number;
    /** systemd: the probe to trust (tests); default: probe now. */
    probe?: SystemdUser;
    retries?: number;
    retryDelayMs?: number;
    /**
     * launchd: always unload and load the job, never `kickstart -k` (0.12, `workmesh update`): kickstart blocks while a
     * job crash-loops (a bad build exits at once and launchd throttles it), so a rollback could never restart it.
     */
    reload?: boolean;
  } = {},
): InstallResult {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  if (!kind) throw new Error(`no service manager support on ${process.platform}`);
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  const node = opts.node ?? stableNodePath();
  const entry = opts.entry ?? cliEntry();
  const env = serviceEnv(node, opts.env);
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    const log = serviceLogPath(home);
    const text = renderPlist({ node, entry, env, log });
    const wrote = writeIfChanged(file, text);
    fs.mkdirSync(path.dirname(log), { recursive: true });
    const loaded = launchdLoaded(run);
    if (loaded && !wrote && !opts.reload) {
      // Same definition already loaded (setup or init run again): restart the job in place.
      run("launchctl", ["kickstart", "-k", launchdTarget()]);
      return { kind, file, wrote };
    }
    if (loaded) {
      // A loaded job keeps its old definition until it is unloaded. bootout returns before launchd has
      // finished, and a bootstrap that comes too early fails with "5: Input/output error".
      try {
        run("launchctl", ["bootout", launchdTarget()]);
      } catch {
        // already going
      }
      waitFor(() => !launchdLoaded(run), opts.waitMs ?? 5_000);
    }
    retry(() => run("launchctl", ["bootstrap", `gui/${uid()}`, file]), opts.retries ?? 3, opts.retryDelayMs ?? 500);
    return { kind, file, wrote };
  }
  // Nothing is written unless systemd can run it: a unit file nobody loads only misleads `doctor` and `start`.
  const probe = opts.probe ?? probeSystemdUser({ run });
  if (!probe.systemctl) {
    throw new ServiceUnavailableError("no systemd on this machine", "the daemon runs in the background instead; the next agent event starts it after a reboot");
  }
  if (!probe.manager) {
    throw new ServiceUnavailableError(
      `no systemd user session (${probe.error ?? "systemctl --user failed"})`,
      "`loginctl enable-linger $USER` (or `sudo loginctl enable-linger $USER`), then `workmesh service install`",
    );
  }
  const file = systemdUnitPath(home);
  const wrote = writeIfChanged(file, renderSystemdUnit({ node, entry, env }));
  run("systemctl", ["--user", "daemon-reload"]);
  run("systemctl", ["--user", "enable", "--now", SYSTEMD_UNIT]);
  return { kind, file, wrote };
}

/** Unloads the service (stopping the daemon it runs) and removes its file. */
export function uninstallService(opts: { home?: string; run?: Runner; kind?: ServiceKind | null } = {}): boolean {
  const kind = opts.kind === undefined ? serviceKind() : opts.kind;
  const run = opts.run ?? defaultRunner;
  const home = opts.home ?? os.homedir();
  if (kind === "launchd") {
    const file = launchAgentPath(home);
    const had = fs.existsSync(file);
    try {
      run("launchctl", ["bootout", launchdTarget()]);
    } catch {
      // not loaded
    }
    fs.rmSync(file, { force: true });
    return had;
  }
  if (kind === "systemd") {
    const file = systemdUnitPath(home);
    const had = fs.existsSync(file);
    try {
      run("systemctl", ["--user", "disable", "--now", SYSTEMD_UNIT]);
    } catch {
      // not loaded
    }
    fs.rmSync(file, { force: true });
    try {
      run("systemctl", ["--user", "daemon-reload"]);
    } catch {
      // best effort
    }
    return had;
  }
  return false;
}

/**
 * Asks the service manager to start the daemon (no-op when it runs). False
 * when no service is installed or the manager refused: the caller spawns one.
 */
export function startService(opts: { home?: string; run?: Runner; kind?: ServiceKind | null } = {}): boolean {
  const st = serviceStatus(opts);
  if (!st.installed || !st.kind) return false;
  const run = opts.run ?? defaultRunner;
  try {
    if (st.kind === "launchd") {
      if (!st.loaded) run("launchctl", ["bootstrap", `gui/${uid()}`, st.file!]);
      else run("launchctl", ["kickstart", launchdTarget()]);
    } else {
      run("systemctl", ["--user", "start", SYSTEMD_UNIT]);
    }
    return true;
  } catch {
    return false;
  }
}

function launchdLoaded(run: Runner): boolean {
  try {
    run("launchctl", ["print", launchdTarget()]);
    return true;
  } catch {
    return false;
  }
}

function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Polls until `done()` or `ms` has passed (returns either way: the bootstrap after it retries). */
function waitFor(done: () => boolean, ms: number): void {
  const until = Date.now() + ms;
  while (!done() && Date.now() < until) sleepSync(100);
}

function retry<T>(fn: () => T, attempts: number, delayMs: number): T {
  for (let i = 1; ; i++) {
    try {
      return fn();
    } catch (err) {
      if (i >= attempts) throw err;
      sleepSync(delayMs);
    }
  }
}

function writeIfChanged(file: string, text: string): boolean {
  try {
    if (fs.readFileSync(file, "utf8") === text) return false;
  } catch {
    // new
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, { mode: 0o644 });
  return true;
}
