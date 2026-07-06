import type { ReactNode } from "react";
import {
  isRouteErrorResponse,
  Link,
  Links,
  Meta,
  Outlet,
  Scripts,
  ScrollRestoration,
} from "react-router";
import type { Route } from "./+types/root";
import "./app.css";

const FAVICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#060907"/><circle cx="16" cy="16" r="10" fill="none" stroke="#17a44e" stroke-width="1.5" opacity="0.5"/><circle cx="16" cy="16" r="5" fill="#2fe373"/></svg>',
  );

export const links: Route.LinksFunction = () => [
  { rel: "icon", type: "image/svg+xml", href: FAVICON },
  { rel: "preconnect", href: "https://fonts.googleapis.com" },
  {
    rel: "preconnect",
    href: "https://fonts.gstatic.com",
    crossOrigin: "anonymous",
  },
  {
    rel: "stylesheet",
    href: "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500;600;700&display=swap",
  },
];

export function Layout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className="dark">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <meta name="theme-color" content="#060907" />
        <Meta />
        <Links />
      </head>
      <body>
        {children}
        <ScrollRestoration />
        <Scripts />
      </body>
    </html>
  );
}

export default function App() {
  return <Outlet />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let heading = "signal lost";
  let details = "An unexpected error occurred.";
  let stack: string | undefined;

  if (isRouteErrorResponse(error)) {
    heading = error.status === 404 ? "404 — no blip here" : `${error.status}`;
    details =
      error.status === 404
        ? "The page you're looking for isn't on the radar."
        : error.statusText || details;
  } else if (import.meta.env.DEV && error && error instanceof Error) {
    details = error.message;
    stack = error.stack;
  }

  return (
    <main className="mx-auto flex min-h-svh w-full max-w-2xl flex-col items-start justify-center gap-4 px-6">
      {/* the root route has no meta export, so without this the error page
          ships with no document <title>; React 19 hoists it into <head> */}
      <title>{`${heading} — agentblip`}</title>
      <h1 className="font-mono text-3xl font-semibold tracking-tight text-phosphor-400">
        {heading}
      </h1>
      <p className="text-fg-muted">{details}</p>
      {stack ? (
        <pre className="w-full overflow-x-auto rounded-lg border border-ink-700 bg-ink-900 p-4 font-mono text-xs text-fg-muted">
          <code>{stack}</code>
        </pre>
      ) : null}
      <Link
        to="/"
        className="font-mono text-sm text-phosphor-400 underline-offset-4 hover:underline"
      >
        ← back to agentblip.com
      </Link>
    </main>
  );
}
