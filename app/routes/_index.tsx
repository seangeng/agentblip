import type { ReactNode } from "react";
import type { Route } from "./+types/_index";
import { Link } from "react-router";
import { Blip } from "../components/Blip";
import { CodeBlock } from "../components/CodeBlock";
import { SlackStatusDemo } from "../components/SlackStatusDemo";
import { GITHUB_URL, SiteFooter, SiteHeader } from "../components/SiteChrome";

const TITLE = "agentblip — your Slack status, synced with your AI agents";
const DESCRIPTION =
  "agentblip watches your local Claude Code and Codex sessions and keeps your Slack status honest — “claude agent working”, “3 agents working”. Local-first, MIT.";
const URL = "https://agentblip.com/";

export function meta(_: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:url", content: URL },
    { property: "og:image", content: "https://agentblip.com/og.png" },
    { property: "og:site_name", content: "agentblip" },
    { name: "twitter:card", content: "summary_large_image" },
    { name: "twitter:title", content: TITLE },
    { name: "twitter:description", content: DESCRIPTION },
    { name: "twitter:image", content: "https://agentblip.com/og.png" },
    { tagName: "link", rel: "canonical", href: URL },
  ];
}

const JSON_LD = {
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: "agentblip",
  description: DESCRIPTION,
  url: URL,
  applicationCategory: "DeveloperApplication",
  operatingSystem: "macOS, Linux, Windows",
  downloadUrl: "https://www.npmjs.com/package/agentblip",
  license: "https://opensource.org/license/mit",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
  author: { "@type": "Person", name: "Sean Geng" },
};

const STEPS = [
  {
    n: "01",
    title: "signal in",
    body: "Claude Code hooks and the Codex watcher post tiny lifecycle events to a local daemon on 127.0.0.1:4519. Anything can emit — one curl to POST /event and your custom tool is a blip too.",
  },
  {
    n: "02",
    title: "format locally",
    body: "The daemon aggregates every live session and formats your status on your machine. You pick the granularity — off, presence, count, or activity — and redaction runs before anything leaves localhost.",
  },
  {
    n: "03",
    title: "status out",
    body: "The relay — or your own Slack token, no server at all — sets your status. A rolling 5-minute expiration means a dead daemon auto-clears it. No stale “working” lies.",
  },
] as const;

function GranularityRow({
  level,
  levelClass,
  children,
  note,
}: {
  level: string;
  levelClass: string;
  children: ReactNode;
  note: string;
}) {
  return (
    <tr className="border-b border-ink-800 last:border-b-0">
      <th
        scope="row"
        className={`px-5 py-4 text-left align-top font-mono text-sm font-medium whitespace-nowrap ${levelClass}`}
      >
        {level}
      </th>
      <td className="px-5 py-4 align-top font-mono text-sm text-fg">
        {children}
      </td>
      <td className="hidden px-5 py-4 align-top text-sm text-fg-muted md:table-cell">
        {note}
      </td>
    </tr>
  );
}

function StatusChip({ emoji, text }: { emoji?: string; text: string }) {
  return (
    <span className="inline-flex items-baseline gap-1.5 rounded-md border border-ink-700 bg-ink-900 px-2.5 py-1 whitespace-nowrap">
      {emoji ? <span aria-hidden="true">{emoji}</span> : null}
      <span>{text}</span>
    </span>
  );
}

