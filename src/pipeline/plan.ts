import type { AppKind, EnvNeed } from "../types";
import { shq } from "./evidence/shell";

export const WORKSPACE = "/workspace";

/** A best guess at how to run a repo, produced without any model calls. */
export interface Plan {
  stack: string[];
  kind: AppKind;
  summary: string;
  /** Run in order inside the box (bash), from cwd. */
  setup: string[];
  start: string | null;
  port: number | null;
  env: Record<string, string>;
  cwd: string;
  previewPath: string | null;
  confidence: "high" | "medium" | "low";
  /** Which evidence produced this plan: "framework", "readme", "dockerfile", "procfile", … */
  strategy?: string;
  /** A stack fingerprint such as "node:vite:pnpm", used to learn which strategies work for which projects. */
  signature?: string;
  /** Prior probability (0-1) that this plan works, from the quality of its evidence. */
  prior?: number;
  /** Other complete plans to try, best first, if this one fails. */
  alternatives?: Plan[];
  /** One line per piece of evidence the detector read, for the agent and the logs. */
  evidence?: string[];
  /** What to say when trying this plan, e.g. "The README says `make dev`. Trying that." */
  rationale?: string;
  /** Caveats for the user, e.g. which API keys to provide. */
  notes?: string[];
  /** Third-party keys the user must supply and the env file they belong in, e.g. [{ file: ".env", keys: ["OPENAI_API_KEY"] }]. */
  needs?: EnvNeed[];
  /**
   * The repo's own background programs, started before `start` and left running behind it: a backend for a
   * frontend, a worker, a watcher. Unrelated to pipeline/services.ts, whose shims (ServiceShim, combineShims) stand
   * in for the databases and caches a repo expects to find; never import one for the other.
   */
  services?: PlanService[];
  /** What the detector learned about the project that repair rules need. */
  facts?: PlanFacts;
  /**
   * Set only when the detector has positive evidence that the repository is a library or a command-line tool, so
   * there is nothing to serve: the evidence, as a phrase ("composer.json with no index.php to serve"). Absent when
   * the detector merely found no way to start the project, and absent when anything else in the repository (README,
   * Dockerfile, Procfile, Makefile) gives a start command. Routing reads it; `confidence` and `prior` don't change.
   */
  nothingToServe?: string;
}

/**
 * One of a repo's own background programs (see Plan.services). `command` runs from `cwd` inside the box, in the
 * background, before the plan's foreground `start`. `port` is the port it listens on, or null for a program with no
 * port, such as a worker.
 */
export interface PlanService {
  name: string;
  cwd: string;
  command: string;
  port: number | null;
  /**
   * True when `port` is only the PORT Pyrovue hands a server whose command names none (Go's `go run .`): it may listen
   * elsewhere, and the frontend may be the one on that port, so the launch doesn't skip it.
   */
  portGuessed?: boolean;
}

export interface PlanFacts {
  /** The JavaScript package manager the project uses. */
  pm?: "npm" | "pnpm" | "yarn" | "bun";
  /** Script names in the package.json at the plan's cwd. */
  scripts?: string[];
  /** Top-level Python modules and packages that belong to the repo (never installed from PyPI). */
  localModules?: string[];
  /** The project's own migration command, when the detector knows it. */
  migrate?: string;
  /** A Tauri project's web frontend: what runs in place of `tauri dev`, and its port, when the config gives one. */
  tauri?: { start: string | null; port: number | null };
  /** Commands a repair pass has already seen fail in this run, so a rule does not send the run back to one. */
  tried?: string[];
}

export type PM = "npm" | "pnpm" | "yarn" | "bun";

export function installCommand(pm: PM): string {
  switch (pm) {
    case "pnpm":
      return "pnpm install --no-frozen-lockfile";
    case "yarn":
      return "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install";
    case "bun":
      return "bun install";
    default:
      return "npm install --no-audit --no-fund";
  }
}

export function runScript(pm: PM, script: string): string {
  return `${pm} run ${script}`;
}

/** Each `flask … run` in a command line, up to the next `;`, `&`, `|` or parenthesis outside single quotes. */
const FLASK_RUN = /\bflask\s+(?:(?:'[^']*'|[^;&|()'])*?\s)?run\b(?:'[^']*'|[^;&|()'])*/g;

