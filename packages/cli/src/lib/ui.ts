import readline from "node:readline";

/** Tiny ANSI helpers — deliberately no chalk/kleur/prompts dependency. */

const useColor = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;

function style(open: number, close: number): (text: string) => string {
  return (text) => (useColor ? `[${open}m${text}[${close}m` : text);
}

export const bold = style(1, 22);
export const dim = style(2, 22);
export const red = style(31, 39);
export const green = style(32, 39);
export const yellow = style(33, 39);
export const cyan = style(36, 39);

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

export function renderTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)),
  );
  const line = (cells: string[]): string =>
    cells
      .map((cell, i) => cell.padEnd(widths[i] ?? 0))
      .join("  ")
      .trimEnd();
  return [dim(line(headers)), ...rows.map(line)].join("\n");
}

export function ask(question: string, defaultValue?: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    const suffix = defaultValue ? dim(` (${defaultValue})`) : "";
    rl.question(`${question}${suffix} `, (answer) => {
      rl.close();
      resolve(answer.trim() || defaultValue || "");
    });
  });
}

export async function confirm(question: string, defaultYes = true): Promise<boolean> {
  const answer = await ask(`${question} ${dim(defaultYes ? "[Y/n]" : "[y/N]")}`);
  if (!answer) return defaultYes;
  return /^y(es)?$/i.test(answer);
}

export async function select<T extends string>(
  question: string,
  choices: ReadonlyArray<{ value: T; label: string }>,
  defaultIndex = 0,
): Promise<T> {
  process.stdout.write(`${bold(question)}\n`);
  choices.forEach((choice, i) => {
    process.stdout.write(`  ${cyan(String(i + 1))}. ${choice.label}\n`);
  });
  for (;;) {
    const answer = await ask(
      `Choose 1-${choices.length}`,
      String(defaultIndex + 1),
    );
    const n = Number.parseInt(answer, 10);
    const choice = choices[n - 1];
    if (choice) return choice.value;
    process.stdout.write(red("  invalid choice\n"));
  }
}

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

export interface Spinner {
  update(text: string): void;
  stop(finalText?: string): void;
}

export function spinner(text: string): Spinner {
  let current = text;
  let frame = 0;
  let stopped = false;
  const tty = Boolean(process.stdout.isTTY);
  if (!tty) process.stdout.write(`${current}\n`);
  const timer = tty
    ? setInterval(() => {
        const glyph = SPINNER_FRAMES[frame % SPINNER_FRAMES.length] ?? "·";
        frame += 1;
        process.stdout.write(`\r${cyan(glyph)} ${current}[K`);
      }, 80)
    : undefined;
  return {
    update(next: string): void {
      current = next;
    },
    stop(finalText?: string): void {
      if (stopped) return;
      stopped = true;
      if (timer) {
        clearInterval(timer);
        process.stdout.write("\r[K");
      }
      if (finalText) process.stdout.write(`${finalText}\n`);
    },
  };
}
