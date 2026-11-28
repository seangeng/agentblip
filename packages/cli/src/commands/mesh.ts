import {
  HUB_CAPACITY_PROVIDERS,
  HUB_CAPACITY_SHARE_LEVELS,
  HUB_POOL_MODES,
  HUB_TASK_KINDS,
  type HubCapacityProvider,
  type HubCapacityShareLevel,
  type HubPoolMode,
  type HubTaskKind,
} from "@workmesh/protocol";
import {
  capacityShareLevel,
  loadConfig,
  poolRuleSchema,
  poolSettings,
  saveConfig,
  type Config,
} from "../lib/config";
import { formatFleetSummary, pickBestProvider, readFleetStatus } from "../lib/fleet";
import { POOL_RULES_MAX, poolRuleWords, type PoolRule } from "../daemon/pool-rules";
import { bold, confirm, dim, green, yellow } from "../lib/ui";

export interface MeshCommandDeps {
  load: () => Config;
  save: (c: Config) => void;
  isTerminal: () => boolean;
  ask: (question: string) => Promise<boolean>;
  print: (line: string) => void;
  fleetFile?: string;
}

const defaultDeps: MeshCommandDeps = {
  load: () => loadConfig(),
  save: (c) => saveConfig(c),
  isTerminal: () => Boolean(process.stdin.isTTY && process.stdout.isTTY),
  ask: (q) => confirm(q, false),
  print: (line) => console.log(line),
};

/**
 * `workmesh capacity [share <off|availability|detailed>] [--json]` (SPEC §57):
 * View local qswap fleet headroom and control opt-in capacity reporting to the hub.
 */
export async function runCapacity(
  action?: string,
  level?: string,
  opts: { json?: boolean } = {},
  deps: MeshCommandDeps = defaultDeps,
): Promise<void> {
  const config = deps.load();
  const current = capacityShareLevel(config);
  const fleet = readFleetStatus(deps.fleetFile);

  if (action === "share") {
    if (!level) {
      deps.print(`capacity sharing: ${bold(current)}`);
      return;
    }
    const v = level.trim().toLowerCase();
    if (!HUB_CAPACITY_SHARE_LEVELS.includes(v as HubCapacityShareLevel)) {
      throw new Error(`unknown capacity share level "${level}" — use off, availability, or detailed`);
    }
    config.capacity = { ...(config.capacity ?? {}), share: v as HubCapacityShareLevel };
    deps.save(config);
    const desc: Record<HubCapacityShareLevel, string> = {
      off: "nothing about your subscription headroom leaves this machine",
      availability: "coarse buckets only (abundant/moderate/tight/exhausted + reset countdown, no emails or dollar spend)",
      detailed: "headroom percentages, reset countdowns, and estimated API-equivalent value (never emails, keys, or org ids)",
    };
    deps.print(green(`capacity sharing: ${v}`));
    deps.print(`  ${desc[v as HubCapacityShareLevel]}`);
    return;
  }

  if (action !== undefined && action !== "status") {
    throw new Error(`unknown action "${action}" — use status or share <off|availability|detailed>`);
  }

  if (opts.json) {
    deps.print(JSON.stringify({ share: current, pool: poolSettings(config), fleet: fleet ?? null }, null, 2));
    return;
  }
  deps.print(`Capacity sharing to hub: ${bold(current)}`);
  deps.print(formatFleetSummary(fleet));
}

/**
 * `workmesh pool [status|on|off]` (SPEC §58):
 * Opt-in toggle for sharing spare subscription headroom with teammates (read-only & worktree PR tasks).
 */
export async function runPool(
  action?: string,
  opts: { json?: boolean } = {},
  deps: MeshCommandDeps = defaultDeps,
): Promise<void> {
  const config = deps.load();
  const pool = poolSettings(config);

  if (action === "on" || action === "enable") {
    if (!deps.isTerminal()) {
      deps.print("Not enabled: turn the delegation pool on from your own terminal.");
      return;
    }
    if (pool.rules.length === 0) {
      deps.print(yellow("note: pool has no rules yet — add one with `workmesh pool rule add --from team --providers codex,opencode --modes readonly,worktree`"));
    }
    config.pool = { ...(config.pool ?? {}), enabled: true, rules: pool.rules };
    deps.save(config);
    deps.print(green("delegation pool: ON (this machine will accept matching teammate tasks while live qswap headroom stays above your floor)"));
    return;
  }
  if (action === "off" || action === "disable" || action === "pause") {
    config.pool = { ...(config.pool ?? {}), enabled: false, rules: pool.rules };
    deps.save(config);
    deps.print(green("delegation pool: OFF (teammates' tasks will wait for manual Accept)"));
    return;
  }
  if (action !== undefined && action !== "status") {
    throw new Error(`unknown action "${action}" — use status, on, off, or rule`);
  }
  if (opts.json) {
    deps.print(JSON.stringify({ ...pool, capacityShare: capacityShareLevel(config) }, null, 2));
    return;
  }
  deps.print(`Delegation pool: ${pool.enabled ? green("ON") : dim("OFF")} (capacity sharing: ${capacityShareLevel(config)})`);
  if (pool.rules.length === 0) {
    deps.print(dim("no pool rules yet: `workmesh pool rule add --from team --providers codex,opencode,antigravity,grok --modes readonly,worktree --min-headroom 30`"));
  } else {
    pool.rules.forEach((r, i) => deps.print(`  ${i + 1}. ${poolRuleWords(r)}`));
  }
}

