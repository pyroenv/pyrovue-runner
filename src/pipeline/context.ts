import type { AppKind, EnvNeed, StepId, StepState } from "../types";
import type { LearningRepo } from "../learning";
import type { Box, ExecResult } from "../sandbox/box";
import { WORKSPACE } from "../sandbox/box";
import { TokenBucket } from "../util/rate-limit";
import type { LaunchSpec } from "./launch";

/** What a setup strategy needs from the run: the box, where to log, and how to report progress. */
export interface PipelineContext {
  envId: string;
  box: Box;
  signal: AbortSignal;
  /** When the setup's time limit runs out (epoch ms); no command it runs may outlast it. */
  deadline?: number;
  log(source: "setup" | "app" | "system", text: string): void;
  /** `startedAt` (ISO time) marks an action that runs a while, so a progress display can show how long it has been running. */
  /** `path` (repo-relative) names the one file an action reads or writes, for editors following along. */
  agent(kind: "thought" | "action" | "observation", text: string, extra?: { tool?: string; ok?: boolean; startedAt?: string; path?: string }): void;
  step(step: StepId, state: StepState, detail?: string): void;
  /** Outcomes of earlier runs, for ranking strategies and repairs (absent in unit tests). */
  learning?: LearningRepo;
  /** What is being set up ("owner/name@sha"), so learning counts a repo's commit once however often it runs. */
  learningSubject?: string;
}

export interface SetupOutcome {
  status: "running" | "cli" | "failed";
  kind: AppKind;
  summary: string;
  stack: string[];
  notes: string[];
  /** Third-party keys the person running it has to add, and the env file each belongs in; absent when the strategy reported none. */
  needs?: EnvNeed[];
  setupCommands: string[];
  start: LaunchSpec | null;
  port: number | null;
  error: string | null;
}

/** Env for setup commands: CI mode makes installers non-interactive. */
export const SETUP_ENV: Record<string, string> = {
  CI: "1",
  YARN_ENABLE_IMMUTABLE_INSTALLS: "false",
  YARN_ENABLE_PROGRESS_BARS: "false",
  npm_config_progress: "false",
};

export function resolveCwd(cwd: string | undefined | null): string {
  if (!cwd || cwd === ".") return WORKSPACE;
  if (cwd.startsWith("/")) return cwd;
  return `${WORKSPACE}/${cwd.replace(/^\.\/+/, "")}`;
}

/**
 * Output a setup command may stream to the live log: a burst, then bytes per second. A command that floods its
 * output (a `yes` loop) would otherwise keep the event loop busy forwarding it; its result keeps its own head and
 * tail either way.
 */
export const LIVE_OUTPUT_BURST = 1024 * 1024;
export const LIVE_OUTPUT_PER_SECOND = 256 * 1024;

/**
 * Runs a shell command in the box, echoing it and streaming its output to the setup log as it arrives. `pipefail`
 * makes a pipeline fail when any part of it does.
 */
export async function runLogged(
  ctx: PipelineContext,
  command: string,
  opts: { cwd?: string; timeoutSec?: number; env?: Record<string, string>; pipefail?: boolean } = {},
): Promise<ExecResult & { durationMs: number }> {
  const started = Date.now();
  const where = opts.cwd && opts.cwd !== WORKSPACE ? `${opts.cwd.replace(`${WORKSPACE}/`, "")} ` : "";
  ctx.log("setup", `\n${where}$ ${command}\n`);
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
  // The box's own `timeout` kills the command (and what it started) at the setup's time limit, so a timed-out setup
  // doesn't leave a build running in its box.
  const requested = opts.timeoutSec ?? 900;
  const timeoutSec =
    ctx.deadline === undefined ? requested : Math.min(requested, Math.max(1, Math.ceil((ctx.deadline - Date.now()) / 1000)));
  const live = new TokenBucket(LIVE_OUTPUT_BURST, LIVE_OUTPUT_PER_SECOND);
  // At most one notice every 10 seconds, however the output alternates between shown and skipped.
  let noticeAt = -Infinity;
  const result = await ctx.box.sh(command, {
    cwd: opts.cwd ?? WORKSPACE,
    env: { ...SETUP_ENV, ...opts.env },
    timeoutSec,
    ...(opts.pipefail ? { pipefail: true } : {}),
    onOutput: (text) => {
      if (live.take(text.length)) return ctx.log("setup", text);
      if (Date.now() - noticeAt < 10_000) return;
      noticeAt = Date.now();
      ctx.log("setup", "\n[Output is too fast to show live, so some lines were skipped.]\n");
    },
    maxBuffer: 64 * 1024,
    // A stop, rebuild or the time limit ends the wait right away.
    signal: ctx.signal,
  });
  // A stop or rebuild kills the box under a running command, which then "fails" (exit 137); that's not its result.
  if (ctx.signal.aborted) throw ctx.signal.reason ?? new Error("aborted");
  const durationMs = Date.now() - started;
  if (result.timedOut) ctx.log("setup", `\n[timed out after ${timeoutSec}s]\n`);
  else if (result.exitCode !== 0) ctx.log("setup", `\n[exit ${result.exitCode}]\n`);
  return { ...result, durationMs };
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m ${s % 60}s`;
}
