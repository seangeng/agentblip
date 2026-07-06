import fs from "node:fs";
import path from "node:path";
import { pidFilePath } from "./paths";

export function writePidFile(pid: number, file = pidFilePath()): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${pid}\n`);
}

export function readPidFile(file = pidFilePath()): number | undefined {
  try {
    const pid = Number.parseInt(fs.readFileSync(file, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function removePidFile(file = pidFilePath()): void {
  try {
    fs.unlinkSync(file);
  } catch {
    // already gone
  }
}

export function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM means the process exists but belongs to someone else.
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}
