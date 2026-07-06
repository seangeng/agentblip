import { useEffect, useState } from "react";

/**
 * Fake Slack profile card cycling through REAL formatter outputs
 * (see @agentblip/core format.ts DEFAULT_TEMPLATES).
 */
const STATUSES = [
  { emoji: "🤖", text: "claude agent working" },
  { emoji: "🤖", text: "claude: finalizing CI/CD" },
  { emoji: "🤖", text: "3 agents working" },
  { emoji: "🤖", text: "3 agents working · 1 waiting on me" },
] as const;

const CYCLE_MS = 2800;

export function SlackStatusDemo() {
  const [i, setI] = useState(0);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const id = window.setInterval(
      () => setI((n) => (n + 1) % STATUSES.length),
      CYCLE_MS,
    );
    return () => window.clearInterval(id);
  }, []);

  const status = STATUSES[i % STATUSES.length] ?? STATUSES[0];

  return (
    <figure className="relative" aria-label="Example Slack status set by agentblip">
      {/* radar backdrop: concentric rings + rotating sweep */}
      <div
        aria-hidden="true"
        className="absolute -inset-20 -z-10 [mask-image:radial-gradient(closest-side,black,transparent)]"
      >
        <div
          className="absolute inset-0"
          style={{
            background:
              "repeating-radial-gradient(circle at center, transparent 0 55px, rgba(47,227,115,0.16) 55px 56px)",
          }}
        />
        <div
          className="absolute inset-0 animate-sweep"
          style={{
            background:
              "conic-gradient(from 0deg, transparent 0deg, rgba(47,227,115,0.12) 55deg, transparent 90deg)",
          }}
        />
      </div>

      {/* Slack-dark-theme profile card */}
      <div className="relative w-full max-w-sm rounded-xl border border-ink-700 bg-[#1a1d21] shadow-[0_24px_64px_-16px_rgba(0,0,0,0.9)]">
        <figcaption className="border-b border-white/5 px-4 py-2.5 font-mono text-[11px] tracking-wide text-fg-faint">
          slack · what your team sees
        </figcaption>
        <div className="flex items-start gap-3 px-4 py-4">
          <div className="relative shrink-0">
            <div className="grid size-10 place-items-center rounded-lg bg-phosphor-900 font-mono text-sm font-semibold text-phosphor-400">
              S
            </div>
            {/* presence dot with radar ping */}
            <span className="absolute -right-1 -bottom-1 grid size-4 place-items-center rounded-full bg-[#1a1d21]">
              <span className="relative inline-flex size-2.5">
                <span
                  aria-hidden="true"
                  className="absolute inset-0 animate-radar rounded-full bg-phosphor-500 opacity-75"
                />
                <span className="relative inline-flex size-2.5 rounded-full bg-phosphor-400" />
              </span>
            </span>
          </div>
          <div className="min-w-0">
            <p className="text-[15px] font-semibold text-white">
              sean{" "}
              <span className="ml-1 align-middle font-mono text-[10px] font-normal tracking-wide text-phosphor-400">
                active
              </span>
            </p>
            <p className="mt-0.5 flex items-baseline gap-1.5 text-sm text-[#d1d2d3]">
              <span aria-hidden="true">{status.emoji}</span>
              <span
                key={i}
                className="animate-fade-up truncate font-mono text-[13px]"
              >
                {status.text}
              </span>
            </p>
          </div>
        </div>
        <p className="border-t border-white/5 px-4 py-2.5 font-mono text-[11px] text-fg-faint">
          auto-clears 5 min after your daemon stops
        </p>
      </div>
    </figure>
  );
}
