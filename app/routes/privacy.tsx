import type { Route } from "./+types/privacy";
import { GITHUB_URL, SiteFooter, SiteHeader } from "../components/SiteChrome";

const TITLE = "Privacy — what the agentblip relay can and cannot see";
const DESCRIPTION =
  "agentblip is local-first: the relay only sees the final status text it sets on Slack. Tokens are AES-GCM encrypted, the code is MIT, and you can self-host it.";

export function meta(_: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    { property: "og:type", content: "website" },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:url", content: "https://agentblip.com/privacy" },
    { property: "og:image", content: "https://agentblip.com/og.png" },
    {
      tagName: "link",
      rel: "canonical",
      href: "https://agentblip.com/privacy",
    },
  ];
}

function H2({ children }: { children: string }) {
  return (
    <h2 className="mt-12 font-mono text-xl font-semibold tracking-tight">
      <span aria-hidden="true" className="text-phosphor-600">
        ##{" "}
      </span>
      {children}
    </h2>
  );
}

export default function Privacy(_: Route.ComponentProps) {
  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />

      <main className="mx-auto w-full max-w-2xl flex-1 px-6 py-16">
        <h1 className="font-mono text-3xl font-semibold tracking-tight">
          Privacy
        </h1>
        <p className="mt-4 leading-relaxed text-fg-muted">
          agentblip is local-first by construction. Your agent sessions are
          watched, aggregated, and formatted into a status entirely on your
          machine, by a daemon bound to{" "}
          <code className="font-mono text-sm text-fg">127.0.0.1:4519</code>.
          This page describes exactly what the hosted relay at agentblip.com
          handles.
        </p>

        <H2>What the relay receives</H2>
        <ul className="mt-4 flex list-disc flex-col gap-2.5 pl-5 leading-relaxed text-fg-muted marker:text-phosphor-600">
          <li>
            Your <strong className="font-medium text-fg">final status</strong>:
            the text (max 100 characters), the emoji, and an expiration
            timestamp — exactly what appears in Slack, nothing more.
          </li>
          <li>
            Your device token, verified against a SHA-256 hash. The relay
            holds the plaintext token only inside the pairing record during
            the handshake — it is handed to your CLI once (single-use, with a
            60-second delivery grace) and the record expires within 15
            minutes either way. After that, the plaintext token lives only on
            your machine.
          </li>
          <li>
            Standard request metadata (IP address) used transiently for rate
            limiting.
          </li>
        </ul>

        <H2>What the relay never sees</H2>
        <p className="mt-4 leading-relaxed text-fg-muted">
          Prompts, code, file contents, tool calls, session IDs, project
          paths — none of it leaves your machine. The relay has no API that
          could even accept raw session data. One honest nuance: at the{" "}
          <code className="font-mono text-sm text-fg">activity</code>{" "}
          granularity your status text itself can include a short activity
          label (e.g. “finalizing CI/CD”). You choose the granularity, and
          your redaction patterns are applied locally before the text is sent.
        </p>

        <H2>What the relay stores</H2>
        <ul className="mt-4 flex list-disc flex-col gap-2.5 pl-5 leading-relaxed text-fg-muted marker:text-phosphor-600">
          <li>
            A device record: your Slack user ID, team ID and name, and your
            Slack token —{" "}
            <strong className="font-medium text-fg">
              AES-GCM encrypted at rest
            </strong>{" "}
            with a key held only as a Worker secret. A KV dump alone cannot
            leak Slack tokens. A device record that is never used after
            pairing is provisional and expires after 24 hours.
          </li>
          <li>
            Pairing records, which are single-use and expire automatically
            after 15 minutes. During the handshake one briefly carries your
            new device token in plaintext (see above) — that is the only time
            the relay stores it.
          </li>
          <li>
            No status history. Each update overwrites your Slack status and is
            not logged or retained by the relay.
          </li>
        </ul>

        <H2>No analytics</H2>
        <p className="mt-4 leading-relaxed text-fg-muted">
          The API has no analytics, no tracking pixels, and no third-party
          calls other than Slack itself.
        </p>

        <H2>Leaving</H2>
        <p className="mt-4 leading-relaxed text-fg-muted">
          Run <code className="font-mono text-sm text-fg">agentblip unlink</code>{" "}
          to revoke your device record and clear your status. Statuses also
          carry a rolling 5-minute expiration, so anything stale clears itself.
        </p>

        <H2>Don't trust us? Don't use us</H2>
        <p className="mt-4 leading-relaxed text-fg-muted">
          agentblip is MIT-licensed and the relay is a small Cloudflare Worker
          you can{" "}
          <a
            href={GITHUB_URL}
            rel="noreferrer"
            className="text-phosphor-400 underline-offset-4 hover:underline"
          >
            read and self-host
          </a>
          . Or skip the relay entirely: the CLI's direct Slack sink sets your
          status with your own user token, and no server of ours is involved
          at all.
        </p>
      </main>

      <SiteFooter />
    </div>
  );
}
