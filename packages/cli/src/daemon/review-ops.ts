import { HUB_REVIEW_AGENTS, HUB_REVIEW_ROUNDS_MAX } from "@workmesh/protocol";
import type { HubHandoffAccepted } from "@workmesh/protocol";
import { CoordClient } from "../hub/coord";
import type { ReviewSettings } from "../lib/config";
import type { PersonRef } from "../lib/person";
import { samePerson } from "../lib/person";
import { label, oneLine } from "../lib/untrusted";
import type { CoordOpResult } from "./coord-ops";
import { findingCounts, reviewView } from "./review-text";

/**
 * Review exchange operations for the MCP server and the CLI (docs/SPEC.md §53): the list of reviews this person asked
 * for or runs, one review in full, and this machine's review policy. Asking for a review is in daemon/reviews.ts.
 */

export interface ReviewOpsDeps {
  request(
    key: string | undefined,
    args: { pr?: string | number; repo?: string; focus?: string; count?: number },
    o: { reviewers?: Array<{ person: string; email?: string }>; cwd?: string },
  ): Promise<CoordOpResult>;
  /** This machine's review settings as its config has them now. */
  settings(): ReviewSettings;
  /** Writes a change to this machine's review settings (config `reviews`) and answers the new ones. */
  save(patch: Partial<Record<keyof ReviewSettings, unknown>>): ReviewSettings;
}

type Args = Record<string, unknown>;

const fail = (text: string, data?: unknown): CoordOpResult => ({ ok: false, text, data });

function reviewLine(h: HubHandoffAccepted, me: PersonRef): string {
  const ref = `${h.repo ?? "?"}#${h.review?.pr ?? "?"}`;
  const mine = samePerson(me, h.to);
  const who = mine ? `for ${label(h.from.person)}` : `by ${label(h.to.person)}`;
  const o = h.review?.outcome;
  const counts = o ? findingCounts(o) : "";
  const outcome = o ? ` · ${o.verdict.replace("_", " ")}${counts ? ` (${counts})` : ""}${o.posted ? " · posted" : ""}` : "";
  return `- ${h.id} · PR ${ref} · round ${h.review?.round ?? 1} of ${h.review?.rounds ?? HUB_REVIEW_ROUNDS_MAX} · ${h.status} · ${who}${outcome}`;
}

/** `reviews` (list) and `reviews show <id>`: reviews this person's sessions asked for, and ones they run. */
export async function reviewsOp(
  a: Args,
  ctx: { coord: CoordClient; key: string | undefined; deps: ReviewOpsDeps | undefined; myself: PersonRef },
): Promise<CoordOpResult> {
  const { coord, myself } = ctx;
  if (!coord.reviewsAvailable()) return fail("This team's hub has no review exchange yet.");
  await coord.refreshed();
  const all = (coord.view().state?.handoffs ?? []).filter((h) => h.kind === "review");
  const id = typeof a.id === "string" && a.id.trim() ? a.id.trim().slice(0, 64) : undefined;
  if (id || a.action === "show") {
    if (!id) return fail("`reviews show` needs the review's id (`reviews` lists them).");
    const h = all.find((x) => x.id === id);
    if (!h) return fail(`No review ${oneLine(id, 64)} for you or from you in the hub's list (\`reviews\` lists them).`);
    const r = await coord.review({ action: "result", id });
    if (!r.ok) return fail(`Workmesh: ${oneLine(r.error, 300)}`);
    if (!r.body.ok) return fail(`Workmesh: ${oneLine(r.body.error, 300) || "the hub didn't send the review"}`);
    return { ok: true, text: reviewView(h, r.body.result), data: { review: h, result: r.body.result } };
  }
  // A session sees the reviews it asked for; the person at a terminal sees all of theirs.
  const fromHere = (h: HubHandoffAccepted): boolean => {
    if (!ctx.key) return true;
    const local = h.from.sessionKey ? coord.localKey(h.from.sessionKey) : undefined;
    return local !== undefined && CoordClient.family(local) === CoordClient.family(ctx.key);
  };
  const asked = all.filter((h) => samePerson(myself, h.from) && fromHere(h));
  const running = ctx.key ? [] : all.filter((h) => samePerson(myself, h.to));
  const lines: string[] = [];
  if (asked.length) lines.push("Reviews you asked for:", ...asked.slice(0, 20).map((h) => reviewLine(h, myself)));
  if (running.length) lines.push("Reviews asked of you:", ...running.slice(0, 20).map((h) => reviewLine(h, myself)));
  if (lines.length === 0) return { ok: true, text: "No agent reviews yet (`request_review` asks for one).", data: { reviews: [] } };
  lines.push("`reviews show <id>` prints one review's findings.");
  return { ok: true, text: lines.join("\n"), data: { reviews: [...asked, ...running] } };
}

