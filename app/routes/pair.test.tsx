import { renderToString } from "react-dom/server";
import { MemoryRouter } from "react-router";
import { describe, expect, it } from "vitest";
import type { Route } from "./+types/pair";
import Pair from "./pair";

const WARNING = "Only continue if this code matches what your terminal shows.";

function render(loaderData: Route.ComponentProps["loaderData"]): string {
  // Route.ComponentProps carries framework-internal `matches` typing that only
  // exists inside a real RR7 render; the component reads loaderData alone.
  const props = { loaderData, params: {}, matches: [] } as unknown as
    Route.ComponentProps;
  return renderToString(
    <MemoryRouter>
      <Pair {...props} />
    </MemoryRouter>,
  );
}

// OAuth phishing hardening: a ?code link someone sends you must not feel
// auto-magical — the form still requires an explicit click, and prefilled
// codes get a verify-against-your-terminal warning.
describe("/pair with a prefilled ?code", () => {
  it("shows the terminal-match warning and still requires a submit", () => {
    const html = render({ code: "ABCD1234", done: false, team: null, error: null });
    expect(html).toContain(WARNING);
    expect(html).toContain('type="submit"');
    // never auto-submits: no script-driven submission is rendered
    expect(html).not.toContain(".submit()");
  });

  it("omits the warning when no code is prefilled", () => {
    const html = render({ code: "", done: false, team: null, error: null });
    expect(html).not.toContain(WARNING);
  });
});
