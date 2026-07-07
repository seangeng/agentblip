import { Link } from "react-router";
import { Blip } from "./Blip";

export const GITHUB_URL = "https://github.com/seangeng/agentblip";
export const NPM_URL = "https://www.npmjs.com/package/agentblip";

export function SiteHeader() {
  return (
    <header className="mx-auto flex w-full max-w-6xl items-center justify-between px-6 py-6">
      <Link
        to="/"
        className="flex items-center gap-2.5 font-mono text-sm font-semibold tracking-tight text-fg"
      >
        <Blip />
        agentblip
      </Link>
      <nav
        aria-label="Main"
        className="flex items-center gap-5 font-mono text-xs text-fg-muted sm:gap-7"
      >
        <a
          href="/#how-it-works"
          className="hidden transition-colors hover:text-fg sm:inline"
        >
          how it works
        </a>
        <a
          href="/#menu-bar"
          className="hidden transition-colors hover:text-fg sm:inline"
        >
          menu bar
        </a>
        <Link to="/privacy" className="transition-colors hover:text-fg">
          privacy
        </Link>
        <a
          href={GITHUB_URL}
          rel="noreferrer"
          className="transition-colors hover:text-fg"
        >
          GitHub ↗
        </a>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="border-t border-ink-800">
      <div className="mx-auto flex w-full max-w-6xl flex-col gap-5 px-6 py-10 font-mono text-xs text-fg-muted sm:flex-row sm:items-center sm:justify-between">
        <p className="flex items-center gap-2.5">
          <Blip />
          agentblip
          <span className="text-fg-faint">
            · MIT · built by{" "}
            <a
              href="https://github.com/seangeng"
              rel="noreferrer"
              className="underline-offset-4 transition-colors hover:text-fg-muted hover:underline"
            >
              Sean Geng
            </a>
          </span>
        </p>
        <nav aria-label="Footer" className="flex items-center gap-6">
          <a
            href={GITHUB_URL}
            rel="noreferrer"
            className="transition-colors hover:text-fg"
          >
            GitHub
          </a>
          <a
            href={NPM_URL}
            rel="noreferrer"
            className="transition-colors hover:text-fg"
          >
            npm
          </a>
          <Link to="/privacy" className="transition-colors hover:text-fg">
            privacy
          </Link>
        </nav>
      </div>
    </footer>
  );
}