/**
 * Each `flask run` in a command with Werkzeug's interactive debugger off. Previews are shared links, and the debugger
 * shows the source of a crashing page with a console that runs Python in the box. `--debug` becomes `--reload`, so
 * edits still restart the server, and `--no-debugger` keeps a FLASK_DEBUG=1 in the repo's .flaskenv or .env (which
 * `flask` loads itself) from turning it back on. An app's own `app.run(debug=True)` is not something a command can
 * change. Any other command comes back as it was.
 */
export function withoutFlaskDebugger(command: string): string {
  return command.replace(FLASK_RUN, (match) => {
    const trail = match.slice(match.trimEnd().length);
    let run = match.slice(0, match.length - trail.length);
    const debug = /\s--debug(?=\s|$)/.test(run);
    run = run.replace(/\s--debug(?:ger)?(?=\s|$)/g, "");
    if (debug && !/\s--(no-)?reload(?=\s|$)/.test(run)) run += " --reload";
    if (!/\s--no-debugger(?=\s|$)/.test(run)) run += " --no-debugger";
    return `${run}${trail}`;
  });
}

export function confidenceFor(prior: number): Plan["confidence"] {
  return prior >= 0.75 ? "high" : prior >= 0.45 ? "medium" : "low";
}

export function priorFor(confidence: Plan["confidence"]): number {
  return confidence === "high" ? 0.8 : confidence === "medium" ? 0.6 : 0.3;
}

/** Two or more names as a sentence lists them: "a and b", "a, b and c", or the first three "and more". */
export function listNames(names: string[]): string {
  return names.length > 3 ? `${names.slice(0, 3).join(", ")} and more` : `${names.slice(0, -1).join(", ")} and ${names.at(-1)}`;
}

export function dedupe<T>(list: T[]): T[] {
  return [...new Set(list)];
}

export function cwdFor(dir: string): string {
  return dir === "." || dir === "" ? WORKSPACE : `${WORKSPACE}/${dir.replace(/^\.?\/+/, "").replace(/\/+$/, "")}`;
}

/** The directory of a cwd relative to the workspace ("." for the root). */
export function relDir(cwd: string): string {
  if (cwd === WORKSPACE) return ".";
  return cwd.startsWith(`${WORKSPACE}/`) ? cwd.slice(WORKSPACE.length + 1) : cwd;
}

/** A cwd as the user reads it in a sentence: "backend/", or "the repo root". */
export function folderLabel(cwd: string): string {
  const dir = relDir(cwd);
  return dir === "." ? "the repo root" : `${dir}/`;
}

/**
 * A start command with the plan's background services in front of it, the way start.sh runs them:
 * `(cd <cwd> && PORT=<port> <command>) & <start>`. PORT is the service's own (when it has a port and its command
 * doesn't set one), so a backend that reads PORT never takes the foreground's. `bare` leaves out the `cd`, for
 * Procfile.dev watchers, which run from the root the way foreman runs them.
 */
export function withServices(start: string, services: PlanService[] | undefined, opts: { bare?: boolean } = {}): string {
  if (!services?.length) return start;
  const background = services.map((s) => {
    const port = s.port !== null && !/(^|\s)PORT=/.test(s.command) ? `PORT=${s.port} ` : "";
    return `(${opts.bare ? "" : `cd ${shq(s.cwd)} && `}${port}${s.command}) &`;
  });
  return `${background.join(" ")} ${start}`;
}

export function parseJson<T>(text: string | undefined): T | null {
  if (!text) return null;
  try {
    return JSON.parse(text) as T;
  } catch {
    return null;
  }
}

/** JSON with comments and trailing commas (devcontainer.json, tsconfig-style files). */
export function parseJsonc<T>(text: string | undefined): T | null {
  if (!text) return null;
  let out = "";
  let inString = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === "\\") out += text[++i] ?? "";
      else if (c === '"') inString = false;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
    } else if (c === "/" && text[i + 1] === "/") {
      while (i < text.length && text[i] !== "\n") i++;
      out += "\n";
    } else if (c === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i++;
      i++;
    } else {
      out += c;
    }
  }
  return parseJson<T>(out.replace(/,(\s*[}\]])/g, "$1"));
}
