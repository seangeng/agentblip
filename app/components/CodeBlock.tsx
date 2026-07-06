import { useState } from "react";

function CopyIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.25"
      aria-hidden="true"
    >
      <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" />
      <path d="M10.5 5.5v-2a1 1 0 0 0-1-1h-6a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2" />
    </svg>
  );
}

function CheckIcon() {
  return (
    <svg
      viewBox="0 0 16 16"
      className="size-3.5"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.75"
      aria-hidden="true"
    >
      <path d="M3 8.5l3.5 3.5L13 4.5" />
    </svg>
  );
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard.writeText(text).then(() => {
          setCopied(true);
          window.setTimeout(() => setCopied(false), 1600);
        });
      }}
      aria-label={copied ? "Copied" : `Copy "${text}"`}
      className={`rounded-md border p-1.5 transition-colors ${
        copied
          ? "border-phosphor-600 text-phosphor-400"
          : "border-ink-700 text-fg-faint hover:border-ink-600 hover:text-fg-muted"
      }`}
    >
      {copied ? <CheckIcon /> : <CopyIcon />}
    </button>
  );
}

export interface Command {
  cmd: string;
  /** Faint trailing annotation, e.g. "# opens your browser" */
  note?: string;
}

/** A terminal window with one copy button per command line. */
export function CodeBlock({
  title = "terminal",
  commands,
}: {
  title?: string;
  commands: readonly Command[];
}) {
  return (
    <div className="overflow-hidden rounded-xl border border-ink-700 bg-ink-900 shadow-[0_16px_48px_-16px_rgba(0,0,0,0.8)]">
      <div className="flex items-center gap-2 border-b border-ink-800 px-4 py-2.5">
        <span aria-hidden="true" className="flex gap-1.5">
          <span className="size-2.5 rounded-full bg-ink-600" />
          <span className="size-2.5 rounded-full bg-ink-600" />
          <span className="size-2.5 rounded-full bg-ink-600" />
        </span>
        <span className="ml-1 font-mono text-[11px] text-fg-faint">
          {title}
        </span>
      </div>
      <div className="flex flex-col gap-1 px-4 py-3.5">
        {commands.map((c) => (
          <div key={c.cmd} className="flex items-center gap-3">
            {/* min-w-0 lets the scrollable code area shrink inside the flex row */}
            <code className="min-w-0 flex-1 overflow-x-auto font-mono text-sm whitespace-nowrap">
              <span className="text-phosphor-600 select-none">$ </span>
              <span className="text-fg">{c.cmd}</span>
              {c.note ? (
                <span className="text-fg-faint select-none"> {c.note}</span>
              ) : null}
            </code>
            <CopyButton text={c.cmd} />
          </div>
        ))}
      </div>
    </div>
  );
}
