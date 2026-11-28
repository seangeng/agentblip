import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { OUR_COMMAND_RE } from "../lib/names";
import { codexConfigPath } from "./codex";
import { writeBackup } from "../lib/hook-files";
import { stableNodePath } from "../lib/node-path";

/**
 * Registers `workmesh mcp` with Claude Code (user scope) and Codex (docs/SPEC.md §23). Merge, never overwrite: another
 * server named `workmesh` that isn't ours is left alone, a file that doesn't parse is left alone, and the file is
 * backed up (timestamped, lib/hook-files.ts) before each change.
 */

export const MCP_SERVER_NAME = "workmesh";

/** The absolute command (GUI-launched agents don't inherit the shell's PATH), as for hooks: Node by its stable path. */
export function mcpServerCommand(): { command: string; args: string[] } {
  return { command: stableNodePath(), args: [fileURLToPath(import.meta.url), "mcp"] };
}

/**
 * Claude Code's user config for a config dir. Claude Code reads `$CLAUDE_CONFIG_DIR/.claude.json` whenever the
 * variable is set (even to `~/.claude`), else `~/.claude.json`. So: `<dir>/.claude.json`, except the default
 * `~/.claude` named while the variable is unset or points elsewhere, whose user config is `~/.claude.json`. Without a
 * dir: `$CLAUDE_CONFIG_DIR/.claude.json`, else `~/.claude.json`.
 */
export function claudeJsonPath(configDir = process.env.CLAUDE_CONFIG_DIR): string {
  const home = os.homedir();
  if (!configDir) return path.join(home, ".claude.json");
  const dir = path.resolve(configDir);
  const env = process.env.CLAUDE_CONFIG_DIR;
  if (dir === path.join(home, ".claude") && !(env && path.resolve(env) === dir)) return path.join(home, ".claude.json");
  return path.join(configDir, ".claude.json");
}

export type McpInstallResult = "installed" | "updated" | "already-installed" | "manual";

export interface McpInstallReport {
  result: McpInstallResult;
  path: string;
  /** How Claude Code's entry was written. */
  via?: "claude-cli" | "file";
  backupPath?: string;
  /** Why it was left alone (manual). */
  detail?: string;
}

export type Runner = (cmd: string, args: string[]) => { status: number | null; stdout: string; stderr: string };

const defaultRunner: Runner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: "utf8", timeout: 20_000, stdio: ["ignore", "pipe", "pipe"] });
  return { status: r.error ? null : r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
};

/** The `claude` CLI on PATH, if any. */
export function findOnPath(name: string, envPath = process.env.PATH ?? ""): string | undefined {
  for (const dir of envPath.split(path.delimiter)) {
    if (!dir) continue;
    const p = path.join(dir, name);
    try {
      fs.accessSync(p, fs.constants.X_OK);
      if (fs.statSync(p).isFile()) return p;
    } catch {
      // not here
    }
  }
  return undefined;
}

interface McpEntry {
  type?: unknown;
  command?: unknown;
  args?: unknown;
}

function isOurs(entry: unknown): boolean {
  return entry !== null && typeof entry === "object" && OUR_COMMAND_RE.test(JSON.stringify(entry)) && /\bmcp\b/.test(JSON.stringify((entry as McpEntry).args ?? ""));
}

function sameCommand(entry: McpEntry, want: { command: string; args: string[] }): boolean {
  return entry.command === want.command && JSON.stringify(entry.args ?? []) === JSON.stringify(want.args);
}

function readClaudeEntry(file: string): { exists: boolean; entry?: McpEntry; error?: string } {
  if (!fs.existsSync(file)) return { exists: false };
  try {
    const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers?: Record<string, unknown> };
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { exists: true, error: "not a JSON object" };
    const entry = doc.mcpServers?.[MCP_SERVER_NAME];
    return { exists: true, entry: entry && typeof entry === "object" ? (entry as McpEntry) : undefined };
  } catch {
    return { exists: true, error: "not valid JSON" };
  }
}

/** True when Claude Code's user config registers our MCP server (any install path). */
export function isClaudeMcpInstalled(file = claudeJsonPath()): boolean {
  const r = readClaudeEntry(file);
  return r.entry !== undefined && isOurs(r.entry);
}

