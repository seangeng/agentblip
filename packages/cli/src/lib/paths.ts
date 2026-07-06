import os from "node:os";
import path from "node:path";

/** ~/.config/agentblip (XDG_CONFIG_HOME respected). */
export function configDir(): string {
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  return path.join(base, "agentblip");
}

/** ~/.local/state/agentblip (XDG_STATE_HOME respected). */
export function stateDir(): string {
  const base =
    process.env.XDG_STATE_HOME || path.join(os.homedir(), ".local", "state");
  return path.join(base, "agentblip");
}

export function configPath(): string {
  return path.join(configDir(), "config.json");
}

export function pidFilePath(): string {
  return path.join(stateDir(), "daemon.pid");
}

export function spawnLockPath(): string {
  return path.join(stateDir(), "daemon.spawn.lock");
}

export function logFilePath(): string {
  return path.join(stateDir(), "daemon.log");
}
