import type { Box } from "../sandbox/box";
import type { Listener } from "../sandbox/procnet";
import { languageOf } from "./candidates";
import { formatDuration, type PipelineContext, runLogged, type SetupOutcome } from "./context";
import { commandPort } from "./evidence/ports";
import { launchApp, type LaunchOptions, type LaunchResult, type LaunchSpec } from "./launch";
import { type Plan, type PlanService, relDir } from "./plan";
import { rankPlans, rankRepairs, recordPlan, recordRepair } from "./ranking";
import { matchRepairs, type RepairMatch, type RepairPhase } from "./repairs";
import { isSecretName } from "../security/redact";
import { isAppSecret } from "./evidence/envfile";
import { shq } from "./evidence/shell";

export interface RunOptions {
  /** Starts the app and waits for it (tests pass a scripted one). */
  launch?: (box: Box, spec: LaunchSpec, opts: LaunchOptions) => Promise<LaunchResult>;
  /** Plans to attempt, the primary included. */
  maxPlans?: number;
  /** Repairs per plan. */
  maxRepairs?: number;
  /** After this long, no new repair or plan is started. */
  budgetMs?: number;
  launchTimeoutSec?: number;
}

const DEFAULTS = { maxPlans: 3, maxRepairs: 6, budgetMs: 15 * 60 * 1000, launchTimeoutSec: 180 };

/** State shared by the plans of one setup: what already ran in this box, and what failed for good. */
interface Session {
  /** cwd + command → the commands (repairs included) that made it succeed. */
  done: Map<string, string[]>;
  failed: Set<string>;
  deadline: number;
  opts: Required<Omit<RunOptions, "launch">> & Pick<RunOptions, "launch">;
}

type Attempt = SetupOutcome & {
  /** A low-confidence plan installed everything but started no server: probably a library. */
  soft?: boolean;
};

/** Said once when a plan installs everything and starts nothing (a library, a CLI, firmware). */
const NO_SERVER_NOTE = "Pyrovue didn't find a web server in this repo, so there is no preview. Everything is installed: open a shell in the box to use it.";
const NO_SERVER = /\bno web server\b|didn't find a web server/i;

const keyOf = (cwd: string, command: string) => `${cwd}\u0000${command}`;
const fixKey = (m: RepairMatch) => `${m.rule.id}\u0000${JSON.stringify(m.fix)}`;

const STRATEGY_LABEL: Record<string, string> = {
  "pyrovue-json": "pyrovue.json",
  framework: "framework defaults",
  "framework:secondary": "the other folder's framework defaults",
  "framework:both": "both folders' framework defaults",
  devcontainer: "dev container",
  procfile: "Procfile",
  readme: "README",
  makefile: "Makefile",
  compose: "docker-compose",
  dockerfile: "Dockerfile",
  platform: "hosting config",
};

/**
 * Runs a plan without a model: execute setup, start the app, check it answers. Failures are matched against the
 * repair knowledge base and retried; when a plan still fails, the next alternative is tried (at most three plans).
 */