export default function Index(_: Route.ComponentProps) {
  return (
    <div className="relative overflow-x-clip">
      {/* atmosphere: faint grid + phosphor glow */}
      <div aria-hidden="true" className="pointer-events-none absolute inset-0 -z-10">
        <div
          className="absolute inset-x-0 top-0 h-[48rem] [mask-image:radial-gradient(60%_60%_at_50%_0%,black,transparent)]"
          style={{
            backgroundImage:
              "linear-gradient(rgba(47,227,115,0.05) 1px, transparent 1px), linear-gradient(90deg, rgba(47,227,115,0.05) 1px, transparent 1px)",
            backgroundSize: "56px 56px",
          }}
        />
        <div
          className="absolute inset-x-0 top-0 h-[36rem]"
          style={{
            background:
              "radial-gradient(50% 45% at 70% 10%, rgba(47,227,115,0.07), transparent)",
          }}
        />
      </div>

      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{ __html: JSON.stringify(JSON_LD) }}
      />

      <SiteHeader />

      <main>
        {/* ── hero ─────────────────────────────────────────── */}
        <section className="mx-auto grid w-full max-w-6xl items-center gap-14 px-6 pt-14 pb-24 lg:grid-cols-[1.05fr_0.95fr] lg:gap-8 lg:pt-24">
          {/* min-w-0: keep nowrap terminal lines from widening the grid track */}
          <div className="min-w-0">
            <p className="mb-5 flex items-center gap-2 font-mono text-xs tracking-wide text-phosphor-400">
              <Blip />
              local-first slack presence for AI agents
            </p>
            <h1 className="font-mono text-4xl leading-[1.12] font-semibold tracking-tight text-balance sm:text-5xl">
              Your Slack status,{" "}
              <span className="text-phosphor-400">synced</span> with your AI
              agents.
              <span
                aria-hidden="true"
                className="ml-2 inline-block h-[0.85em] w-[0.45em] translate-y-[0.1em] animate-blink bg-phosphor-500"
              />
            </h1>
            <p className="mt-6 max-w-xl text-base leading-relaxed text-fg-muted sm:text-lg">
              agentblip watches your local Claude Code and Codex sessions and
              keeps your team in the loop —{" "}
              <span className="font-mono text-sm text-fg">
                “claude agent working”
              </span>
              ,{" "}
              <span className="font-mono text-sm text-fg">
                “3 agents working”
              </span>
              ,{" "}
              <span className="font-mono text-sm text-fg">
                “claude: finalizing CI/CD”
              </span>
              . No more “still running?” pings.
            </p>

            <div className="mt-9 max-w-xl">
              <CodeBlock
                commands={[
                  { cmd: "npm install -g agentblip" },
                  { cmd: "agentblip setup", note: "# pairs Slack in your browser" },
                ]}
              />
              <p className="mt-3 font-mono text-xs text-fg-faint">
                open source ·{" "}
                <a
                  href={GITHUB_URL}
                  rel="noreferrer"
                  className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
                >
                  view the code on GitHub ↗
                </a>
              </p>
            </div>
          </div>

          <div className="flex min-w-0 justify-center lg:justify-end lg:pr-6">
            <SlackStatusDemo />
          </div>
        </section>

        {/* ── how it works ─────────────────────────────────── */}
        <section
          id="how-it-works"
          className="border-t border-ink-800 scroll-mt-8"
        >
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <h2 className="font-mono text-2xl font-semibold tracking-tight sm:text-3xl">
              <span aria-hidden="true" className="text-phosphor-600">
                ##{" "}
              </span>
              How it works
            </h2>
            <p className="mt-3 max-w-2xl text-fg-muted">
              One tiny daemon on your machine. Your session data never leaves
              it — only the finished status text does.
            </p>
            <ol className="mt-10 grid gap-5 md:grid-cols-3">
              {STEPS.map((s) => (
                <li
                  key={s.n}
                  className="rounded-xl border border-ink-800 bg-ink-900/60 p-6 transition-colors hover:border-ink-700"
                >
                  <p className="font-mono text-xs text-phosphor-600">{s.n}</p>
                  <h3 className="mt-2 font-mono text-lg font-medium text-fg">
                    {s.title}
                  </h3>
                  <p className="mt-3 text-sm leading-relaxed text-fg-muted">
                    {s.body}
                  </p>
                </li>
              ))}
            </ol>
          </div>
        </section>

        {/* ── granularity ──────────────────────────────────── */}
        <section id="granularity" className="border-t border-ink-800">
          <div className="mx-auto w-full max-w-6xl px-6 py-20">
            <h2 className="font-mono text-2xl font-semibold tracking-tight sm:text-3xl">
              <span aria-hidden="true" className="text-phosphor-600">
                ##{" "}
              </span>
              You choose how much your team sees
            </h2>
            <p className="mt-3 max-w-2xl text-fg-muted">
              Four granularity levels, formatted entirely on your machine.
              These are the real default outputs:
            </p>
            <div className="mt-10 overflow-x-auto rounded-xl border border-ink-800 bg-ink-900/60">
              <table className="w-full min-w-[36rem] border-collapse">
                <thead>
                  <tr className="border-b border-ink-700">
                    <th
                      scope="col"
                      className="px-5 py-3 text-left font-mono text-xs font-medium tracking-wide text-fg-faint"
                    >
                      level
                    </th>
                    <th
                      scope="col"
                      className="px-5 py-3 text-left font-mono text-xs font-medium tracking-wide text-fg-faint"
                    >
                      your status
                    </th>
                    <th
                      scope="col"
                      className="hidden px-5 py-3 text-left font-mono text-xs font-medium tracking-wide text-fg-faint md:table-cell"
                    >
                      reveals
                    </th>
                  </tr>
                </thead>
                <tbody>
                  <GranularityRow
                    level="off"
                    levelClass="text-fg-faint"
                    note="Nothing. agentblip never touches your status."
                  >
                    <span className="text-fg-faint">— status never set</span>
                  </GranularityRow>
                  <GranularityRow
                    level="presence"
                    levelClass="text-phosphor-600"
                    note="Only that some agent is working."
                  >
                    <StatusChip emoji="🤖" text="heads down with agents" />
                  </GranularityRow>
                  <GranularityRow
                    level="count"
                    levelClass="text-phosphor-500"
                    note="Which agent, and how many sessions."
                  >
                    <span className="flex flex-wrap gap-2">
                      <StatusChip emoji="🤖" text="claude agent working" />
                      <StatusChip emoji="🤖" text="3 agents working" />
                    </span>
                  </GranularityRow>
                  <GranularityRow
                    level="activity"
                    levelClass="text-phosphor-400"
                    note="A short label of what it's doing right now."
                  >
                    <StatusChip emoji="🤖" text="claude: finalizing CI/CD" />
                  </GranularityRow>
                </tbody>
              </table>
            </div>
            <p className="mt-4 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-xs text-fg-muted">
              <Blip color="signal" />
              <span>
                blocked on you? count and activity append{" "}
                <span className="text-signal-400">“· 1 waiting on me”</span>
              </span>
            </p>
          </div>
        </section>

        {/* ── privacy strip ────────────────────────────────── */}
        <section className="border-t border-ink-800 bg-ink-900/40">
          <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-6 py-16 lg:flex-row lg:items-center lg:justify-between">
            <div className="max-w-2xl">
              <h2 className="font-mono text-xl font-semibold tracking-tight sm:text-2xl">
                <span aria-hidden="true" className="text-phosphor-600">
                  ##{" "}
                </span>
                The relay never sees your work
              </h2>
              <p className="mt-3 leading-relaxed text-fg-muted">
                Local-first by construction: prompts, code, files, tools, and
                session data stay on your machine. The relay receives exactly
                one thing — the final status text it sets on Slack. Tokens are
                AES-GCM encrypted at rest, and the whole thing is MIT and
                self-hostable.
              </p>
            </div>
            <div className="flex shrink-0 flex-col gap-3 font-mono text-sm">
              <Link
                to="/privacy"
                className="text-phosphor-400 underline-offset-4 transition-colors hover:text-phosphor-300 hover:underline"
              >
                read the privacy details →
              </Link>
              <a
                href={GITHUB_URL}
                rel="noreferrer"
                className="text-fg-muted underline-offset-4 transition-colors hover:text-fg hover:underline"
              >
                audit the source on GitHub ↗
              </a>
            </div>
          </div>
        </section>
      </main>

      <SiteFooter />
    </div>
  );
}
