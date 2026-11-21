import { isPlaceholder, looksSecret, redact, resolveCd, SECRET_NAME, sanitizeCommand, shq, splitChain, type Tool } from "./shell";

/**
 * Reading a Dockerfile as instructions for running the repo without Docker: the RUN steps the final stage depends
 * on, its CMD, ENV and EXPOSE, with image paths such as /app translated to where the repo lives in the box.
 */

export interface DockerStage {
  name: string | null;
  base: string;
  workdir: string | null;
  env: Record<string, string>;
  expose: number[];
  run: string[];
  /** The WORKDIR each RUN ran in (parallel to `run`). */
  runDirs: (string | null)[];
  cmd: string | null;
  entrypoint: string | null;
  /** Stages this one copies build output from (`COPY --from=builder`). */
  copiesFrom: string[];
  /** Those copies themselves, image paths and all, to replay in the box (`COPY --from=build /app/target/*.jar app.jar`). */
  copies: { from: string; src: string[]; dest: string }[];
  /** Where `COPY . <dest>` put the repository inside the image. */
  appRoot: string | null;
}

export interface DockerfileInfo {
  stages: DockerStage[];
  final: DockerStage;
}

export interface DockerEvidence {
  /** Sanitised RUN commands, from the stages the final stage builds on, then the final stage. */
  setup: string[];
  start: string | null;
  env: Record<string, string>;
  ports: number[];
  runtime: { tool: Tool; version: string } | null;
  skipped: { command: string; reason: string }[];
  /** A development flavour (Dockerfile.dev, a "dev" target), more likely to match how a person runs it. */
  dev: boolean;
  /** Where the final stage runs its command, relative to the repo root. */
  cwd: string;
}

interface Logical {
  op: string;
  args: string;
}

