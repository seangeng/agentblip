import { z } from "zod";
import { HUB_REPO_RE, hubPersonEmailAcceptSchema, hubPersonEmailSchema } from "./fields.js";
import { isLeasePath, LEASE_PATH_MAX } from "./lease-paths.js";

/**
 * Review exchange (docs/SPEC.md §52): agents ask for PR reviews from teammates' agents. A review is a read-only
 * handoff (§30) of kind `review` to another person: their relay checks the PR's head out on its own, runs their agent
 * CLI with no way to push, merge or approve, and reports structured findings. The findings go back to the author's
 * session as data, to the board, and (only when the reviewer opted in) to the PR as a plain review comment through
 * the reviewer's own `gh`. An agent review never approves or merges: a person's approval stays required.
 *
 * Additive to v2: one new endpoint (`POST /relay/reviews`), two optional fields on a handoff (`kind`, `review`), and
 * one optional object on `GET /relay/sync` (`reviews`). An older hub answers `404` and sends no `reviews`; a relay
 * then offers no reviews. A hub sends a review handoff only to machines that told it their review policy
 * (`action: "policy"`), so a relay that predates reviews never sees one and can't run one as a task.
 *
 * Two readings per body, as everywhere (§14): the relay builds requests from the strict schemas and reads answers with
 * the accept schemas; the hub reads requests with the request accept schemas and builds answers from the response
 * schemas (test/review.test.ts).
 */

// ------------------------------------------------------------------ limits

/** Rounds of agent review one PR gets; then it is a person's turn (§52). */
export const HUB_REVIEW_ROUNDS_MAX = 3;
/** Reviewers one round asks at most. */
export const HUB_REVIEW_REVIEWERS_MAX = 2;
/** What the author wants looked at ("the retry logic in vault/"). */
export const HUB_REVIEW_FOCUS_MAX = 1000;
/** The changed files a request names (repo-relative, the PR's own list). */
export const HUB_REVIEW_PATHS_MAX = 300;
/** CODEOWNERS owners of those files a request names. */
export const HUB_REVIEW_OWNERS_MAX = 50;
export const HUB_REVIEW_OWNER_MAX = 120;
/** Findings one review reports at most. */
export const HUB_REVIEW_FINDINGS_MAX = 50;
export const HUB_REVIEW_SUMMARY_MAX = 2000;
export const HUB_REVIEW_FINDING_MAX = 500;
export const HUB_REVIEW_SUGGESTION_MAX = 2000;
export const HUB_REVIEW_MODEL_MAX = 80;
/** A PR number. */
export const HUB_PR_NUMBER_MAX = 1e9;

// ------------------------------------------------------------------ vocabularies

/** How bad a finding is: `high` (a bug, a hole, data loss), `medium` (should be fixed), `low` (could be better), `nit`. */
export const HUB_REVIEW_SEVERITIES = ["high", "medium", "low", "nit"] as const;
export const hubReviewSeveritySchema = z.enum(HUB_REVIEW_SEVERITIES);
export type HubReviewSeverity = z.infer<typeof hubReviewSeveritySchema>;

/**
 * What a review concluded. There is no "approve": an agent review is a comment, and a person approves the PR (§52).
 * `no_issues` (nothing found worth raising), `comments` (only low or nit findings), `changes_suggested` (a high or
 * medium finding).
 */
export const HUB_REVIEW_VERDICTS = ["no_issues", "comments", "changes_suggested"] as const;
export const hubReviewVerdictSchema = z.enum(HUB_REVIEW_VERDICTS);
export type HubReviewVerdict = z.infer<typeof hubReviewVerdictSchema>;

/** The agent CLIs a relay runs for read-only PR reviews (SPEC §53, §61). */
export const HUB_REVIEW_AGENTS = [
  "claude",
  "codex",
  "opencode",
  "gemini",
  "antigravity",
  "grok",
  "cursor",
  "amp",
] as const;
export const hubReviewAgentSchema = z.enum(HUB_REVIEW_AGENTS);
export type HubReviewAgent = z.infer<typeof hubReviewAgentSchema>;

/** A person's rule for review handoffs on one machine: run them at once, wait for the person, or never run them. */
export const HUB_REVIEW_ACCEPTS = ["auto", "ask", "never"] as const;
export const hubReviewAcceptSchema = z.enum(HUB_REVIEW_ACCEPTS);
export type HubReviewAcceptPolicy = z.infer<typeof hubReviewAcceptSchema>;