/** Our MCP entry's command and args in Claude Code's user config (0.12.1: doctor checks the Node it runs). */
export function claudeMcpCommand(file = claudeJsonPath()): { command: string; args: string[] } | undefined {
  const r = readClaudeEntry(file);
  if (!r.entry || !isOurs(r.entry) || typeof r.entry.command !== "string") return undefined;
  const args = Array.isArray(r.entry.args) ? r.entry.args.filter((a): a is string => typeof a === "string") : [];
  return { command: r.entry.command, args };
}

/** Writes `text` to `file` by rename, keeping the file's mode. */
function writeAtomic(file: string, text: string): void {
  let mode = 0o600;
  try {
    mode = fs.statSync(file).mode & 0o777;
  } catch {
    // new file
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.workmesh-${process.pid}.tmp`;
  fs.writeFileSync(tmp, text, { mode });
  fs.renameSync(tmp, file);
}

/** A timestamped copy of `file` as it is now (lib/hook-files.ts), when it exists. */
function backupOnce(file: string): string | undefined {
  if (!fs.existsSync(file)) return undefined;
  return writeBackup(file, fs.readFileSync(file, "utf8"));
}

/** Takes our `workmesh` entry out of Claude Code's user config (`mcpServers`); another server by that name stays. */
export function removeClaudeMcp(file = claudeJsonPath()): { removed: boolean; path: string; backupPath?: string } {
  const current = readClaudeEntry(file);
  if (current.error || !current.entry || !isOurs(current.entry)) return { removed: false, path: file };
  const doc = JSON.parse(fs.readFileSync(file, "utf8")) as { mcpServers: Record<string, unknown> };
  delete doc.mcpServers[MCP_SERVER_NAME];
  const backupPath = backupOnce(file);
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { removed: true, path: file, backupPath };
}

export interface ClaudeMcpOptions {
  file?: string;
  /** The `claude` CLI; null = don't use it (merge the file). Default: found on PATH. */
  claudeBin?: string | null;
  run?: Runner;
}

/**
 * Claude Code, user scope. With the `claude` CLI: `claude mcp add -s user workmesh -- <node> <cli> mcp` (after
 * `claude mcp remove` when our entry points elsewhere). Without it, or when it fails: a merge into `~/.claude.json`
 * (backup first, written by rename).
 */
export function installClaudeMcp(opts: ClaudeMcpOptions = {}): McpInstallReport {
  const file = opts.file ?? claudeJsonPath();
  const want = mcpServerCommand();
  const current = readClaudeEntry(file);
  if (current.error) return { result: "manual", path: file, detail: `${file} is ${current.error}; left as is` };
  if (current.entry && !isOurs(current.entry)) {
    return { result: "manual", path: file, detail: `another MCP server named "${MCP_SERVER_NAME}" is registered; left as is` };
  }
  if (current.entry && sameCommand(current.entry, want)) return { result: "already-installed", path: file };
  const result: McpInstallResult = current.entry ? "updated" : "installed";

  const bin = opts.claudeBin === undefined ? findOnPath("claude") : opts.claudeBin;
  if (bin) {
    const run = opts.run ?? defaultRunner;
    if (current.entry) run(bin, ["mcp", "remove", "-s", "user", MCP_SERVER_NAME]);
    const r = run(bin, ["mcp", "add", "-s", "user", MCP_SERVER_NAME, "--", want.command, ...want.args]);
    if (r.status === 0 && isClaudeMcpInstalled(file)) return { result, path: file, via: "claude-cli" };
    // Fall through to the file merge.
  }

  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return { result: "manual", path: file, detail: `${file} is not a JSON object; left as is` };
    }
    doc = parsed as Record<string, unknown>;
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return { result: "manual", path: file, detail: `"mcpServers" in ${file} isn't an object; left as is` };
  }
  const next = { ...((servers as Record<string, unknown> | undefined) ?? {}) };
  next[MCP_SERVER_NAME] = { type: "stdio", command: want.command, args: want.args, env: {} };
  doc.mcpServers = next;
  const backupPath = backupOnce(file);
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { result, path: file, via: "file", backupPath };
}

// --- Codex: [mcp_servers.workmesh] in ~/.codex/config.toml ----------------------

