import { describe, expect, it } from "vitest";
import { SessionStore } from "../src/aggregate";
import { formatStatus } from "../src/format";
import type { SessionEvent } from "../src/events";

const NOW = 1_700_000_000_000;

function snapFrom(events: Array<Partial<SessionEvent>>) {
  const store = new SessionStore();
  events.forEach((e, i) =>
    store.apply(
      {
        source: "claude-code",
        sessionId: `s${i}`,
        kind: "working",
        ...e,
      },
      NOW + i,
    ),
  );
  return store.snapshot();
}

describe("formatStatus", () => {
  it("returns null when nothing is live or granularity is off", () => {
    expect(formatStatus(snapFrom([]), {}, NOW)).toBeNull();
    expect(
      formatStatus(snapFrom([{}]), { granularity: "off" }, NOW),
    ).toBeNull();
    // idle-only sessions clear the status too
    expect(formatStatus(snapFrom([{ kind: "idle" }]), {}, NOW)).toBeNull();
  });

  it("formats count granularity singular and plural", () => {
    expect(formatStatus(snapFrom([{}]), {}, NOW)?.text).toBe(
      "claude agent working",
    );
    expect(formatStatus(snapFrom([{}, {}, {}]), {}, NOW)?.text).toBe(
      "3 agents working",
    );
  });

  it("formats activity granularity", () => {
    const one = formatStatus(
      snapFrom([{ activity: "finalizing CI/CD" }]),
      { granularity: "activity" },
      NOW,
    );
    expect(one?.text).toBe("claude: finalizing CI/CD");

    const many = formatStatus(
      snapFrom([{}, { activity: "fixing tests", ts: NOW + 99 }]),
      { granularity: "activity" },
      NOW,
    );
    expect(many?.text).toBe("2 agents · fixing tests");
  });

  it("falls back to count text when activity granularity has no label", () => {
    expect(
      formatStatus(snapFrom([{}]), { granularity: "activity" }, NOW)?.text,
    ).toBe("claude agent working");
  });

  it("presence granularity hides everything", () => {
    const s = formatStatus(
      snapFrom([{ activity: "secret work" }, {}]),
      { granularity: "presence" },
      NOW,
    );
    expect(s?.text).toBe("heads down with agents");
  });

  it("appends waiting suffix and uses waiting emoji when only waiting", () => {
    const mixed = formatStatus(snapFrom([{}, { kind: "waiting" }]), {}, NOW);
    expect(mixed?.text).toBe("claude agent working · 1 waiting on me");
    expect(mixed?.emoji).toBe(":robot_face:");

    const waitingOnly = formatStatus(snapFrom([{ kind: "waiting" }]), {}, NOW);
    expect(waitingOnly?.text).toBe("1 agent(s) waiting on me");
    expect(waitingOnly?.emoji).toBe(":raised_hand:");
  });

  it("honors custom templates and emoji", () => {
    const s = formatStatus(
      snapFrom([{}]),
      {
        templates: { workingOne: "🛠 {agent} on the case" },
        emoji: { working: ":hammer:" },
      },
      NOW,
    );
    expect(s?.text).toBe("🛠 claude on the case");
    expect(s?.emoji).toBe(":hammer:");
  });

  it("repoPrefix leads with the repo name in activity mode", () => {
    const one = formatStatus(
      snapFrom([{ activity: "editing README.md", project: "b3iq" }]),
      { granularity: "activity", repoPrefix: true },
      NOW,
    );
    expect(one?.text).toBe("b3iq: editing README.md");

    const many = formatStatus(
      snapFrom([{}, { activity: "running tests", project: "b3iq", ts: NOW + 99 }]),
      { granularity: "activity", repoPrefix: true },
      NOW,
    );
    expect(many?.text).toBe("2 agents · b3iq: running tests");
  });

  it("repoPrefix suppresses the duplicate (project) suffix", () => {
    const s = formatStatus(
      snapFrom([{ activity: "editing README.md", project: "b3iq" }]),
      { granularity: "activity", repoPrefix: true, showProject: true },
      NOW,
    );
    expect(s?.text).toBe("b3iq: editing README.md");
  });

  it("repoPrefix falls back to the agent prefix when no project is known", () => {
    const s = formatStatus(
      snapFrom([{ activity: "finalizing CI/CD" }]),
      { granularity: "activity", repoPrefix: true },
      NOW,
    );
    expect(s?.text).toBe("claude: finalizing CI/CD");
  });

  it("repoPrefix only affects activity granularity", () => {
    const s = formatStatus(
      snapFrom([{ activity: "editing README.md", project: "b3iq" }]),
      { granularity: "count", repoPrefix: true },
      NOW,
    );
    expect(s?.text).toBe("claude agent working");
  });

  it("shows project when asked and redacts patterns", () => {
    const s = formatStatus(
      snapFrom([{ activity: "editing secret-payments.ts", project: "acme-internal" }]),
      {
        granularity: "activity",
        showProject: true,
        redactPatterns: ["secret", "acme"],
      },
      NOW,
    );
    expect(s?.text).toBe("claude: editing …-payments.ts (…-internal)");
  });

  it("truncates to Slack's 100-char limit", () => {
    const s = formatStatus(
      snapFrom([{ activity: "x".repeat(200) }]),
      { granularity: "activity" },
      NOW,
    );
    expect(s?.text.length).toBeLessThanOrEqual(100);
    expect(s?.text.endsWith("…")).toBe(true);
  });

  it("sets rolling expiration and allows disabling it", () => {
    const s = formatStatus(snapFrom([{}]), { statusTtlSec: 300 }, NOW);
    expect(s?.expirationSec).toBe(Math.floor(NOW / 1000) + 300);
    const noTtl = formatStatus(snapFrom([{}]), { statusTtlSec: 0 }, NOW);
    expect(noTtl?.expirationSec).toBe(0);
  });
});