/**
 * Why the hub picked a reviewer (§52 routing, in order): the author named them, they own the changed paths
 * (CODEOWNERS), their sessions recently worked those paths, or they are online and idle.
 */
export const HUB_REVIEW_WHYS = ["asked", "codeowner", "recent", "available"] as const;
export const hubReviewWhySchema = z.enum(HUB_REVIEW_WHYS);
export type HubReviewWhy = z.infer<typeof hubReviewWhySchema>;

/** Whether the reviewer's agent ran the PR's tests or build. */
export const HUB_REVIEW_TESTS = ["passed", "failed", "not_run"] as const;
export const hubReviewTestsSchema = z.enum(HUB_REVIEW_TESTS);

// ------------------------------------------------------------------ fields

const sessionKey = z.string().min(1).max(200);
const repoName = z.string().max(200).regex(HUB_REPO_RE, "repo must be owner/name");
const recordId = z.string().min(1).max(64);
const personName = z.string().min(1).max(120);
const prNumber = z.number().int().min(1).max(HUB_PR_NUMBER_MAX);
const round = z.number().int().min(1).max(HUB_REVIEW_ROUNDS_MAX);
const sha = z.string().regex(/^[0-9a-f]{7,40}$/, "a commit sha");
const filePath = z.string().max(LEASE_PATH_MAX).refine(isLeasePath, "a repo-relative path");
const lineNo = z.number().int().min(1).max(1e7);
const model = z.string().min(1).max(HUB_REVIEW_MODEL_MAX);
/** A CODEOWNERS owner as the file writes it: `@login`, `@org/team` or an email. */
const owner = z
  .string()
  .min(2)
  .max(HUB_REVIEW_OWNER_MAX)
  .regex(/^(?:@[\w.-]+(?:\/[\w.-]+)?|[^\s@]+@[^\s@]+)$/, "a CODEOWNERS owner");

const opt = <T extends z.ZodType>(t: T) => t.nullish().transform((v) => v ?? undefined);
const soft = <T extends z.ZodType>(t: T) =>
  t
    .nullish()
    .catch(undefined)
    .transform((v) => v ?? undefined);
const cut = (max: number) => z.string().transform((s) => s.slice(0, max));
/** Text over a cap is cut by the reader rather than failing (a relay's redaction can lengthen it). */
const textAccept = (max: number) =>
  z
    .string()
    .min(1)
    .max(4 * max)
    .transform((s) => s.slice(0, max));
const keepValid = <T extends z.ZodType>(item: T, max: number) =>
  z
    .array(z.unknown())
    .catch([])
    .transform((items) => {
      const out: z.infer<T>[] = [];
      for (const it of items) {
        const r = item.safeParse(it);
        if (r.success && out.length < max) out.push(r.data);
      }
      return out;
    });
const unique = (a: readonly string[]): boolean => new Set(a).size === a.length;

// ------------------------------------------------------------------ a review handoff (§30 handoff fields)

/** How a finished review came out, in numbers: what a sync's handoff carries (the findings come with `result`). */
export const hubReviewOutcomeSchema = z.object({
  verdict: hubReviewVerdictSchema,
  high: z.number().int().min(0).max(HUB_REVIEW_FINDINGS_MAX),
  medium: z.number().int().min(0).max(HUB_REVIEW_FINDINGS_MAX),
  low: z.number().int().min(0).max(HUB_REVIEW_FINDINGS_MAX),
  nit: z.number().int().min(0).max(HUB_REVIEW_FINDINGS_MAX),
  /** The reviewer's relay posted it on the PR as a comment (§53). */
  posted: z.literal(true).optional(),
});
export type HubReviewOutcome = z.infer<typeof hubReviewOutcomeSchema>;
const count = z.number().int().min(0).max(HUB_REVIEW_FINDINGS_MAX).catch(0);
const outcomeAccept = z.object({
  verdict: hubReviewVerdictSchema,
  high: count,
  medium: count,
  low: count,
  nit: count,
  posted: soft(z.literal(true)),
});

/**
 * `review` on a handoff of kind `review` (§30): which PR, which round, what to look at, and why this reviewer. The
 * task text of such a handoff is the hub's own line ("Review PR #212 in b3-fun/x, round 1 of 3"); the relay builds
 * the agent's prompt from these fields, never from the task.
 */