const CODEX_TABLE_RE = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*(?:workmesh|"workmesh")[ \t]*\][ \t]*(?:#.*)?$/m;

function codexBlock(want: { command: string; args: string[] }): string {
  // JSON strings are valid TOML basic strings.
  return [
    "[mcp_servers.workmesh]",
    `command = ${JSON.stringify(want.command)}`,
    `args = [${want.args.map((a) => JSON.stringify(a)).join(", ")}]`,
  ].join("\n");
}

/** The `[mcp_servers.workmesh]` table: where it starts and ends in `text`. */
function findCodexTable(text: string): { start: number; end: number; body: string } | undefined {
  const m = CODEX_TABLE_RE.exec(text);
  if (!m) return undefined;
  const start = m.index;
  const afterHeader = start + m[0].length;
  const rest = text.slice(afterHeader);
  const next = /^[ \t]*\[/m.exec(rest.startsWith("\n") ? rest.slice(1) : rest);
  const end = next ? afterHeader + (rest.startsWith("\n") ? 1 : 0) + next.index : text.length;
  return { start, end, body: text.slice(start, end) };
}

/** True when Codex's config registers our MCP server. */
export function isCodexMcpInstalled(file = codexConfigPath()): boolean {
  try {
    const t = findCodexTable(fs.readFileSync(file, "utf8"));
    return t !== undefined && OUR_COMMAND_RE.test(t.body) && /"mcp"/.test(t.body);
  } catch {
    return false;
  }
}

/** Our `[mcp_servers.workmesh]` command and args in Codex's config.toml (they are written as JSON strings). */
export function codexMcpCommand(file = codexConfigPath()): { command: string; args: string[] } | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return undefined;
  }
  const t = findCodexTable(text);
  if (!t || !OUR_COMMAND_RE.test(t.body) || !/"mcp"/.test(t.body)) return undefined;
  const command = /^[ \t]*command[ \t]*=[ \t]*("(?:[^"\\\n]|\\.)*")/m.exec(t.body)?.[1];
  const args = /^[ \t]*args[ \t]*=[ \t]*(\[[^\n]*\])/m.exec(t.body)?.[1];
  try {
    const c = command ? (JSON.parse(command) as unknown) : undefined;
    const a = args ? (JSON.parse(args) as unknown) : [];
    if (typeof c !== "string") return undefined;
    return { command: c, args: Array.isArray(a) ? a.filter((x): x is string => typeof x === "string") : [] };
  } catch {
    return undefined;
  }
}

/** Codex: merges `[mcp_servers.workmesh]` into config.toml (backup first; another `workmesh` server is left alone). */
export function installCodexMcp(file = codexConfigPath()): McpInstallReport {
  const want = mcpServerCommand();
  const block = codexBlock(want);
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  const table = findCodexTable(text);
  if (table) {
    if (!OUR_COMMAND_RE.test(table.body) || !/"mcp"/.test(table.body)) {
      return { result: "manual", path: file, detail: `another [mcp_servers.workmesh] is configured; left as is` };
    }
    if (table.body.trimEnd() === block) return { result: "already-installed", path: file };
    const tail = text.slice(table.end);
    const next = `${text.slice(0, table.start)}${block}\n${tail.startsWith("\n") || tail === "" ? "" : "\n"}${tail}`;
    const backupPath = backupOnce(file);
    writeAtomic(file, next);
    return { result: "updated", path: file, backupPath };
  }
  // A `workmesh` key inside a plain [mcp_servers] table, or an inline `mcp_servers = { … }`, can't take a new table.
  if (/^[ \t]*mcp_servers[ \t]*=/m.test(text) || /^[ \t]*(?:"?mcp_servers"?[ \t]*\.[ \t]*)?"?workmesh"?[ \t]*[.=]/m.test(text)) {
    return { result: "manual", path: file, detail: "mcp_servers is set inline; add workmesh by hand" };
  }
  const header = "# workmesh: team coordination tools for Codex (leases, claims, messages)";
  const next = text ? `${text.replace(/\n*$/, "\n")}\n${header}\n${block}\n` : `${header}\n${block}\n`;
  const backupPath = backupOnce(file);
  writeAtomic(file, next);
  return { result: "installed", path: file, backupPath };
}

/**
 * Codex's own tables under ours (`[mcp_servers.workmesh.tools.whoami]` with `approval_mode`, written when a person
 * picks "Always allow"): left behind, they make an `mcp_servers.workmesh` with no command, and Codex then won't load
 * its config at all ("invalid transport in `mcp_servers.workmesh`", codex-cli 0.164).
 */
