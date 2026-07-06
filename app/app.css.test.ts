import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// read the source directly — vitest's css pipeline intercepts `?raw` imports
const css = readFileSync(new URL("./app.css", import.meta.url), "utf8");

/** Backgrounds that fg-faint text actually sits on. */
const SLACK_CARD_BG = "#1a1d21"; // hardcoded card bg in SlackStatusDemo.tsx

function token(name: string): string {
  const match = css.match(
    new RegExp(`--color-${name}:\\s*(#[0-9a-fA-F]{6})\\s*;`),
  );
  const hex = match?.[1];
  if (!hex) throw new Error(`--color-${name} not found in app.css`);
  return hex;
}

/** WCAG 2.x relative luminance. */
function luminance(hex: string): number {
  const channels = [1, 3, 5].map((i) => {
    const v = parseInt(hex.slice(i, i + 2), 16) / 255;
    return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  }) as [number, number, number];
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
}

/** WCAG 2.x contrast ratio (order-independent). */
function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (hi + 0.05) / (lo + 0.05);
}

// Regression guard for the WCAG AA finding: --color-fg-faint styles meaningful
// 11–14px text (pair form label/hint, granularity table headers, footer
// attribution, Slack demo captions), which requires >= 4.5:1 contrast.
describe("app.css color tokens — WCAG AA contrast", () => {
  const backgrounds: Array<[string, string]> = [
    ["ink-950 (page bg)", token("ink-950")],
    ["ink-900 (cards)", token("ink-900")],
    ["Slack demo card", SLACK_CARD_BG],
  ];

  for (const [label, bg] of backgrounds) {
    it(`fg-faint meets 4.5:1 on ${label}`, () => {
      expect(contrast(token("fg-faint"), bg)).toBeGreaterThanOrEqual(4.5);
    });

    it(`fg-muted meets 4.5:1 on ${label}`, () => {
      expect(contrast(token("fg-muted"), bg)).toBeGreaterThanOrEqual(4.5);
    });
  }

  it("keeps the fg hierarchy: fg brighter than fg-muted brighter than fg-faint", () => {
    expect(luminance(token("fg"))).toBeGreaterThan(luminance(token("fg-muted")));
    expect(luminance(token("fg-muted"))).toBeGreaterThan(
      luminance(token("fg-faint")),
    );
  });
});