export const hubHandoffReviewSchema = z.object({
  pr: prNumber,
  round,
  /** The rounds this PR may get (HUB_REVIEW_ROUNDS_MAX unless the hub says fewer). */
  rounds: round.optional(),
  focus: z.string().min(1).max(HUB_REVIEW_FOCUS_MAX).optional(),
  /** The head commit the author asked about (the reviewer reviews the PR's head as it finds it). */
  headSha: sha.optional(),
  why: hubReviewWhySchema.optional(),
  /** The author's agent CLI and model, so the reviewer can say whether a second harness looked. */
  authorAgent: hubReviewAgentSchema.optional(),
  /** Once done: how it came out. */
  outcome: hubReviewOutcomeSchema.optional(),
});
export type HubHandoffReview = z.infer<typeof hubHandoffReviewSchema>;
export const hubHandoffReviewAcceptSchema = z.object({
  pr: prNumber,
  round,
  rounds: soft(round),
  focus: soft(z.string().min(1).transform((s) => s.slice(0, HUB_REVIEW_FOCUS_MAX))),
  headSha: soft(sha),
  why: soft(hubReviewWhySchema),
  authorAgent: soft(hubReviewAgentSchema),
  outcome: soft(outcomeAccept),
});
export type HubHandoffReviewAccepted = z.infer<typeof hubHandoffReviewAcceptSchema>;

/** A handoff's kind: absent is a task (§30). A relay drops a handoff whose kind it doesn't know. */
export const HUB_HANDOFF_KINDS = ["task", "review"] as const;
export const hubHandoffKindSchema = z.enum(HUB_HANDOFF_KINDS);
export type HubHandoffKind = z.infer<typeof hubHandoffKindSchema>;

// ------------------------------------------------------------------ findings and the result

/** One thing the reviewer's agent found: where, how bad, what, and what to do about it. */
export const hubReviewFindingSchema = z.object({
  file: filePath.optional(),
  line: lineNo.optional(),
  endLine: lineNo.optional(),
  severity: hubReviewSeveritySchema,
  summary: z.string().min(1).max(HUB_REVIEW_FINDING_MAX),
  suggestion: z.string().min(1).max(HUB_REVIEW_SUGGESTION_MAX).optional(),
});
export type HubReviewFinding = z.infer<typeof hubReviewFindingSchema>;
const findingAccept = z.object({
  file: soft(filePath),
  line: soft(lineNo),
  endLine: soft(lineNo),
  /** A severity this reader doesn't know reads as `low`, so a finding is never lost for its label. */
  severity: hubReviewSeveritySchema.catch("low"),
  summary: textAccept(HUB_REVIEW_FINDING_MAX),
  suggestion: soft(textAccept(HUB_REVIEW_SUGGESTION_MAX)),
});
export type HubReviewFindingAccepted = z.infer<typeof findingAccept>;

/** What a review reports (`action: "report"`), redacted on the reviewer's machine (§9). */
export const hubReviewResultSchema = z.object({
  verdict: hubReviewVerdictSchema,
  summary: z.string().min(1).max(HUB_REVIEW_SUMMARY_MAX),
  findings: z.array(hubReviewFindingSchema).max(HUB_REVIEW_FINDINGS_MAX),
  /** The commit the review looked at. */
  headSha: sha.optional(),
  agent: hubReviewAgentSchema.optional(),
  model: model.optional(),
  tests: hubReviewTestsSchema.optional(),
  /** Posted on the PR as a comment by the reviewer's own `gh` (only when they opted in, §53). */
  posted: z.literal(true).optional(),
});
export type HubReviewResult = z.infer<typeof hubReviewResultSchema>;
export const hubReviewResultAcceptSchema = z.object({
  verdict: hubReviewVerdictSchema.catch("comments"),
  summary: textAccept(HUB_REVIEW_SUMMARY_MAX),
  findings: keepValid(findingAccept, HUB_REVIEW_FINDINGS_MAX),
  headSha: soft(sha),
  agent: soft(hubReviewAgentSchema),
  model: soft(cut(HUB_REVIEW_MODEL_MAX)),
  tests: soft(hubReviewTestsSchema),
  posted: soft(z.literal(true)),
});
export type HubReviewResultAccepted = z.infer<typeof hubReviewResultAcceptSchema>;

/** The verdict a set of findings makes: a high or medium one suggests changes, only low or nit ones are comments. */
export function reviewVerdict(findings: ReadonlyArray<{ severity: HubReviewSeverity }>): HubReviewVerdict {
  if (findings.some((f) => f.severity === "high" || f.severity === "medium")) return "changes_suggested";
  return findings.length > 0 ? "comments" : "no_issues";
}

