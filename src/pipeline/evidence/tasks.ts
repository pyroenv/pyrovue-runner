import { redact, sanitizeCommand, splitChain } from "./shell";
import { asString, isMap, parseYaml, type YamlValue } from "./yaml";

/**
 * Task runners (Makefile, justfile, Taskfile.yml): a project that ships `make dev` or `just install` is telling
 * us exactly how its authors run it. Pyrovue runs the target itself rather than its recipe (recipes use the
 * runner's variables), after checking the recipe doesn't need Docker, a host package manager or a cloud login.
 */

export type Runner = "make" | "just" | "task";

export interface TaskTarget {
  name: string;
  commands: string[];
  /** Other targets this one runs first. */
  deps: string[];
}

export interface TaskRunnerEvidence {
  runner: Runner;
  file: string;
  /** Directory of the file, relative to the repo root. */
  dir: string;
  targets: string[];
  install: string | null;
  db: string | null;
  start: string | null;
  /** Installs the runner when the box doesn't have it. */
  prefix: string[];
  skipped: { command: string; reason: string }[];
}

export function parseMakefile(text: string): TaskTarget[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const targets: TaskTarget[] = [];
  let current: TaskTarget | null = null;
  for (let i = 0; i < lines.length; i++) {
    let line = lines[i]!;
    while (line.endsWith("\\") && i + 1 < lines.length) line = `${line.slice(0, -1)} ${lines[++i]!.trim()}`;
    if (line.startsWith("\t")) {
      const cmd = line.trim().replace(/^[@+-]+/, "").trim();
      if (current && cmd && !cmd.startsWith("#")) current.commands.push(cmd);
      continue;
    }
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    // `name: deps` but not `VAR := value`, `VAR ?= value` or `target: VAR = value`. Only the names go through a regex:
    // the rest is split with string operations, since a pattern over it backtracks for minutes on a long run of spaces.
    const m = /^([A-Za-z0-9][\w./%-]*(?:\s+[A-Za-z0-9][\w./%-]*)*)\s*::?(?!=)/.exec(line);
    if (m && !/^\s*(export|override|define|include|-include|ifeq|ifneq|ifdef|ifndef|else|endif|endef)\b/.test(line)) {
      const rest = line.slice(m[0].length);
      const hash = rest.indexOf("#");
      const body = hash === -1 ? rest : rest.slice(0, hash);
      const semi = body.indexOf(";");
      const depsPart = semi === -1 ? body : body.slice(0, semi);
      const recipe = semi === -1 ? "" : body.slice(semi + 1).trim();
      if (!depsPart.includes("=")) {
        const deps = depsPart.split(/\s+/).filter((d) => d && !d.includes("$") && !d.startsWith("."));
        for (const name of m[1]!.split(/\s+/)) {
          if (name.includes("%")) continue;
          current = { name, commands: recipe ? [recipe] : [], deps };
          targets.push(current);
        }
        continue;
      }
    }
    current = null;
  }
  return targets;
}

export function parseJustfile(text: string): TaskTarget[] {
  const targets: TaskTarget[] = [];
  let current: TaskTarget | null = null;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s+\S/.test(line)) {
      const cmd = line.trim().replace(/^[@-]+/, "").trim();
      if (current && cmd && !cmd.startsWith("#")) current.commands.push(cmd);
      continue;
    }
    if (!line.trim() || line.startsWith("#") || /^(set|alias|export|import|mod)\s/.test(line) || /^[\w-]+\s*:=/.test(line)) {
      if (line.trim()) current = null;
      continue;
    }
    // `\S` keeps the spaces before the deps out of `.*`, which would retry every split of them on a line separator.
    const m = /^@?([A-Za-z_][\w-]*)(?:\s[^:]*)?:(?!=)\s*(\S.*|)$/.exec(line);
    current = m ? { name: m[1]!, commands: [], deps: m[2]!.split(/\s+/).filter((d) => /^[A-Za-z_][\w-]*$/.test(d)) } : null;
    if (current) targets.push(current);
  }
  return targets;
}