function removeCodexSubtables(text: string): string {
  const header = /^[ \t]*\[[ \t]*mcp_servers[ \t]*\.[ \t]*"?workmesh"?[ \t]*\.[^\]\n]*\][^\n]*(?:\n|$)/m;
  let out = text;
  for (let i = 0; i < 100; i++) {
    const m = header.exec(out);
    if (!m) break;
    const after = m.index + m[0].length;
    const next = /^[ \t]*\[/m.exec(out.slice(after));
    const end = next ? after + next.index : out.length;
    out = `${out.slice(0, m.index)}${out.slice(end)}`;
  }
  return out;
}

/** Takes our `[mcp_servers.workmesh]` table (and the comment install put above it) out of Codex's config.toml. */
export function removeCodexMcp(file = codexConfigPath()): { removed: boolean; path: string; backupPath?: string } {
  if (!fs.existsSync(file)) return { removed: false, path: file };
  const text = fs.readFileSync(file, "utf8");
  const table = findCodexTable(text);
  if (!table || !OUR_COMMAND_RE.test(table.body) || !/"mcp"/.test(table.body)) return { removed: false, path: file };
  // Install appended "\n# workmesh: …\n[mcp_servers.workmesh]…\n": take exactly that back out.
  let head = text.slice(0, table.start).replace(/# workmesh: team coordination tools for Codex[^\n]*\n$/, "");
  const tail = text.slice(table.end);
  if (tail === "" && head.endsWith("\n\n")) head = head.slice(0, -1);
  const next = removeCodexSubtables(`${head}${tail}`);
  const backupPath = backupOnce(file);
  writeAtomic(file, next);
  return { removed: true, path: file, backupPath };
}

// --- Antigravity (~/.gemini/config/mcp_config.json) & Gemini CLI (~/.gemini/settings.json) ---

export function antigravityMcpConfigPath(home = os.homedir()): string {
  return path.join(home, ".gemini", "config", "mcp_config.json");
}

export function geminiSettingsPath(home = os.homedir()): string {
  return path.join(home, ".gemini", "settings.json");
}

function readJsonMcpServersEntry(file: string): { exists: boolean; entry?: McpEntry; error?: string } {
  if (!fs.existsSync(file)) return { exists: false };
  const raw = fs.readFileSync(file, "utf8").trim();
  if (!raw) return { exists: true, entry: undefined };
  try {
    const doc = JSON.parse(raw) as { mcpServers?: Record<string, unknown> };
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return { exists: true, error: "not a JSON object" };
    const entry = doc.mcpServers?.[MCP_SERVER_NAME];
    return { exists: true, entry: entry && typeof entry === "object" ? (entry as McpEntry) : undefined };
  } catch {
    return { exists: true, error: "not valid JSON" };
  }
}

function installJsonMcpServers(file: string): McpInstallReport {
  const want = mcpServerCommand();
  const current = readJsonMcpServersEntry(file);
  if (current.error) return { result: "manual", path: file, detail: `${file} is ${current.error}; left as is` };
  if (current.entry && !isOurs(current.entry)) {
    return { result: "manual", path: file, detail: `another MCP server named "${MCP_SERVER_NAME}" is registered; left as is` };
  }
  if (current.entry && sameCommand(current.entry, want)) return { result: "already-installed", path: file };
  const result: McpInstallResult = current.entry ? "updated" : "installed";

  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      const parsed = JSON.parse(raw) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return { result: "manual", path: file, detail: `${file} is not a JSON object; left as is` };
      }
      doc = parsed as Record<string, unknown>;
    }
  }
  const servers = doc.mcpServers;
  if (servers !== undefined && (typeof servers !== "object" || servers === null || Array.isArray(servers))) {
    return { result: "manual", path: file, detail: `"mcpServers" in ${file} isn't an object; left as is` };
  }
  const next = { ...((servers as Record<string, unknown> | undefined) ?? {}) };
  next[MCP_SERVER_NAME] = { command: want.command, args: want.args };
  doc.mcpServers = next;
  const backupPath = backupOnce(file);
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { result, path: file, via: "file", backupPath };
}

export function isAntigravityMcpInstalled(file = antigravityMcpConfigPath()): boolean {
  const r = readJsonMcpServersEntry(file);
  return r.entry !== undefined && isOurs(r.entry);
}