/** The numbers a sync carries for a finished review. */
export function reviewOutcome(result: {
  verdict: HubReviewVerdict;
  findings: ReadonlyArray<{ severity: HubReviewSeverity }>;
  posted?: true | undefined;
}): HubReviewOutcome {
  const n = (s: HubReviewSeverity) => result.findings.filter((f) => f.severity === s).length;
  return {
    verdict: result.verdict,
    high: n("high"),
    medium: n("medium"),
    low: n("low"),
    nit: n("nit"),
    ...(result.posted ? { posted: true as const } : {}),
  };
}

// ------------------------------------------------------------------ POST /relay/reviews

/** A reviewer the author names: a person (email or display name) with their email beside it when the relay knows it. */
const reviewerAsk = z.strictObject({ person: z.string().min(1).max(200), email: hubPersonEmailSchema.optional() });

/**
 * `POST /relay/reviews`.
 *
 * - `request`: the author's session (`from`; absent: the person at a terminal) asks for a review of `repo#pr`. The hub
 *   picks one reviewer (`count: 2` for two), never the author, routes as §52 says, and makes one review handoff per
 *   reviewer. `paths` and `owners` are what the author's checkout says about the PR: its changed files and their
 *   CODEOWNERS owners. `auto: true` says the relay asked by its person's standing rule, not the agent or the person.
 * - `policy`: this machine's rule for review handoffs (`accept`), the agent CLI and model it reviews with, and whether
 *   it posts its reviews on the PR. Sent at start and whenever it changes; a hub routes reviews only to people with a
 *   machine whose policy isn't `never`, and sends review handoffs only to machines that sent one.
 * - `report`: the reviewer's relay finished a review handoff it runs: the result, and the handoff is `done`.
 * - `result`: the whole result of a review handoff this machine's person sent or ran (a sync carries only its
 *   `outcome`).
 */
export const hubReviewRequestSchema = z.union([
  z.strictObject({
    action: z.literal("request"),
    from: sessionKey.optional(),
    repo: repoName,
    pr: prNumber,
    focus: z.string().min(1).max(HUB_REVIEW_FOCUS_MAX).optional(),
    reviewers: z.array(reviewerAsk).min(1).max(HUB_REVIEW_REVIEWERS_MAX).optional(),
    count: z.number().int().min(1).max(HUB_REVIEW_REVIEWERS_MAX).optional(),
    auto: z.literal(true).optional(),
    agent: hubReviewAgentSchema.optional(),
    model: model.optional(),
    headSha: sha.optional(),
    paths: z.array(filePath).max(HUB_REVIEW_PATHS_MAX).refine(unique, "paths must not repeat").optional(),
    owners: z.array(owner).max(HUB_REVIEW_OWNERS_MAX).refine(unique, "owners must not repeat").optional(),
  }),
  z.strictObject({
    action: z.literal("policy"),
    accept: hubReviewAcceptSchema,
    agent: hubReviewAgentSchema.optional(),
    model: model.optional(),
    post: z.boolean(),
  }),
  z.strictObject({
    action: z.literal("report"),
    id: recordId,
    sessionKey: sessionKey.optional(),
    result: hubReviewResultSchema,
  }),
  z.strictObject({ action: z.literal("result"), id: recordId }),
]);
export type HubReviewRequest = z.infer<typeof hubReviewRequestSchema>;

const reviewerAskAccept = z.object({ person: z.string().min(1).max(200), email: hubPersonEmailAcceptSchema });

export const hubReviewRequestAcceptSchema = z.union([
  z.object({
    action: z.literal("request"),
    from: opt(sessionKey),
    repo: repoName,
    pr: prNumber,
    focus: soft(textAccept(HUB_REVIEW_FOCUS_MAX)),
    reviewers: soft(keepValid(reviewerAskAccept, HUB_REVIEW_REVIEWERS_MAX)),
    count: soft(z.number().int().min(1).max(HUB_REVIEW_REVIEWERS_MAX)),
    auto: z.boolean().nullish().catch(undefined).transform((v) => v === true || undefined),
    agent: soft(hubReviewAgentSchema),
    model: soft(cut(HUB_REVIEW_MODEL_MAX)),
    headSha: soft(sha),
    paths: soft(keepValid(filePath, HUB_REVIEW_PATHS_MAX).transform((a) => [...new Set(a)])),
    owners: soft(keepValid(owner, HUB_REVIEW_OWNERS_MAX).transform((a) => [...new Set(a)])),
  }),
  z.object({
    action: z.literal("policy"),
    accept: hubReviewAcceptSchema,
    agent: soft(hubReviewAgentSchema),
    model: soft(cut(HUB_REVIEW_MODEL_MAX)),
    post: z.boolean().catch(false),
  }),
  z.object({
    action: z.literal("report"),
    id: recordId,
    sessionKey: opt(sessionKey),
    result: hubReviewResultAcceptSchema,
  }),
  z.object({ action: z.literal("result"), id: recordId }),
]);
export type HubReviewRequestAccepted = z.infer<typeof hubReviewRequestAcceptSchema>;