export async function runPlan(ctx: PipelineContext, plan: Plan, label = "detected plan", options: RunOptions = {}): Promise<SetupOutcome> {
  const { alternatives, ...primary } = plan;
  const ranked = alternatives?.length ? rankPlans([primary, ...alternatives], ctx.learning) : [primary];
  const session: Session = {
    done: new Map(),
    failed: new Set(),
    deadline: Date.now() + (options.budgetMs ?? DEFAULTS.budgetMs),
    opts: { ...DEFAULTS, ...options },
  };

  let soft: Attempt | null = null;
  let last: Attempt | null = null;
  /** A plan that was more than a guess tried to start a server and failed: a later "probably a library" doesn't hide it. */
  let serverFailed = false;
  const tried: string[] = [];
  for (const candidate of ranked) {
    if (tried.length >= session.opts.maxPlans || (tried.length > 0 && Date.now() > session.deadline)) break;
    // After a probable library, only evidence-backed servers are worth another install.
    if (soft && (!candidate.start || (candidate.prior ?? 0) < 0.5)) continue;
    const blocked = candidate.setup.find((c) => session.failed.has(keyOf(candidate.cwd, c)));
    if (blocked) continue;

    if (tried.length > 0) {
      ctx.step("install", "pending");
      ctx.step("launch", "pending");
      ctx.agent("thought", candidate.rationale ?? "Trying another way to run it.");
    } else if (candidate.rationale && candidate.strategy && candidate.strategy !== "framework" && candidate.strategy !== "pyrovue-json") {
      ctx.agent("thought", candidate.rationale);
    }
    tried.push(STRATEGY_LABEL[candidate.strategy ?? ""] ?? label);

    const outcome = await attempt(ctx, candidate, label, session);
    // A cancelled setup's last command can still return (a stop kills it with 137); don't learn from it.
    ctx.signal.throwIfAborted();
    recordPlan(ctx.learning, candidate, outcome.status === "running" || (outcome.status === "cli" && !outcome.soft), ctx.learningSubject);
    if (outcome.status === "running" || (outcome.status === "cli" && !outcome.soft)) return strip(outcome);
    if (outcome.soft) soft ??= outcome;
    else {
      last = outcome;
      if (candidate.start && candidate.confidence !== "low") serverFailed = true;
    }
  }

  if (soft && !serverFailed) return strip(soft);
  const failure = last!;
  if (tried.length > 1) {
    const verdict = soft ? "None of them started a server" : "The last one failed";
    return { ...strip(failure), error: `Pyrovue tried ${tried.length} ways to run this (${tried.join(", ")}). ${verdict}.\n\n${failure.error ?? ""}` };
  }
  return strip(failure);
}

/**
 * A recorded setup without a start replays from /workspace with no env, so a CLI outcome's commands carry the
 * plan's directory and env (repairs included) themselves.
 */
function replayable(plan: Plan, env: Record<string, string>, commands: string[]): string[] {
  const dir = relDir(plan.cwd);
  const exports = Object.entries(env).map(([k, v]) => {
    const fresh = freshSecretShell(k, v);
    return fresh ? `export ${k}="${fresh}"` : `export ${k}=${shq(v)}`;
  });
  const prefix = [...(dir !== "." ? [`cd ${shq(dir)}`] : []), ...exports].join(" && ");
  return prefix ? commands.map((c) => `${prefix} && ${c}`) : commands;
}

/**
 * Shell that prints a fresh secret where Pyrovue generated one (secretFor's shapes), or null for any other value.
 * A recorded setup can be replayed elsewhere, so a replay rolls its own instead of reusing the first run's.
 */
function freshSecretShell(name: string, value: string): string | null {
  if (!isAppSecret(name) && !isSecretName(name)) return null;
  const hex = (bytes: number) => `$(od -An -vtx1 -N${bytes} /dev/urandom | tr -d ' \\n')`;
  const base64 = (bytes: number) => `$(head -c ${bytes} /dev/urandom | base64 -w0)`;
  if (name === "APP_KEY") return /^base64:[A-Za-z0-9+/]{43}=$/.test(value) ? `base64:${base64(32)}` : null;
  if (name === "SECRET_KEY_BASE") return /^[0-9a-f]{128}$/.test(value) ? hex(64) : null;
  if (name === "APP_KEYS") return /^([A-Za-z0-9+/]{22}==,){3}[A-Za-z0-9+/]{22}==$/.test(value) ? [1, 2, 3, 4].map(() => base64(16)).join(",") : null;
  return /^[0-9a-f]{64}$/.test(value) ? hex(32) : null;
}

function strip(a: Attempt): SetupOutcome {
  const { soft: _soft, ...outcome } = a;
  return outcome;
}

/**
 * What became of the plan's background services once the app answered. One that didn't open its port is a note with
 * the command to run, never a failed setup: the preview is up.
 */
function serviceNotes(services: PlanService[], listeners: Listener[], start: string, previewPort: number | null): string[] {
  // The server in front is whatever follows the last backgrounded service.
  const cut = start.lastIndexOf(") & ");
  const behindFrontend = languageOf(cut === -1 ? start : start.slice(cut + 4)) === "node";
  return services.map((s) => {
    const backend = behindFrontend && languageOf(s.command) !== "node";
    // The preview's port is the server in front, even when a service was given the same one as a guess.
    if (s.port !== null && (s.port === previewPort || !listeners.some((l) => l.port === s.port))) {
      // A guessed port says little: the program may be running on one it chose itself.
      if (s.portGuessed) return `${s.name} didn't open port ${s.port}, the one Pyrovue gave it: it may use a port of its own, or have stopped. Its output is in the logs.`;
      const dir = relDir(s.cwd);
      const command = dir === "." ? s.command : `cd ${dir} && ${s.command}`;
      return `${backend ? "Only the frontend is running. " : ""}${s.name} didn't open port ${s.port}; its output is in the logs. Start it from the terminal with \`${command}\`.`;
    }
    const proxy = backend ? " The preview shows the frontend. API calls reach it through the frontend's dev server proxy." : "";
    return `Also running: ${s.name}${s.port !== null ? ` on port ${s.port}` : ""}.${proxy}`;
  });
}