/**
 * `workmesh pool rule [list|add|remove <n>]` (SPEC §58):
 * Terminal-only consent for local capacity pool rules (worktree PR & readonly tasks).
 */
export async function runPoolRule(
  action: string | undefined,
  n: string | undefined,
  opts: {
    from?: string;
    providers?: string;
    modes?: string;
    repo?: string;
    minHeadroom?: string;
    expiringFloor?: string;
    perDay?: string;
  },
  deps: MeshCommandDeps = defaultDeps,
): Promise<void> {
  const config = deps.load();
  const pool = poolSettings(config);
  const write = (rules: PoolRule[], enabled = pool.enabled) => {
    config.pool = { ...(config.pool ?? {}), enabled, rules };
    deps.save(config);
  };

  if (action === undefined || action === "list") {
    if (pool.rules.length === 0) {
      deps.print(dim("no pool rules: add one with `workmesh pool rule add --from team --providers codex,opencode --modes readonly,worktree`"));
    }
    pool.rules.forEach((r, i) => deps.print(`${i + 1}. ${poolRuleWords(r)}`));
    return;
  }
  if (action === "remove" || action === "rm") {
    const i = Number(n) - 1;
    if (!Number.isInteger(i) || i < 0 || i >= pool.rules.length) {
      throw new Error(`\`workmesh pool rule remove <n>\` takes a rule number (1–${pool.rules.length || 1})`);
    }
    const gone = pool.rules[i]!;
    write(pool.rules.filter((_, j) => j !== i));
    deps.print(green(`removed: ${poolRuleWords(gone)}`));
    return;
  }
  if (action !== "add") throw new Error(`unknown action "${action}" — use list, add or remove`);

  const providers = (opts.providers ?? "codex,opencode")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean) as HubCapacityProvider[];
  const modes = (opts.modes ?? "readonly,worktree")
    .split(",")
    .map((x) => x.trim().toLowerCase())
    .filter(Boolean) as HubPoolMode[];

  const parsed = poolRuleSchema.safeParse({
    from: opts.from ?? "team",
    providers,
    modes,
    ...(opts.repo ? { repo: opts.repo } : {}),
    minHeadroom: opts.minHeadroom !== undefined ? Number(opts.minHeadroom) : 30,
    expiringFloor: opts.expiringFloor !== undefined ? Number(opts.expiringFloor) : 10,
    perDay: opts.perDay !== undefined ? Number(opts.perDay) : 10,
  });
  if (!parsed.success) {
    throw new Error(
      `invalid pool rule (${parsed.error.issues[0]?.message ?? "check flags"}). ` +
        `Valid providers: ${HUB_CAPACITY_PROVIDERS.join(", ")}. Valid modes: ${HUB_POOL_MODES.join(", ")}.`,
    );
  }
  const rule = parsed.data;
  if (pool.rules.length >= POOL_RULES_MAX) throw new Error(`at most ${POOL_RULES_MAX} pool rules; remove one first`);
  if (!deps.isTerminal()) {
    deps.print("Not added: there is no terminal to ask in. Add a pool rule in your own terminal.");
    return;
  }
  deps.print(`This machine will auto-accept and run tasks for ${bold(poolRuleWords(rule))}.`);
  deps.print(dim("Checks sender, repo, mode, daily count, and live qswap headroom on this machine before starting anything."));
  if (!(await deps.ask("Add this pool rule and enable the pool?"))) {
    deps.print("Not added.");
    return;
  }
  write([...pool.rules, rule], true);
  deps.print(green(`added (pool ON): ${poolRuleWords(rule)}`));
}

/**
 * `workmesh route [--task <kind>] [--caller <agent>] [--json]` (SPEC §61):
 * Recommend the best local AI subscription for a task from qswap's fleet_status.json.
 */
export async function runRoute(
  opts: { task?: string; caller?: string; json?: boolean } = {},
  deps: Pick<MeshCommandDeps, "print" | "fleetFile"> = defaultDeps,
): Promise<void> {
  const kindRaw = (opts.task ?? "coding").trim().toLowerCase();
  if (!HUB_TASK_KINDS.includes(kindRaw as HubTaskKind)) {
    throw new Error(`unknown task kind "${opts.task}" — use ${HUB_TASK_KINDS.join(", ")}`);
  }
  const taskKind = kindRaw as HubTaskKind;
  const caller = opts.caller?.trim().toLowerCase() || undefined;
  const fleet = readFleetStatus(deps.fleetFile);
  const best = pickBestProvider(fleet, { taskKind, ...(caller ? { caller } : {}) });
  const ranked = fleet?.recommendations[taskKind] ?? fleet?.recommendations.coding ?? [];

  if (opts.json) {
    deps.print(
      JSON.stringify(
        {
          task: taskKind,
          caller: caller ?? null,
          best: best ?? null,
          ranked,
          updatedAt: fleet?.updatedAt ?? null,
        },
        null,
        2,
      ),
    );
    return;
  }
  if (!fleet) {
    deps.print(dim("no qswap fleet_status.json found — run `qswap where` to refresh fleet capacity"));
    return;
  }
  if (!best) {
    deps.print(yellow(`no eligible provider with spare headroom for ${taskKind}`));
    return;
  }
  deps.print(`${green(best.provider)} (${best.reason}) — cli: ${bold(best.cli)}`);
  for (const alt of ranked.filter((r) => r.provider !== best.provider).slice(0, 4)) {
    deps.print(dim(`  alt: ${alt.provider} (${alt.reason})`));
  }
}