/** One review handoff a request made: its id, who reviews and why. */
export const hubReviewAssignedSchema = z.object({
  id: recordId,
  to: z.object({ person: personName, email: hubPersonEmailSchema.optional() }),
  why: hubReviewWhySchema,
  /** The agent CLI the reviewer's machine reviews with, when it said. */
  agent: hubReviewAgentSchema.optional(),
});
export type HubReviewAssigned = z.infer<typeof hubReviewAssignedSchema>;
const assignedAccept = z.object({
  id: recordId,
  to: z.object({ person: personName, email: hubPersonEmailAcceptSchema }),
  why: hubReviewWhySchema.catch("available"),
  agent: soft(hubReviewAgentSchema),
});

/**
 * Answers. `request` → 200 `{ ok: true, round, rounds, reviewers }`; `404` nobody else on the hub takes reviews (or a
 * named reviewer isn't on it); `409` the PR had its rounds, or a round is still open (`round` and `reviewers` say
 * which); `409` with `candidates` when a named reviewer fits more than one person. `policy` → `{ ok: true }`.
 * `report` → `{ ok: true }`; `404` no such review handoff for this machine; `409` its state doesn't allow it.
 * `result` → `{ ok: true, result }` (`result` absent while it runs). Errors are `{ ok: false, error }`.
 */
export const hubReviewResponseSchema = z.union([
  z.object({
    ok: z.literal(true),
    round: round.optional(),
    rounds: round.optional(),
    reviewers: z.array(hubReviewAssignedSchema).max(HUB_REVIEW_REVIEWERS_MAX).optional(),
    result: hubReviewResultSchema.optional(),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().max(300),
    round: round.optional(),
    reviewers: z.array(hubReviewAssignedSchema).max(HUB_REVIEW_REVIEWERS_MAX).optional(),
    candidates: z.array(z.object({ person: personName, email: hubPersonEmailSchema.optional() })).max(20).optional(),
  }),
]);
export type HubReviewResponse = z.infer<typeof hubReviewResponseSchema>;
export const hubReviewResponseAcceptSchema = z.union([
  z.object({
    ok: z.literal(true),
    round: soft(round),
    rounds: soft(round),
    reviewers: soft(keepValid(assignedAccept, HUB_REVIEW_REVIEWERS_MAX)),
    result: soft(hubReviewResultAcceptSchema),
  }),
  z.object({
    ok: z.literal(false),
    error: z.string().catch("").transform((s) => s.slice(0, 300)),
    round: soft(round),
    reviewers: soft(keepValid(assignedAccept, HUB_REVIEW_REVIEWERS_MAX)),
    candidates: soft(keepValid(z.object({ person: personName, email: hubPersonEmailAcceptSchema }), 20)),
  }),
]);
export type HubReviewResponseAccepted = z.infer<typeof hubReviewResponseAcceptSchema>;

// ------------------------------------------------------------------ sync addition

/**
 * `reviews` on `GET /relay/sync` (§52): present = this hub has the review exchange. `auto` is this device's person's
 * own board setting ("ask for an agent review when my PR is ready"); `autoRepos` the repos where every ready PR gets
 * one. Either makes the relay ask by itself when one of its sessions opens a PR (not a draft) or marks one ready. A
 * relay's own config can turn it on or off for its machine (§53).
 */
export const hubSyncReviewsSchema = z.object({
  reviews: z
    .object({
      auto: z.boolean(),
      autoRepos: z.array(repoName).max(500),
    })
    .optional(),
});
export type HubSyncReviews = z.infer<typeof hubSyncReviewsSchema>;
export const hubSyncReviewsAcceptSchema = z.object({
  reviews: soft(
    z.object({
      auto: z.boolean().catch(false),
      autoRepos: keepValid(repoName, 500),
    }),
  ),
});
export type HubSyncReviewsAccepted = z.infer<typeof hubSyncReviewsAcceptSchema>;