/** Runs one plan, repairing what the knowledge base recognises. */
async function attempt(ctx: PipelineContext, plan: Plan, label: string, session: Session): Promise<Attempt> {
  const base = {
    kind: plan.kind,
    summary: plan.summary,
    stack: plan.stack,
    notes: [...(plan.notes ?? [])],
    needs: plan.needs ?? [],
    setupCommands: [] as string[],
  };
  const env: Record<string, string> = { ...plan.env };
  let port = plan.port;
  let repairs = 0;
  const canRepair = () => repairs < session.opts.maxRepairs && Date.now() < session.deadline;
  const failedStarts = new Set<string>();
  const current = (start: string | null): Plan => ({ ...plan, env, port, start, facts: { ...plan.facts, tried: [...failedStarts] } });

  /** Runs a fix's prerequisite commands; false when one of them fails. */
  const runSteps = async (commands: string[]): Promise<boolean> => {
    for (const c of commands) {
      ctx.agent("action", `$ ${c}`, { tool: "run_command" });
      const r = await runLogged(ctx, c, { cwd: plan.cwd, env });
      ctx.agent("observation", `exit ${r.exitCode} · ${formatDuration(r.durationMs)}`, { ok: r.exitCode === 0 });
      if (r.exitCode !== 0) return false;
    }
    return true;
  };

  /** The best untried repair for this failure, or null. */
  const nextRepair = (phase: RepairPhase, command: string, output: string, start: string | null, tried: Set<string>): RepairMatch | null => {
    if (!canRepair()) return null;
    failedStarts.add(command);
    const matches = rankRepairs(matchRepairs(phase, command, output, current(start)), ctx.learning).filter((m) => !tried.has(fixKey(m)));
    const m = matches[0] ?? null;
    if (m) {
      tried.add(fixKey(m));
      repairs++;
    }
    return m;
  };

  const applyEnv = (m: RepairMatch) => {
    if (m.fix.env) {
      Object.assign(env, m.fix.env);
      if (m.rule.id === "missing-env") base.notes.push(m.fix.note);
    }
    if (m.fix.port) port = m.fix.port;
    if (m.fix.planNote && !base.notes.includes(m.fix.planNote)) base.notes.push(m.fix.planNote);
  };

  ctx.step("install", "active", plan.setup.length ? `${plan.setup.length} step${plan.setup.length > 1 ? "s" : ""}` : "nothing to install");
  for (const command of plan.setup) {
    const key = keyOf(plan.cwd, command);
    const earlier = session.done.get(key);
    if (earlier) {
      // An earlier plan already ran this in the box.
      base.setupCommands.push(...earlier);
      continue;
    }
    ctx.agent("action", `$ ${command}`, { tool: "run_command" });
    let ran = command;
    const recorded: string[] = [];
    let result = await runLogged(ctx, ran, { cwd: plan.cwd, env });
    const tried = new Set<string>();
    while (result.exitCode !== 0) {
      const m = nextRepair("install", ran, result.output, plan.start, tried);
      if (!m) break;
      ctx.agent("observation", `exit ${result.exitCode} · ${formatDuration(result.durationMs)}`, { ok: false });
      ctx.agent("thought", m.fix.note);
      if (!(await runSteps(m.fix.run ?? []))) {
        recordRepair(ctx.learning, m.rule.id, false);
        continue;
      }
      recorded.push(...(m.fix.run ?? []));
      applyEnv(m);
      ran = m.fix.retry ?? ran;
      ctx.agent("action", `$ ${ran}`, { tool: "run_command" });
      result = await runLogged(ctx, ran, { cwd: plan.cwd, env });
      recordRepair(ctx.learning, m.rule.id, result.exitCode === 0);
    }
    ctx.agent("observation", `exit ${result.exitCode} · ${formatDuration(result.durationMs)}`, { ok: result.exitCode === 0 });
    if (result.exitCode !== 0) {
      session.failed.add(key);
      ctx.step("install", "failed", `\`${ran}\` failed`);
      return {
        ...base,
        status: "failed",
        start: null,
        port: null,
        error: `Setup command failed (${label}): ${ran}\n\n${result.output.slice(-1500)}`,
      };
    }
    recorded.push(ran);
    session.done.set(key, recorded);
    base.setupCommands.push(...recorded);
  }
  ctx.step("install", "done");

  if (!plan.start) {
    ctx.step("launch", "skipped", "no server to start");
    if (!base.notes.some((n) => NO_SERVER.test(n))) base.notes.push(NO_SERVER_NOTE);
    return { ...base, setupCommands: replayable(plan, env, base.setupCommands), kind: "cli", status: "cli", start: null, port: null, error: null };
  }

  // The services start inside plan.start; the preview must land on the foreground server, not on one of them. A port
  // that is only Pyrovue's guess for a service stays open to the preview: the frontend may be the one listening there.
  const services = plan.services ?? [];
  const ignorePorts = services.flatMap((s) => {
    const own = s.portGuessed ? null : (s.port ?? commandPort(s.command));
    return own !== null && own !== plan.port ? [own] : [];
  });
  const spec: LaunchSpec = { command: plan.start, cwd: plan.cwd, env, port, previewPath: plan.previewPath, ...(services.length ? { ignorePorts } : {}) };
  const launch = session.opts.launch ?? launchApp;
  // `verify`: a "/" that redirects to a page that crashes (a login page with no tables yet) is a failure to repair, not
  // a running app.
  const launchOnce = () => launch(ctx.box, { ...spec, env: { ...env }, port }, { signal: ctx.signal, timeoutSec: session.opts.launchTimeoutSec, verify: true });
  ctx.step("launch", "active", plan.start);
  ctx.agent("action", `Starting \`${spec.command}\``, { tool: "start_app" });
  let result = await launchOnce();
  const tried = new Set<string>();
  while (!result.ok) {
    const m = nextRepair("launch", spec.command, `${result.logTail}\n${result.reason ?? ""}`, spec.command, tried);
    if (!m) break;
    ctx.agent("observation", result.reason ?? "The app didn't come up.", { ok: false });
    ctx.agent("thought", m.fix.note);
    if (!(await runSteps(m.fix.run ?? []))) {
      recordRepair(ctx.learning, m.rule.id, false);
      continue;
    }
    base.setupCommands.push(...(m.fix.run ?? []));
    applyEnv(m);
    if (m.fix.retry) spec.command = m.fix.retry;
    ctx.agent("action", `Starting \`${spec.command}\``, { tool: "start_app" });
    result = await launchOnce();
    recordRepair(ctx.learning, m.rule.id, result.ok);
  }
  spec.env = env;
  spec.port = port;

  if (!result.ok) {
    ctx.agent("observation", result.reason ?? "The app didn't come up.", { ok: false });
    // A low-confidence guess that exits without serving is more likely a library than a broken app:
    // everything is installed, so hand over the terminal rather than calling it a failure.
    if (plan.confidence === "low" && !result.port) {
      ctx.step("launch", "skipped", "no server found");
      return {
        ...base,
        kind: "cli",
        status: "cli",
        start: null,
        port: null,
        error: null,
        setupCommands: replayable(plan, env, base.setupCommands),
        notes: [...base.notes, `Dependencies are installed, but \`${spec.command}\` didn't start a server. Try the project's commands in the terminal.`],
        soft: true,
      };
    }
    ctx.step("launch", "failed", result.reason ?? undefined);
    return {
      ...base,
      status: "failed",
      start: spec,
      port: null,
      error: `${result.reason}\n\n${result.logTail.slice(-2000)}`,
    };
  }
  ctx.agent("observation", `Listening on :${result.port} · HTTP ${result.httpStatus}`, { ok: true });
  ctx.step("launch", "done", `port ${result.port}`);
  const notes = [...base.notes, ...serviceNotes(services, result.listeners, spec.command, result.port)];
  return { ...base, notes, kind: "web", status: "running", start: { ...spec, port: result.port }, port: result.port, error: null };
}