const POLICY_WORDS: Record<ReviewSettings["accept"], string> = {
  ask: "a review a teammate asks of you waits for your Accept (menu bar, board or `workmesh handoffs accept`)",
  auto:
    "a review a teammate asks of you starts on this machine with no click. It is read-only: a fresh checkout of the PR's head, no push, merge, approval or GitHub write. " +
    "It trusts the hub to route reviews to you, and every teammate and token that can ask for one",
  never: "this machine runs no reviews (the hub asks someone else)",
};

/** `review_policy`: show or change this machine's review settings. Only a person's own terminal gets here. */
export function reviewPolicyOp(a: Args, deps: ReviewOpsDeps): CoordOpResult {
  const patch: Partial<Record<keyof ReviewSettings, unknown>> = {};
  const accept = typeof a.accept === "string" ? a.accept.trim().toLowerCase() : undefined;
  if (accept !== undefined) {
    if (accept !== "auto" && accept !== "ask" && accept !== "never") return fail(`Unknown review policy "${oneLine(accept, 40)}": use auto, ask or never.`);
    patch.accept = accept;
  }
  const onOff = (v: unknown): boolean | null | undefined => {
    if (typeof v === "boolean") return v;
    if (typeof v !== "string") return undefined;
    const t = v.trim().toLowerCase();
    return t === "on" || t === "true" || t === "yes" ? true : t === "off" || t === "false" || t === "no" ? false : t === "hub" || t === "default" ? null : undefined;
  };
  if (a.post !== undefined) {
    const v = onOff(a.post);
    if (v === undefined || v === null) return fail("`--post` is on or off.");
    patch.postToGitHub = v;
  }
  if (a.auto !== undefined) {
    const v = onOff(a.auto);
    if (v === undefined) return fail("`--auto` is on, off, or hub (your board setting).");
    patch.auto = v;
  }
  if (typeof a.agent === "string") {
    const v = a.agent.trim().toLowerCase();
    const valid = [...HUB_REVIEW_AGENTS, "auto", "default"];
    if (!valid.includes(v)) return fail(`\`--agent\` is ${HUB_REVIEW_AGENTS.join(", ")}, auto, or default.`);
    patch.agent = v === "default" ? null : v;
  }
  if (typeof a.model === "string") {
    const v = a.model.trim();
    if (v !== "default" && !/^[\w.:[\]/-]{1,80}$/.test(v)) return fail("`--model` is a model name, e.g. sonnet or gpt-5.5 (or default).");
    patch.model = v === "default" ? null : v;
  }
  if (a.count !== undefined) {
    const n = typeof a.count === "number" ? a.count : Number.parseInt(String(a.count), 10);
    if (n !== 1 && n !== 2) return fail("`--count` is 1 or 2.");
    patch.count = n;
  }
  const s = Object.keys(patch).length > 0 ? deps.save(patch) : deps.settings();
  const lines = [
    `${s.accept}: ${POLICY_WORDS[s.accept]}.`,
    `Posting on the PR: ${s.postToGitHub ? "on (a plain comment through your own gh, never an approval)" : "off (findings go to the asker and the board only)"}.`,
    `Reviews run on: ${s.agent ?? "claude when installed, else codex"}${s.model ? ` (${s.model})` : ""}.`,
    `Asking for a review when your PR is ready: ${s.auto === undefined ? "your board setting" : s.auto ? "on" : "off"}; reviewers per request: ${s.count}.`,
  ];
  return { ok: true, text: lines.join("\n"), data: { reviews: s } };
}