/** Antigravity: merges `mcpServers.workmesh` into `~/.gemini/config/mcp_config.json` (handles 0-byte empty file). */
export function installAntigravityMcp(file = antigravityMcpConfigPath()): McpInstallReport {
  return installJsonMcpServers(file);
}

export function isGeminiMcpInstalled(file = geminiSettingsPath()): boolean {
  const r = readJsonMcpServersEntry(file);
  return r.entry !== undefined && isOurs(r.entry);
}

/** Gemini CLI: merges `mcpServers.workmesh` into `~/.gemini/settings.json`. */
export function installGeminiMcp(file = geminiSettingsPath()): McpInstallReport {
  return installJsonMcpServers(file);
}

// --- OpenCode (~/.config/opencode/opencode.json) -------------------------------

export function openCodeConfigPath(home = os.homedir()): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(home, ".config");
  return path.join(base, "opencode", "opencode.json");
}

interface OpenCodeMcpEntry {
  type?: unknown;
  command?: unknown;
}

function isOursOpenCode(entry: unknown): boolean {
  if (!entry || typeof entry !== "object") return false;
  const cmd = (entry as OpenCodeMcpEntry).command;
  return Array.isArray(cmd) && OUR_COMMAND_RE.test(JSON.stringify(cmd)) && cmd.includes("mcp");
}

function sameOpenCodeCommand(entry: OpenCodeMcpEntry, want: { command: string; args: string[] }): boolean {
  const wantArr = [want.command, ...want.args];
  return entry.type === "local" && JSON.stringify(entry.command ?? []) === JSON.stringify(wantArr);
}

export function isOpenCodeMcpInstalled(file = openCodeConfigPath()): boolean {
  if (!fs.existsSync(file)) return false;
  try {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (!raw) return false;
    const doc = JSON.parse(raw) as { mcp?: { servers?: Record<string, unknown> } };
    return isOursOpenCode(doc?.mcp?.servers?.[MCP_SERVER_NAME]);
  } catch {
    return false;
  }
}

/** OpenCode: merges `mcp.servers.workmesh` (`type: "local"`, `command: [node, cli, "mcp"]`) into `opencode.json`. */
export function installOpenCodeMcp(file = openCodeConfigPath()): McpInstallReport {
  const want = mcpServerCommand();
  let doc: Record<string, unknown> = {};
  if (fs.existsSync(file)) {
    const raw = fs.readFileSync(file, "utf8").trim();
    if (raw) {
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
          return { result: "manual", path: file, detail: `${file} is not a JSON object; left as is` };
        }
        doc = parsed as Record<string, unknown>;
      } catch {
        return { result: "manual", path: file, detail: `${file} is not valid JSON; left as is` };
      }
    }
  }
  const mcpObj = doc.mcp;
  if (mcpObj !== undefined && (typeof mcpObj !== "object" || mcpObj === null || Array.isArray(mcpObj))) {
    return { result: "manual", path: file, detail: `"mcp" in ${file} isn't an object; left as is` };
  }
  const mcp = { ...((mcpObj as Record<string, unknown> | undefined) ?? {}) };
  const serversObj = mcp.servers;
  if (serversObj !== undefined && (typeof serversObj !== "object" || serversObj === null || Array.isArray(serversObj))) {
    return { result: "manual", path: file, detail: `"mcp.servers" in ${file} isn't an object; left as is` };
  }
  const servers = { ...((serversObj as Record<string, unknown> | undefined) ?? {}) };
  const current = servers[MCP_SERVER_NAME] as OpenCodeMcpEntry | undefined;
  if (current !== undefined && !isOursOpenCode(current)) {
    return { result: "manual", path: file, detail: `another MCP server named "${MCP_SERVER_NAME}" is registered; left as is` };
  }
  if (current !== undefined && sameOpenCodeCommand(current, want)) {
    return { result: "already-installed", path: file };
  }
  const result: McpInstallResult = current !== undefined ? "updated" : "installed";
  servers[MCP_SERVER_NAME] = { type: "local", command: [want.command, ...want.args] };
  mcp.servers = servers;
  doc.mcp = mcp;
  const backupPath = backupOnce(file);
  writeAtomic(file, `${JSON.stringify(doc, null, 2)}\n`);
  return { result, path: file, via: "file", backupPath };
}
