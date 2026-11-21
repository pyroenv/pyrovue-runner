import type { LearningStat } from "../learning";
import type { Plan } from "./plan";
import type { RepairMatch } from "./repairs";

/**
 * Learning from outcomes without a model: every strategy and repair rule has a Beta prior built from the evidence
 * (a prior of 0.7 counts as 2.8 successes and 1.2 failures), and each recorded setup adds a real success or failure.
 * Candidates are tried in order of posterior mean. No sampling, so the same history always gives the same order.
 */

/** The slice of LearningRepo the ranking reads and writes. */
export interface LearningSource {
  stats(scope: string): LearningStat[];
  /** `subject` names what was set up (the repo at its commit), so the store can count it only once. */
  record?(scope: string, key: string, ok: boolean, subject?: string): void;
}

/** How many observations the evidence prior is worth. */
export const PRIOR_STRENGTH = 4;
/** Outcomes from other projects in the same language count for half. */
const LANGUAGE_WEIGHT = 0.5;

export function posteriorMean(prior: number, successes = 0, failures = 0, strength = PRIOR_STRENGTH): number {
  const p = Math.min(0.99, Math.max(0.01, prior));
  return (p * strength + successes) / (strength + successes + failures);
}

/** Learning scopes for a stack signature: the exact one ("strategy:node:vite:pnpm") and its language ("strategy:node"). */
export function strategyScopes(signature: string): { exact: string; language: string | null } {
  const language = signature.split(":")[0]!;
  return { exact: `strategy:${signature}`, language: language && language !== signature ? `strategy:${language}` : null };
}

export const REPAIR_SCOPE = "repair";

function lookup(learning: LearningSource | undefined, scope: string | null): Map<string, LearningStat> {
  const out = new Map<string, LearningStat>();
  if (!learning || !scope) return out;
  try {
    for (const s of learning.stats(scope)) out.set(s.key, s);
  } catch {
    // Learning is an optimisation; a failing read must never break a setup.
  }
  return out;
}

/**
 * The key a plan's outcomes are recorded and read under: its strategy, with plans that start nothing kept apart
 * ("framework:install"). "The install worked" is then never counted as "the app started": a stack's libraries can't
 * make its servers look proven, and its failing servers can't make its installs look broken.
 */
export function outcomeKey(plan: Plan): string | undefined {
  if (!plan.strategy) return undefined;
  return plan.start === null ? `${plan.strategy}:install` : plan.strategy;
}

/** What this exact stack has recorded for plans of this plan's strategy and kind. */
export function recordedOutcomes(plan: Plan, learning?: LearningSource): { successes: number; failures: number } {
  const key = outcomeKey(plan);
  const stat = plan.signature && key ? lookup(learning, strategyScopes(plan.signature).exact).get(key) : undefined;
  return { successes: stat?.successes ?? 0, failures: stat?.failures ?? 0 };
}

/** The posterior probability that this plan works, given its evidence prior and what earlier setups recorded. */
export function planScore(plan: Plan, exact: Map<string, LearningStat>, language: Map<string, LearningStat>): number {
  const prior = plan.prior ?? 0.5;
  const key = outcomeKey(plan);
  if (!key) return prior;
  const e = exact.get(key);
  const l = language.get(key);
  const s = (e?.successes ?? 0) + LANGUAGE_WEIGHT * (l?.successes ?? 0);
  const f = (e?.failures ?? 0) + LANGUAGE_WEIGHT * (l?.failures ?? 0);
  return posteriorMean(prior, s, f);
}

/** Orders plans best first. Ties keep the evidence order. */
export function rankPlans(plans: Plan[], learning?: LearningSource): Plan[] {
  const signature = plans.find((p) => p.signature)?.signature;
  const scopes = signature ? strategyScopes(signature) : null;
  const exact = lookup(learning, scopes?.exact ?? null);
  const language = lookup(learning, scopes?.language ?? null);
  return plans
    .map((plan, i) => ({ plan, i, score: planScore(plan, exact, language) }))
    .sort((a, b) => b.score - a.score || (b.plan.prior ?? 0) - (a.plan.prior ?? 0) || a.i - b.i)
    .map((x) => x.plan);
}

/**
 * How much to trust the detector's plan for this kind of project (0-1), from its evidence and its track record.
 * Only this exact stack's record counts: a failure on one stack mustn't send every stack in its language to a
 * fallback first (where the detector stops running, so nothing would win its trust back).
 */
export function detectorTrust(plan: Plan, learning?: LearningSource): number {
  if (!plan.signature) return plan.prior ?? 0.5;
  const scopes = strategyScopes(plan.signature);
  return planScore(plan, lookup(learning, scopes.exact), new Map());
}

export function recordPlan(learning: LearningSource | undefined, plan: Plan, ok: boolean, subject?: string) {
  const key = outcomeKey(plan);
  if (!learning?.record || !key || !plan.signature) return;
  const scopes = strategyScopes(plan.signature);
  try {
    learning.record(scopes.exact, key, ok, subject);
    if (scopes.language) learning.record(scopes.language, key, ok, subject);
  } catch {
    // See lookup().
  }
}

/** Orders matching repair rules by their posterior: the knowledge base's prior, updated by how often each fixed things. */
export function rankRepairs(matches: RepairMatch[], learning?: LearningSource): RepairMatch[] {
  const stats = lookup(learning, REPAIR_SCOPE);
  return matches
    .map((m, i) => {
      const s = stats.get(m.rule.id);
      return { m, i, score: posteriorMean(m.rule.prior ?? 0.5, s?.successes ?? 0, s?.failures ?? 0) };
    })
    .sort((a, b) => b.score - a.score || a.i - b.i)
    .map((x) => x.m);
}

export function recordRepair(learning: LearningSource | undefined, ruleId: string, ok: boolean) {
  if (!learning?.record) return;
  try {
    learning.record(REPAIR_SCOPE, ruleId, ok);
  } catch {
    // See lookup().
  }
}
