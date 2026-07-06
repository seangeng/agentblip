import type { Route } from "./+types/pair";
import { SiteFooter, SiteHeader } from "../components/SiteChrome";

const TITLE = "Connect your Slack workspace to agentblip — device pairing";
const DESCRIPTION =
  "Enter the 8-character code from agentblip setup to connect your Slack workspace, then head back to your terminal — the CLI finishes pairing automatically.";

export function meta(_: Route.MetaArgs) {
  return [
    { title: TITLE },
    { name: "description", content: DESCRIPTION },
    // pairing links are one-time; keep them out of search results
    { name: "robots", content: "noindex" },
    { property: "og:type", content: "website" },
    { property: "og:title", content: TITLE },
    { property: "og:description", content: DESCRIPTION },
    { property: "og:url", content: "https://agentblip.com/pair" },
    { property: "og:image", content: "https://agentblip.com/og.png" },
    { tagName: "link", rel: "canonical", href: "https://agentblip.com/pair" },
  ];
}

export function loader({ request }: Route.LoaderArgs) {
  const params = new URL(request.url).searchParams;
  return {
    code: (params.get("code") ?? "")
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, "")
      .slice(0, 8),
    done: params.get("done") === "1",
    team: params.get("team"),
    error: params.get("error"),
  };
}

const ERROR_COPY: Record<string, { heading: string; body: string }> = {
  expired: {
    heading: "that code expired",
    body: "Pairing codes only live for 15 minutes. Run agentblip setup again in your terminal to get a fresh one, then come back here.",
  },
  state: {
    heading: "couldn't verify the handshake",
    body: "The OAuth state didn't match — this can happen if the page sat open too long or the link was reused. Run agentblip setup again and retry.",
  },
  slack: {
    heading: "slack didn't complete the connection",
    body: "The Slack authorization was cancelled or failed. Nothing was linked — enter your code below to try again.",
  },
};

function SlackLogo() {
  return (
    <svg viewBox="0 0 122.8 122.8" className="size-4" aria-hidden="true">
      <path
        d="M25.8 77.6c0 7.1-5.8 12.9-12.9 12.9S0 84.7 0 77.6s5.8-12.9 12.9-12.9h12.9v12.9zm6.5 0c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9v32.3c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V77.6z"
        fill="#e01e5a"
      />
      <path
        d="M45.2 25.8c-7.1 0-12.9-5.8-12.9-12.9S38.1 0 45.2 0s12.9 5.8 12.9 12.9v12.9H45.2zm0 6.5c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H12.9C5.8 58.1 0 52.3 0 45.2s5.8-12.9 12.9-12.9h32.3z"
        fill="#36c5f0"
      />
      <path
        d="M97 45.2c0-7.1 5.8-12.9 12.9-12.9s12.9 5.8 12.9 12.9-5.8 12.9-12.9 12.9H97V45.2zm-6.5 0c0 7.1-5.8 12.9-12.9 12.9s-12.9-5.8-12.9-12.9V12.9C64.7 5.8 70.5 0 77.6 0s12.9 5.8 12.9 12.9v32.3z"
        fill="#2eb67d"
      />
      <path
        d="M77.6 97c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9-12.9-5.8-12.9-12.9V97h12.9zm0-6.5c-7.1 0-12.9-5.8-12.9-12.9s5.8-12.9 12.9-12.9h32.3c7.1 0 12.9 5.8 12.9 12.9s-5.8 12.9-12.9 12.9H77.6z"
        fill="#ecb22e"
      />
    </svg>
  );
}

export default function Pair({ loaderData }: Route.ComponentProps) {
  const { code, done, team, error } = loaderData;
  const errorCopy = error ? (ERROR_COPY[error] ?? ERROR_COPY["slack"]) : null;

  return (
    <div className="flex min-h-svh flex-col">
      <SiteHeader />

      <main className="mx-auto flex w-full max-w-xl flex-1 flex-col justify-center px-6 py-16">
        {done ? (
          <section aria-live="polite" className="text-center">
            <div className="mx-auto grid size-16 place-items-center rounded-full border border-phosphor-600 bg-phosphor-900">
              <svg
                viewBox="0 0 24 24"
                className="size-8 text-phosphor-400"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.5"
                aria-hidden="true"
              >
                <path d="M4.5 12.5l5 5L19.5 6.5" />
              </svg>
            </div>
            <h1 className="mt-6 font-mono text-3xl font-semibold tracking-tight text-balance">
              Connected{team ? ` to ${team}` : ""}{" "}
              <span className="text-phosphor-400">✓</span>
            </h1>
            <p className="mt-4 text-fg-muted">
              Return to your terminal — the CLI picks up the pairing
              automatically and finishes setup. You can close this tab.
            </p>
            <p className="mt-8 inline-block rounded-lg border border-ink-700 bg-ink-900 px-4 py-2.5 font-mono text-sm text-fg-muted">
              <span className="text-phosphor-600">$ </span>waiting for your
              daemon's first blip…
            </p>
          </section>
        ) : (
          <section>
            <h1 className="font-mono text-3xl font-semibold tracking-tight">
              Pair your device
            </h1>
            <p className="mt-3 text-fg-muted">
              Enter the code shown by{" "}
              <code className="rounded bg-ink-800 px-1.5 py-0.5 font-mono text-sm text-fg">
                agentblip setup
              </code>{" "}
              to connect your Slack workspace.
            </p>

            {errorCopy ? (
              <div
                role="alert"
                className="mt-6 rounded-lg border border-signal-400/40 bg-signal-900/40 px-4 py-3.5"
              >
                <p className="font-mono text-sm font-medium text-signal-300">
                  {errorCopy.heading}
                </p>
                <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">
                  {errorCopy.body}
                </p>
              </div>
            ) : null}

            <form
              method="get"
              action="/api/slack/install"
              className="mt-8 flex flex-col gap-5"
            >
              <label
                htmlFor="pair-code"
                className="font-mono text-xs tracking-wide text-fg-faint"
              >
                pairing code
              </label>
              <input
                id="pair-code"
                name="code"
                type="text"
                defaultValue={code}
                required
                minLength={8}
                maxLength={8}
                autoComplete="off"
                autoCapitalize="characters"
                autoCorrect="off"
                spellCheck={false}
                inputMode="text"
                pattern="[A-Za-z0-9]{8}"
                placeholder="XXXXXXXX"
                aria-describedby="pair-code-hint"
                onChange={(e) => {
                  e.currentTarget.value = e.currentTarget.value
                    .toUpperCase()
                    .replace(/[^A-Z0-9]/g, "");
                }}
                className="w-full rounded-xl border border-ink-700 bg-ink-900 px-5 py-4 text-center font-mono text-3xl font-semibold tracking-[0.35em] text-phosphor-400 uppercase placeholder:text-ink-600 focus:border-phosphor-600"
              />
              <p id="pair-code-hint" className="font-mono text-xs text-fg-faint">
                8 characters · expires 15 minutes after setup starts
              </p>
              <button
                type="submit"
                className="flex items-center justify-center gap-2.5 rounded-xl bg-phosphor-500 px-5 py-3.5 font-mono text-sm font-semibold text-ink-950 transition-colors hover:bg-phosphor-400"
              >
                <SlackLogo />
                Connect Slack
              </button>
            </form>

            <p className="mt-6 text-sm text-fg-faint">
              You'll be sent to Slack to authorize the{" "}
              <code className="font-mono text-xs">users.profile:write</code>{" "}
              scope — the only permission agentblip asks for.
            </p>
          </section>
        )}
      </main>

      <SiteFooter />
    </div>
  );
}
