import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import { ErrorBoundary } from "./root";

/** Shape react-router's isRouteErrorResponse duck-types against. */
function routeErrorResponse(status: number, statusText: string): unknown {
  return { status, statusText, internal: false, data: null };
}

function render(error: unknown): string {
  return renderToString(
    <MemoryRouter>
      <ErrorBoundary error={error} params={{}} />
    </MemoryRouter>,
  );
}

// The root route has no meta export, so the ErrorBoundary must render its own
// <title> — otherwise 404/500 pages ship with no document title (WCAG 2.4.2).
describe("root ErrorBoundary", () => {
  it("renders a document <title> for 404s", () => {
    const html = render(routeErrorResponse(404, "Not Found"));
    expect(html).toContain("<title>404 — no blip here — agentblip</title>");
  });

  it("renders a document <title> for other route errors", () => {
    const html = render(routeErrorResponse(500, "Internal Server Error"));
    expect(html).toContain("<title>500 — agentblip</title>");
  });

  it("renders a document <title> for unexpected errors", () => {
    const html = render(new Error("boom"));
    expect(html).toContain("<title>signal lost — agentblip</title>");
  });
});
