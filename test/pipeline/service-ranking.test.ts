import { describe, expect, it } from "vitest";
import type { Plan } from "../../src/pipeline/plan";
import { detectorTrust, type LearningSource, rankPlans, recordPlan } from "../../src/pipeline/ranking";

/** An in-memory learning table, like LearningRepo: one row per (scope, key). */
function memoryLearning() {
  const rows = new Map<string, { key: string; successes: number; failures: number }>();
  const subjects: (string | undefined)[] = [];
  const learning: LearningSource = {
    stats: (scope) => [...rows.entries()].filter(([k]) => k.startsWith(`${scope}|`)).map(([, v]) => v),
    record(scope, key, ok, subject) {
      subjects.push(subject);
      const row = rows.get(`${scope}|${key}`) ?? { key, successes: 0, failures: 0 };
      if (ok) row.successes += 1;
      else row.failures += 1;
      rows.set(`${scope}|${key}`, row);
    },
  };
  return { learning, subjects };
}

const plan = (signature: string, strategy = "framework", prior = 0.8): Plan => ({
  stack: [],
  kind: "web",
  summary: "",
  setup: [],
  start: "npm run dev",
  port: 3000,
  env: {},
  cwd: "/workspace",
  previewPath: null,
  confidence: "high",
  strategy,
  prior,
  signature,
});

describe("trusting the detector for a stack", () => {
  it("isn't moved by another stack's failure in the same language", () => {
    const { learning } = memoryLearning();
    recordPlan(learning, plan("node:vite:npm"), false);
    expect(detectorTrust(plan("node:next:npm"), learning)).toBeCloseTo(0.8);
  });

  it("counts a stack's own outcome once", () => {
    const { learning } = memoryLearning();
    recordPlan(learning, plan("node:vite:npm"), false);
    expect(detectorTrust(plan("node:vite:npm"), learning)).toBeCloseTo((0.8 * 4) / (4 + 1));
  });

  it("still orders a stack's alternatives with the language's outcomes", () => {
    const { learning } = memoryLearning();
    for (let i = 0; i < 6; i++) recordPlan(learning, plan("node:vite:npm", "framework"), false);
    const ranked = rankPlans([plan("node:next:npm", "framework"), plan("node:next:npm", "readme", 0.65)], learning);
    expect(ranked.map((p) => p.strategy)).toEqual(["readme", "framework"]);
  });

  it("passes on what was set up, so one repo's commit is counted once", () => {
    const { learning, subjects } = memoryLearning();
    recordPlan(learning, plan("node:vite:npm"), false, "o/n@abc");
    expect(subjects).toEqual(["o/n@abc", "o/n@abc"]);
  });
});

describe("keeping installs apart from starts", () => {
  const install = (signature: string, strategy = "framework", prior = 0.3): Plan => ({ ...plan(signature, strategy, prior), kind: "cli", start: null, port: null, confidence: "low" });

  it("doesn't let installs that start nothing raise the trust of a plan that starts something", () => {
    // A library and a frameworkless app share "node:none:npm" and the framework strategy.
    const { learning } = memoryLearning();
    for (let i = 0; i < 10; i++) recordPlan(learning, install("node:none:npm"), true);
    expect(detectorTrust(plan("node:none:npm", "framework", 0.6), learning)).toBeCloseTo(0.6);
    // The installs' record is their own.
    expect(detectorTrust(install("node:none:npm"), learning)).toBeCloseTo((0.3 * 4 + 10) / 14);
  });

  it("doesn't let a server that fails to start count against installing the same stack", () => {
    const { learning } = memoryLearning();
    for (let i = 0; i < 6; i++) recordPlan(learning, plan("php:library:composer", "devcontainer", 0.62), false);
    expect(detectorTrust(install("php:library:composer", "devcontainer", 0.62), learning)).toBeCloseTo(0.62);
  });

  it("orders alternatives by their own kind of outcome", () => {
    const { learning } = memoryLearning();
    for (let i = 0; i < 8; i++) recordPlan(learning, install("go:none:gomod", "readme", 0.5), true);
    // The README's install steps working says nothing for the README's start command.
    const ranked = rankPlans([plan("go:none:gomod", "framework", 0.6), plan("go:none:gomod", "readme", 0.55)], learning);
    expect(ranked.map((p) => p.strategy)).toEqual(["framework", "readme"]);
  });
});