/** Joins continuation lines and heredocs into one instruction per entry. */
function logicalLines(text: string): Logical[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const out: Logical[] = [];
  let cur = "";
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const trimmed = raw.trim();
    if (!cur && (trimmed === "" || trimmed.startsWith("#"))) continue;
    if (cur && trimmed.startsWith("#")) continue;
    const doc = /<<-?\s*["']?(\w+)["']?\s*$/.exec(trimmed);
    if (doc && /^\s*RUN\b/i.test(cur || trimmed)) {
      // RUN <<EOF … EOF: the body is a script, one command per line.
      const body: string[] = [];
      for (i++; i < lines.length && lines[i]!.trim() !== doc[1]; i++) if (lines[i]!.trim() && !lines[i]!.trim().startsWith("#")) body.push(lines[i]!.trim());
      const head = (cur + trimmed.replace(/<<-?\s*["']?\w+["']?\s*$/, "")).trim();
      push(out, `${head} ${body.join(" && ")}`);
      cur = "";
      continue;
    }
    if (trimmed.endsWith("\\")) {
      cur += `${trimmed.slice(0, -1).trim()} `;
      continue;
    }
    push(out, cur + trimmed);
    cur = "";
  }
  if (cur.trim()) push(out, cur);
  return out;
}

function push(out: Logical[], line: string) {
  const m = /^(\w+)\s*(.*)$/s.exec(line.trim());
  if (m) out.push({ op: m[1]!.toUpperCase(), args: m[2]!.trim() });
}

/** `$VAR`, `${VAR}` and `${VAR:-default}` from ARG/ENV; unknown variables stay as they are. */
function expand(s: string, vars: Record<string, string>): string {
  return s
    .replace(/\$\{(\w+)(?::?[-+]([^}]*))?\}/g, (whole, name: string, def: string | undefined) => vars[name] ?? def ?? whole)
    .replace(/\$(\w+)/g, (whole, name: string) => vars[name] ?? whole);
}

/** The strings of a parsed JSON value, or none when it is not an array. */
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

/** Exec form (`["npm", "start"]`) or shell form, as one shell command. */
function commandOf(args: string): string | null {
  const a = args.trim();
  if (a.startsWith("[")) {
    try {
      const parts = JSON.parse(a) as unknown;
      if (!Array.isArray(parts) || !parts.every((p) => typeof p === "string")) return null;
      const list = parts as string[];
      // ["sh", "-c", "…"] is a shell command already.
      if (list.length === 3 && /^(\/bin\/)?(ba)?sh$/.test(list[0]!) && list[1] === "-c") return list[2]!;
      return list.map(shq).join(" ");
    } catch {
      return null;
    }
  }
  const sh = /^(?:\/bin\/)?(?:ba)?sh\s+-c\s+(["'])(.*)\1$/s.exec(a);
  return sh ? sh[2]! : a || null;
}

function parseEnv(args: string, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (/^\w+\s*=/.test(args)) {
    for (const m of args.matchAll(/(\w+)=("(?:[^"\\]|\\.)*"|'[^']*'|\S*)/g)) out[m[1]!] = expand(m[2]!.replace(/^["']|["']$/g, ""), vars);
  } else {
    const m = /^(\w+)\s+(.*)$/.exec(args);
    if (m) out[m[1]!] = expand(m[2]!.replace(/^["']|["']$/g, ""), vars);
  }
  return out;
}

export function parseDockerfile(text: string): DockerfileInfo | null {
  const stages: DockerStage[] = [];
  const globalArgs: Record<string, string> = {};
  let stage: DockerStage | null = null;
  let vars: Record<string, string> = {};

  for (const { op, args } of logicalLines(text)) {
    if (op === "FROM") {
      const m = /^(?:--platform=\S+\s+)?(\S+)(?:\s+AS\s+(\S+))?/i.exec(args);
      if (!m) continue;
      stage = { name: m[2] ?? null, base: expand(m[1]!, globalArgs), workdir: null, env: {}, expose: [], run: [], runDirs: [], cmd: null, entrypoint: null, copiesFrom: [], copies: [], appRoot: null };
      // A stage built FROM an earlier stage inherits its settings.
      const parent = stages.find((s) => s.name && s.name === stage!.base);
      if (parent) Object.assign(stage, { workdir: parent.workdir, env: { ...parent.env }, expose: [...parent.expose], cmd: parent.cmd, entrypoint: parent.entrypoint, appRoot: parent.appRoot });
      if (parent) stage.copiesFrom.push(parent.name!);
      stages.push(stage);
      vars = { ...globalArgs, ...stage.env };
      continue;
    }
    if (op === "ARG") {
      const m = /^(\w+)(?:=(.*))?$/.exec(args);
      if (m && m[2] !== undefined) (stage ? vars : globalArgs)[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      continue;
    }
    if (!stage) continue;
    switch (op) {
      case "WORKDIR": {
        const dir = expand(args.replace(/^["']|["']$/g, ""), vars);
        stage.workdir = dir.startsWith("/") ? dir : `${stage.workdir ?? ""}/${dir}`.replace(/\/+/g, "/");
        break;
      }
      case "ENV":
        Object.assign(stage.env, parseEnv(args, vars));
        Object.assign(vars, stage.env);
        break;
      case "EXPOSE":
        for (const p of expand(args, vars).split(/\s+/)) {
          const n = Number(p.split("/")[0]);
          if (Number.isInteger(n) && n > 0 && n < 65536 && !stage.expose.includes(n)) stage.expose.push(n);
        }
        break;
      case "RUN": {
        const cmd = commandOf(args.replace(/^(--(mount|network|security)=\S+\s+)+/, ""));
        if (cmd) {
          stage.run.push(expand(cmd, vars));
          stage.runDirs.push(stage.workdir);
        }
        break;
      }
      case "CMD":
        stage.cmd = commandOf(args);
        break;
      case "ENTRYPOINT":
        stage.entrypoint = commandOf(args);
        break;
      case "COPY":
      case "ADD": {
        const from = /--from=(\S+)/.exec(args)?.[1];
        if (from) {
          stage.copiesFrom.push(from);
          const rest = args.replace(/--\w+(=\S+)?\s+/g, "").trim();
          let paths: string[];
          try {
            paths = rest.startsWith("[") ? strings(JSON.parse(rest)) : rest.split(/\s+/);
          } catch {
            paths = rest.split(/\s+/);
          }
          paths = paths.map((p) => expand(p, vars)).filter(Boolean);
          if (paths.length >= 2) {
            // Relative paths are from each stage's WORKDIR at this point in the file.
            const base = stage.workdir ?? "/";
            stage.copies.push({ from, src: paths.slice(0, -1), dest: paths.at(-1)!.startsWith("/") ? paths.at(-1)! : `${base}/${paths.at(-1)}`.replace(/\/+/g, "/") });
          }
          break;
        }
        const parts = args.replace(/--\w+(=\S+)?\s+/g, "").trim();
        let list: string[];
        try {
          list = parts.startsWith("[") ? strings(JSON.parse(parts)) : parts.split(/\s+/);
        } catch {
          list = parts.split(/\s+/);
        }
        if (list.length >= 2 && list.slice(0, -1).some((s) => s === "." || s === "./")) {
          const dest = expand(list.at(-1)!, vars);
          stage.appRoot = dest === "." || dest === "./" ? (stage.workdir ?? "/") : dest.startsWith("/") ? dest.replace(/\/$/, "") : `${stage.workdir ?? ""}/${dest}`.replace(/\/+$/, "");
        }
        break;
      }
      default:
        break;
    }
  }
  if (!stages.length) return null;
  for (const s of stages) s.appRoot ??= s.workdir;
  return { stages, final: stages.at(-1)! };
}

/** Image paths under the app root become paths in the box's checkout. */
export function translatePaths(cmd: string, appRoot: string | null, target: string): string {
  if (!appRoot || appRoot === "/" || appRoot === "/workspace") return cmd;
  const esc = appRoot.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return cmd.replace(new RegExp(`(^|[\\s='"(:,])${esc}(?=[/\\s'":),]|$)`, "g"), `$1${target}`);
}

const RUNTIME_IMAGES: [RegExp, Tool][] = [
  [/^(?:docker\.io\/)?(?:library\/)?node:v?(\d+(?:\.\d+)*)/, "node"],
  [/^(?:docker\.io\/)?(?:library\/)?python:(\d+\.\d+(?:\.\d+)?)/, "python"],
  [/^(?:docker\.io\/)?(?:library\/)?ruby:(\d+\.\d+(?:\.\d+)?)/, "ruby"],
  [/^(?:docker\.io\/)?(?:library\/)?golang:(\d+\.\d+(?:\.\d+)?)/, "go"],
  [/(?:typescript-node|javascript-node):(?:\d+-)?(\d+)/, "node"],
  [/devcontainers\/python:(?:\d+-)?(\d+\.\d+)/, "python"],
];

export function runtimeOfImage(image: string): { tool: Tool; version: string } | null {
  for (const [re, tool] of RUNTIME_IMAGES) {
    const m = re.exec(image);
    if (m) return { tool, version: m[1]! };
  }
  return null;
}

const DROP_ENV = /^(PATH|HOME|USER|DEBIAN_FRONTEND|NODE_ENV|RAILS_ENV|RACK_ENV|APP_ENV|FLASK_ENV|ENVIRONMENT|VIRTUAL_ENV|PYTHONPATH|PIP_\w+|UV_\w+|NPM_CONFIG_\w+|YARN_\w+|PNPM_HOME|BUNDLE_(PATH|WITHOUT|DEPLOYMENT|FROZEN|APP_CONFIG)|GEM_HOME|LANG|LC_ALL|TZ|NEXT_TELEMETRY_DISABLED)$/;
const WRAPPERS = /^(?:\/(?:usr\/)?(?:local\/)?(?:s?bin)\/)?(tini|dumb-init|su-exec|gosu|catatonit)(\s+--)?(\s+|$)/;

/** Turns a parsed Dockerfile into setup steps and a start command for the box. */
export function dockerEvidence(text: string, opts: { files: Set<string>; dir: string; name: string }): DockerEvidence | null {
  const info = parseDockerfile(text);
  if (!info) return null;
  const { stages, final } = info;
  const target = opts.dir === "." ? "/workspace" : `/workspace/${opts.dir}`;

  // The final stage plus every stage it builds on, in file order.
  const needed = new Set<DockerStage>([final]);
  const queue = [final];
  while (queue.length) {
    const s = queue.pop()!;
    for (const ref of s.copiesFrom) {
      const dep = /^\d+$/.test(ref) ? stages[Number(ref)] : stages.find((x) => x.name === ref);
      if (dep && !needed.has(dep)) {
        needed.add(dep);
        queue.push(dep);
      }
    }
  }

  const evidence: DockerEvidence = {
    setup: [],
    start: null,
    env: {},
    ports: [...final.expose],
    runtime: null,
    skipped: [],
    dev: /dev/i.test(opts.name) || /dev/i.test(final.name ?? ""),
    cwd: opts.dir,
  };
  // A WORKDIR below the copied repo (WORKDIR /app/frontend) is a directory in the checkout.
  const relOf = (workdir: string | null, appRoot: string | null): string => {
    if (!workdir || !appRoot || workdir === appRoot || !workdir.startsWith(`${appRoot}/`)) return opts.dir;
    const sub = workdir.slice(appRoot.length + 1);
    return resolveCd(opts.files, opts.dir, sub) ?? opts.dir;
  };
  evidence.cwd = relOf(final.workdir, final.appRoot);
  const at = (dir: string, cmd: string) => (dir === evidence.cwd ? cmd : `cd ${dir === "." ? "/workspace" : `/workspace/${dir}`} && ${cmd}`);

  /**
   * A build stage's output copied into a later stage, replayed as a copy in the checkout. Only a copy to a named
   * target (app.jar, ./bin/server): one into a directory (./, /app/) would spread build output over the repo, and
   * the strategies for those stacks start the app from where it was built anyway. Copies from outside images and
   * ones that land where they already are in the box are skipped.
   */
  const copyCommands = (s: DockerStage): string[] => {
    const out: string[] = [];
    const destRoot = s.appRoot ?? final.appRoot;
    for (const c of s.copies) {
      const source = /^\d+$/.test(c.from) ? stages[Number(c.from)] : stages.find((x) => x.name === c.from);
      if (!source || c.src.length !== 1 || /\/$|\/\.$|^\.$/.test(c.dest)) continue;
      const srcAbs = c.src[0]!.startsWith("/") ? c.src[0]! : `${source.workdir ?? "/"}/${c.src[0]}`.replace(/\/+/g, "/");
      const src = translatePaths(srcAbs, source.appRoot, target);
      const dest = translatePaths(c.dest.replace(/\/\.\//g, "/"), destRoot, target);
      const inBox = (p: string) => p === target || p.startsWith(`${target}/`);
      if (!inBox(src) || !inBox(dest) || src === dest || ![src, dest].every((p) => /^[\w./*@+-]+$/.test(p))) continue;
      const parent = dest.slice(0, dest.lastIndexOf("/")) || "/";
      out.push(`mkdir -p ${parent} && cp -r ${src} ${dest}`);
    }
    return out;
  };

  for (const s of stages) {
    if (!needed.has(s)) continue;
    evidence.runtime ??= runtimeOfImage(s.base);
    for (const cmd of copyCommands(s)) if (!evidence.setup.includes(cmd)) evidence.setup.push(cmd);
    const appRoot = s.appRoot ?? final.appRoot;
    s.run.forEach((run, i) => {
      let dir = relOf(s.runDirs[i] ?? null, appRoot);
      for (const segment of splitChain(translatePaths(run, appRoot, target))) {
        const clean = sanitizeCommand(segment, { files: opts.files, dir, stripProductionFlags: true });
        if (clean.skip) evidence.skipped.push({ command: redact(segment), reason: clean.skip });
        if (clean.cd !== undefined) dir = clean.cd;
        const cmd = clean.command ? at(dir, clean.command) : null;
        if (cmd && !evidence.setup.includes(cmd)) evidence.setup.push(cmd);
      }
    });
  }
  if (final.base && !evidence.runtime) evidence.runtime = runtimeOfImage(final.base);

  for (const [k, v] of Object.entries(final.env)) {
    if (DROP_ENV.test(k) || (SECRET_NAME.test(k) && !isPlaceholder(v)) || looksSecret(`${k}=${v}`)) continue;
    evidence.env[k] = translatePaths(v, final.appRoot, target);
  }

  let entry = final.entrypoint ? final.entrypoint.replace(WRAPPERS, "").trim() : "";
  // An entrypoint script that only sets up the container (waits for the database, then `exec "$@"`) is skipped;
  // the command it wraps is what runs the app.
  if (entry && /(^|\/)[\w.-]*entrypoint[\w.-]*(\.sh)?$|\.sh$/.test(entry.split(/\s+/)[0]!)) entry = "";
  const raw = [entry, final.cmd ?? ""].filter(Boolean).join(" ").trim();
  if (raw) {
    const kept: string[] = [];
    let dropped = false;
    for (const segment of splitChain(translatePaths(raw, final.appRoot, target))) {
      const clean = sanitizeCommand(segment, { files: opts.files, dir: evidence.cwd });
      if (clean.skip) {
        dropped = true;
        evidence.skipped.push({ command: redact(segment), reason: clean.skip });
      }
      if (clean.command) kept.push(clean.command);
    }
    if (kept.length && !dropped) evidence.start = kept.join(" && ");
  }
  return evidence;
}
