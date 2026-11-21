import type Docker from "dockerode";
import { type BoxOptions, type StartedBox, startBox } from "./docker";
import type { LearningRepo } from "./learning";
import { type PipelineContext, runLogged, type SetupOutcome } from "./pipeline/context";
import { detect, type Plan } from "./pipeline/detect";
import { nothingToRun } from "./pipeline/empty";
import { runPlan } from "./pipeline/heuristic";
import { collectSnapshot } from "./pipeline/snapshot";
import type { RepoTarget } from "./repo";
import { shellQuote, WORKSPACE } from "./sandbox/box";
import type { StepId, StepState } from "./types";

/** Where a run reports its progress: the CLI prints it, tests collect it. */
export interface Reporter {
  step(step: StepId, state: StepState, detail?: string): void;
  log(source: "setup" | "app" | "system", text: string): void;
  thought(text: string): void;
}

export interface RunRepoOptions {
  box: BoxOptions;
  reporter: Reporter;
  signal: AbortSignal;
  /** How long installing and starting may take, all tries and repairs included. */
  timeoutMs: number;
  learning?: LearningRepo;
  /** Stop after the analysis: report the plan, install nothing. */
  planOnly?: boolean;
  /** Called as soon as the box exists, so the caller can clean it up whatever happens next. */
  onBox?: (started: StartedBox) => void;
}

export interface RunRepoResult {
  started: StartedBox;
  /** The commit that was checked out. */
  sha: string | null;
  plan: Plan | null;
  /** Set when the repository has nothing to run yet (no files, or only docs). */
  empty: string | null;
  outcome: SetupOutcome | null;
}

/** The command that puts the repository in /workspace: a shallow clone with its submodules, over https. */
export function cloneScript(target: RepoTarget): string {
  const branch = target.branch ? `--branch ${shellQuote(target.branch)} ` : "";
  return `git clone --depth 1 ${branch}--recurse-submodules --shallow-submodules ${shellQuote(target.url)} ${WORKSPACE}`;
}

/** What to say when the clone failed, from git's output. */
export function cloneFailure(target: RepoTarget, output: string): string {
  if (/repository .*not found|could not be found or you don't have permission|could not read Username|Authentication failed/i.test(output)) {
    return `Couldn't clone ${target.label}. Its host says it doesn't exist or isn't public.`;
  }
  if (target.branch && /Remote branch .* not found/i.test(output)) return `There's no branch or tag called ${target.branch} in ${target.label}.`;
  return `Couldn't clone ${target.label}.\n\n${output.slice(-800)}`;
}

/**
 * Runs a repository end to end: a fresh box, a shallow clone, a look at the repo's own files, then install and start
 * by the most likely plan, with repairs and other plans when that fails. The box is left running for the caller.
 */
export async function runRepo(docker: Docker, target: RepoTarget, opts: RunRepoOptions): Promise<RunRepoResult> {
  const { reporter, signal } = opts;
  const deadline = Date.now() + opts.timeoutMs;

  reporter.step("provision", "active");
  const started = await startBox(docker, opts.box);
  opts.onBox?.(started);
  reporter.step("provision", "done", started.name);
  signal.throwIfAborted();

  const ctx: PipelineContext = {
    envId: started.name,
    box: started.box,
    signal,
    deadline,
    log: (source, text) => reporter.log(source, text),
    agent: (kind, text) => {
      if (kind === "thought") reporter.thought(text);
    },
    step: (step, state, detail) => reporter.step(step, state, detail),
    ...(opts.learning ? { learning: opts.learning } : {}),
  };

  reporter.step("clone", "active", target.branch ? `${target.label}#${target.branch}` : target.label);
  const clone = await runLogged(ctx, cloneScript(target), { cwd: "/", timeoutSec: 600 });
  if (clone.exitCode !== 0) {
    reporter.step("clone", "failed");
    throw new Error(cloneFailure(target, clone.output));
  }
  const head = await started.box.sh(`git -C ${WORKSPACE} rev-parse HEAD`);
  const sha = head.exitCode === 0 ? head.stdout.toString("utf8").trim() : null;
  reporter.step("clone", "done", sha ? sha.slice(0, 7) : undefined);
  if (sha) ctx.learningSubject = `${target.url}@${sha}`;

  reporter.step("analyze", "active");
  const snapshot = await collectSnapshot(started.box);
  signal.throwIfAborted();
  const empty = nothingToRun(snapshot.files);
  if (empty) {
    reporter.step("analyze", "done", empty.found);
    return { started, sha, plan: null, empty: empty.found, outcome: null };
  }
  const plan = detect(snapshot);
  reporter.step("analyze", "done", `${snapshot.files.length.toLocaleString("en-US")} files · ${plan.summary}`);
  if (opts.planOnly) return { started, sha, plan, empty: null, outcome: null };

  const outcome = await runPlan(ctx, plan, "detected plan", { budgetMs: Math.max(60_000, deadline - Date.now()) });
  if (outcome.status === "running" && outcome.port !== null) {
    const relayed = await started.box.relayTo(outcome.port);
    if (!relayed) return { started, sha, plan, empty: null, outcome: { ...outcome, status: "failed", error: `The app is listening on port ${outcome.port}, but the preview couldn't reach it.` } };
  }
  return { started, sha, plan, empty: null, outcome };
}