export function parseTaskfile(text: string): TaskTarget[] {
  const doc = parseYaml(text);
  if (!isMap(doc) || !isMap(doc.tasks)) return [];
  const cmdOf = (c: YamlValue): string | null => (isMap(c) ? asString(c.cmd) ?? (asString(c.task) ? `task ${asString(c.task)}` : null) : asString(c));
  return Object.entries(doc.tasks).map(([name, raw]) => {
    if (typeof raw === "string") return { name, commands: [raw], deps: [] };
    if (Array.isArray(raw)) return { name, commands: raw.map(cmdOf).filter((c): c is string => !!c), deps: [] };
    const t = isMap(raw) ? raw : {};
    const cmds = Array.isArray(t.cmds) ? t.cmds.map(cmdOf).filter((c): c is string => !!c) : asString(t.cmd) ? [asString(t.cmd)!] : [];
    const deps = Array.isArray(t.deps) ? t.deps.map((d) => (isMap(d) ? asString(d.task) : asString(d))).filter((d): d is string => !!d) : [];
    return { name, commands: cmds, deps };
  });
}

const INSTALL_TARGETS = ["install", "setup", "deps", "bootstrap", "init", "dependencies", "requirements", "install-deps", "dev-install", "install-dev"];
const DB_TARGETS = ["migrate", "db", "db-setup", "db-migrate", "migrations", "seed"];
const START_TARGETS = ["dev", "run", "start", "serve", "server", "develop", "run-dev", "start-dev", "dev-server", "local", "watch", "web", "up"];

/** Reasons that rule a target out: it can't work in a box, or it reaches outside it. */
const BLOCKING = /Docker|host package manager|pipes a download|another machine|cloud account|another user|credential|database server|system services/;

/** The first problem with a target's recipe (including the targets it depends on), or null when it's fine. */
function problem(targets: TaskTarget[], name: string, files: Set<string>, seen = new Set<string>()): string | null {
  if (seen.has(name)) return null;
  seen.add(name);
  const t = targets.find((x) => x.name === name);
  if (!t) return null;
  for (const cmd of t.commands) {
    for (const segment of splitChain(cmd)) {
      const s = sanitizeCommand(segment, { files });
      if (s.skip && BLOCKING.test(s.skip)) return `\`${redact(segment, 80)}\` ${s.skip}`;
      const sub = /^(?:\$\(MAKE\)|\$\{MAKE\}|make|just|task)\s+([\w.-]+)\s*$/.exec(segment.trim());
      if (sub) {
        const p = problem(targets, sub[1]!, files, seen);
        if (p) return p;
      }
    }
  }
  for (const dep of t.deps) {
    const p = problem(targets, dep, files, seen);
    if (p) return p;
  }
  return null;
}

export function taskRunnerEvidence(text: string, opts: { files: Set<string>; file: string }): TaskRunnerEvidence | null {
  const base = opts.file.split("/").pop()!;
  const runner: Runner = /^(GNU)?[Mm]akefile$/.test(base) ? "make" : /^\.?[Jj]ustfile$/.test(base) ? "just" : "task";
  const targets = runner === "make" ? parseMakefile(text) : runner === "just" ? parseJustfile(text) : parseTaskfile(text);
  if (!targets.length) return null;
  const dir = opts.file.includes("/") ? opts.file.split("/").slice(0, -1).join("/") : ".";
  const skipped: TaskRunnerEvidence["skipped"] = [];
  const names = targets.map((t) => t.name);
  const pick = (wanted: string[]): string | null => {
    for (const name of wanted) {
      const t = targets.find((x) => x.name === name);
      // A target with no recipe and no prerequisites does nothing.
      if (!t || (!t.commands.length && !t.deps.length)) continue;
      const p = problem(targets, name, opts.files);
      if (p) {
        skipped.push({ command: `${runner} ${name}`, reason: p });
        continue;
      }
      return `${runner} ${name}`;
    }
    return null;
  };
  const prefix = runner === "just" ? ["command -v just >/dev/null || mise use -g just@latest"] : runner === "task" ? ["command -v task >/dev/null || mise use -g task@latest"] : [];
  return { runner, file: opts.file, dir, targets: names, install: pick(INSTALL_TARGETS), db: pick(DB_TARGETS), start: pick(START_TARGETS), prefix, skipped };
}
