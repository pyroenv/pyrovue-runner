import path from "node:path/posix";
import type { EnvNeed } from "../types";
import type { RepoEvidence } from "./evidence";
import { localizeEnv } from "./evidence/compose";
import { dockerEvidence, parseDockerfile, translatePaths } from "./evidence/dockerfile";
import { type EnvTemplate, envFileEvidence, secretFor } from "./evidence/envfile";
import { choosePort, commandPort, type PortHint } from "./evidence/ports";
import type { MinedCommand } from "./evidence/readme";
import { classifyCommand, headWord, isDevStart, jsTool, looksSecret, MAX_COMMAND, sanitizeCommand, scriptOf, shq, splitChain, type Tool } from "./evidence/shell";
import { confidenceFor, cwdFor, dedupe, folderLabel, installCommand, parseJson, type Plan, type PlanService, type PM, priorFor, relDir, runScript, WORKSPACE, withoutFlaskDebugger, withServices } from "./plan";
import { pythonVenv, TOOLS } from "./repairs";
import { cannotShim, combineShims, type ServiceKind, type ServiceSettings, type ServiceShim, type ShimSet, settingsFromUrl, shimFor } from "./services";
import type { Snapshot } from "./snapshot";

/**
 * Several complete plans per repo, one per kind of evidence, each with a prior from how trustworthy that evidence
 * is. The runner tries them best first (re-ranked by what earlier setups learned) and falls through on failure.
 */

export type Strategy = "pyrovue-json" | "framework" | "devcontainer" | "procfile" | "readme" | "makefile" | "compose" | "dockerfile" | "platform";

/** Plans with no evidence beyond a weak guess still run; anything this unlikely isn't worth an attempt. */
const MIN_PRIOR = 0.2;
const ALTERNATIVES = 5;

const short = (cmd: string, max = 72) => (cmd.length > max ? `${cmd.slice(0, max - 1)}…` : cmd);

// ---------------------------------------------------------------- shared enrichment

interface Common {
  /** Runtime pins from version files. */
  pins: Partial<Record<Tool, string>>;
  shims: ShimSet;
  /** Env template copies. */
  setup: string[];
  env: Record<string, string>;
  notes: string[];
  /** Third-party keys the user has to add, per env file. */
  needs: EnvNeed[];
  evidence: string[];
}

/** The command that switches the box to a runtime version, or null when the box's default is right. */
export function pinCommand(tool: Tool, version: string): string | null {
  const v = version.trim().replace(/^v/, "");
  if (tool === "node") {
    const major = Number(/^(\d+)(\.(\d+|x))*$/.exec(v)?.[1]);
    return major >= 10 && major !== 22 ? `mise use -g node@${major}` : null;
  }
  if (tool === "python") {
    const minor = Number(/^3\.(\d+)(\.\d+)?$/.exec(v)?.[1]);
    if (!minor || minor === 11 || minor < 8) return null;
    return pythonVenv(`3.${minor}`);
  }
  if (tool === "ruby") return /^\d+\.\d+(\.\d+)?$/.test(v) ? `mise use -g ruby@${v}` : null;
  return /^\d+\.\d+(\.\d+)?$/.test(v) ? `mise use -g go@${v}` : null;
}

const PINNED: Record<Tool, RegExp> = {
  node: /\bmise use -g node@/,
  python: /\buv venv\b/,
  ruby: /\bmise use -g ruby@/,
  go: /\bmise use -g go@/,
};

/** Adds runtime pins for tools the setup doesn't pin already, before everything else. */
function withPins(setup: string[], ...sources: Partial<Record<Tool, string>>[]): string[] {
  const pins: string[] = [];
  for (const tool of ["node", "python", "ruby", "go"] as const) {
    if (setup.some((c) => PINNED[tool].test(c))) continue;
    const version = sources.map((s) => s[tool]).find(Boolean);
    const cmd = version ? pinCommand(tool, version) : null;
    if (cmd) pins.push(cmd);
  }
  return [...pins, ...setup];
}

const ADDONS: [RegExp, ServiceKind][] = [
  [/postgres/i, "postgres"],
  [/redis/i, "redis"],
  [/cleardb|jawsdb|mysql|mariadb/i, "mysql"],
  [/cloudamqp|rabbit/i, "rabbitmq"],
  [/memcach/i, "memcached"],
  [/mongo/i, "mongo"],
  [/elastic|bonsai|searchbox/i, "elasticsearch"],
];

function companionSettings(kind: ServiceKind, env: Record<string, string>): ServiceSettings {
  if (kind === "postgres") return { user: env.POSTGRES_USER, password: env.POSTGRES_PASSWORD, database: env.POSTGRES_DB };
  if (kind === "mysql") {
    const user = env.MYSQL_USER ?? env.MARIADB_USER;
    return {
      user: user ?? "root",
      password: user ? (env.MYSQL_PASSWORD ?? env.MARIADB_PASSWORD) : (env.MYSQL_ROOT_PASSWORD ?? env.MARIADB_ROOT_PASSWORD),
      database: env.MYSQL_DATABASE ?? env.MARIADB_DATABASE,
    };
  }
  return {};
}

interface Services {
  wanted: Map<ServiceKind, ServiceSettings>;
  /** Services that can't run in the box, with why. */
  missing: string[];
  /** A DATABASE_URL the ORM accepts when there's no database server. */
  sqliteUrl: string | null;
  sources: string[];
  /** The app reads DB_HOST/DB_USERNAME/… rather than a URL, for this service. */
  splitSettings?: ServiceKind;
}

function detectServices(snapshot: Snapshot, ev: RepoEvidence): Services {
  const out: Services = { wanted: new Map(), missing: [], sqliteUrl: null, sources: [] };
  const want = (kind: ServiceKind, settings: ServiceSettings, source: string, name: string = kind) => {
    if (!shimFor(kind, settings)) {
      const why = cannotShim(kind, name);
      if (!out.missing.includes(why)) out.missing.push(why);
      return;
    }
    const prev = out.wanted.get(kind);
    if (!prev) {
      out.wanted.set(kind, { ...settings });
      out.sources.push(`${kind} (${source})`);
    } else {
      // Earlier sources describe the app's own connection settings, so they win.
      for (const k of ["user", "password", "database"] as const) prev[k] ??= settings[k];
    }
  };
  const fromUrl = (value: string, source: string) => {
    if (!value.includes("://")) return;
    const parsed = settingsFromUrl(value);
    if (parsed?.kind) want(parsed.kind, parsed.settings, source);
  };

  const compose = ev.compose;
  if (compose) {
    const app = compose.info.app;
    for (const s of app ? [app, ...compose.info.siblings] : []) for (const v of Object.values(s.env)) fromUrl(v, compose.file);
    const deps = new Set(app ? [app, ...compose.info.siblings].flatMap((s) => s.dependsOn) : []);
    for (const comp of compose.info.companions) {
      if (!comp.kind) continue;
      if (deps.size && !deps.has(comp.name)) continue;
      want(comp.kind, companionSettings(comp.kind, comp.env), compose.file, comp.name);
    }
  }
  for (const t of ev.envTemplates) {
    for (const v of Object.values(t.values)) fromUrl(v, t.file);
    // Laravel-style settings: DB_CONNECTION plus separate host, database, user and password.
    const conn = t.values.DB_CONNECTION?.toLowerCase();
    const kind: ServiceKind | null = conn && /^(mysql|mariadb)$/.test(conn) ? "mysql" : conn && /^(pgsql|postgres(ql)?)$/.test(conn) ? "postgres" : null;
    if (kind) {
      want(kind, { user: t.values.DB_USERNAME || undefined, password: t.values.DB_PASSWORD || undefined, database: t.values.DB_DATABASE || undefined }, t.file);
      out.splitSettings = kind;
    }
  }
  for (const addon of ev.appJson?.addons ?? []) {
    const kind = ADDONS.find(([re]) => re.test(addon))?.[1];
    if (kind) want(kind, {}, "app.json");
  }

  const c = snapshot.contents;
  const prisma = Object.entries(c).find(([f]) => /(^|\/)schema\.prisma$/.test(f))?.[1];
  const provider = prisma ? /datasource\s+\w+\s*\{[^}]*?provider\s*=\s*"(\w+)"/.exec(prisma)?.[1] : undefined;
  if (provider && /^(postgres(ql)?|cockroachdb)$/.test(provider)) want("postgres", {}, "schema.prisma");
  else if (provider === "mysql") want("mysql", {}, "schema.prisma");
  else if (provider === "mongodb") want("mongo", {}, "schema.prisma");
  else if (provider === "sqlite") out.sqliteUrl = "file:./dev.db";

  const dbYml = c["config/database.yml"];
  if (dbYml && !/adapter:\s*sqlite/.test(dbYml)) {
    if (/adapter:\s*postg/.test(dbYml)) want("postgres", {}, "config/database.yml");
    else if (/adapter:\s*(mysql2?|trilogy)/.test(dbYml)) want("mysql", {}, "config/database.yml");
  }

  const settings = Object.entries(c).find(([f]) => /settings(\.py|\/(__init__|base|common|dev|development|local)\.py)$/.test(f) && /DATABASES/.test(c[f] ?? ""))?.[1];
  const requirements = Object.entries(c)
    .filter(([f]) => /(^|\/)(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile)$/.test(f))
    .map(([, v]) => v.toLowerCase())
    .join("\n");
  if (settings && !/dj_database_url|env\.db\(|DATABASE_URL/.test(settings)) {
    const literal = (key: string) => new RegExp(`['"]${key}['"]\\s*:\\s*(?:os\\.(?:environ\\.get|getenv)\\(\\s*['"]\\w+['"]\\s*,\\s*)?['"]([\\w.-]+)['"]`).exec(settings)?.[1];
    const s = { user: literal("USER"), password: literal("PASSWORD"), database: literal("NAME") };
    if (/backends\.postgresql/.test(settings)) want("postgres", s, "Django settings");
    else if (/backends\.mysql/.test(settings)) want("mysql", s, "Django settings");
  }
  if (!out.sqliteUrl) {
    if (/dj-database-url|dj_database_url|django-environ/.test(requirements)) out.sqliteUrl = "sqlite:///db.sqlite3";
    else if (/flask-sqlalchemy|sqlalchemy|sqlmodel|peewee/.test(requirements)) out.sqliteUrl = "sqlite:///app.db";
  }
  return out;
}

/**
 * Writes the values Pyrovue chose into the copied env file, so the app and commands typed in the terminal see the
 * same settings. Values come from the command's environment, never its text, so no secret reaches the setup log;
 * a line is only rewritten while it still holds the template's value.
 */
export function envFillCommand(template: EnvTemplate, keys: string[]): string {
  const safe = keys.filter((k) => /^[A-Za-z_][A-Za-z0-9_.]*$/.test(k));
  const script = [
    'const fs=require("fs");const[src,dst,...keys]=process.argv.slice(1);',
    'const parse=t=>Object.fromEntries(t.split(/\\r?\\n/).map(l=>/^\\s*(?:export\\s+)?([\\w.]+)\\s*=\\s*(.*)$/.exec(l)).filter(Boolean).map(m=>[m[1],m[2].trim()]));',
    'const tpl=parse(fs.readFileSync(src,"utf8"));let out=fs.readFileSync(dst,"utf8");const cur=parse(out);',
    'for(const k of keys){const v=process.env[k];if(v===undefined||cur[k]!==tpl[k])continue;',
    'const re=new RegExp("^(\\\\s*(?:export\\\\s+)?"+k.replace(/\\./g,"\\\\.")+"\\\\s*=).*$","m");',
    "out=re.test(out)?out.replace(re,(_,p)=>p+JSON.stringify(v)):out}fs.writeFileSync(dst,out)",
  ].join("");
  return `node -e '${script}' /workspace/${template.file} /workspace/${template.target} ${safe.join(" ")}`;
}

const THIRD_PARTY =/^(OPENAI|ANTHROPIC|GEMINI|GOOGLE|GROQ|MISTRAL|COHERE|HF|HUGGING\w*|REPLICATE|STRIPE|GITHUB|GITLAB|SLACK|DISCORD|TWILIO|SENDGRID|MAILGUN|RESEND|POSTMARK|AWS|S3|CLOUDINARY|FIREBASE|SUPABASE|PINECONE|ALGOLIA|SENTRY|MAPBOX|PUSHER|AUTH0|CLERK|OPENROUTER|TOGETHER|PERPLEXITY|DEEPSEEK|XAI|ELEVENLABS|SERPAPI|TAVILY|LANGCHAIN|LANGSMITH)_/;

function commonEnrichment(snapshot: Snapshot, ev: RepoEvidence, base: Plan): Common {
  const services = detectServices(snapshot, ev);
  const shims = [...services.wanted].map(([kind, settings]) => shimFor(kind, settings)).filter((s): s is ServiceShim => s !== null);
  const set = combineShims(shims);
  const common: Common = { pins: ev.versions, shims: set, setup: [], env: {}, notes: [...set.notes, ...services.missing], needs: [], evidence: [] };

  const templated = new Set<string>();
  const needs: string[] = [];
  /** The same keys, under the env file each one belongs in. */
  const needIn = (file: string, key: string) => {
    needs.push(key);
    const row = common.needs.find((n) => n.file === file);
    if (row) row.keys.push(key);
    else common.needs.push({ file, keys: [key] });
  };
  const fills: { template: EnvTemplate; copy: string; keys: string[] }[] = [];
  for (const template of ev.envTemplates) {
    const filled = envFileEvidence(template, { port: base.port, serviceEnv: set.env, sqliteUrl: set.env.DATABASE_URL ? null : services.sqliteUrl });
    for (const k of Object.keys(template.values)) templated.add(k);
    for (const [k, v] of Object.entries(filled.fill)) if (k !== "PORT") common.env[k] ??= v;
    for (const k of filled.needs) if (!needs.includes(k)) needIn(template.target, k);
    fills.push({ template, copy: filled.copy, keys: Object.keys(filled.fill) });
    common.evidence.push(`${template.file} is copied to ${template.target}${Object.keys(filled.fill).length ? `; Pyrovue fills ${Object.keys(filled.fill).filter((k) => k !== "PORT").join(", ") || "PORT"}` : ""}.`);
  }
  // Service URLs go in the environment unless the app's own env file already points at a local server.
  for (const [k, v] of Object.entries(set.env)) if (!templated.has(k)) common.env[k] ??= v;
  const split = services.splitSettings ? shims.find((s) => s.kind === services.splitSettings) : undefined;
  const parsed = split?.env.DATABASE_URL ? settingsFromUrl(split.env.DATABASE_URL) : null;
  const splitEnv: Record<string, string> = {};
  if (split && parsed) {
    Object.assign(splitEnv, {
      DB_HOST: "127.0.0.1",
      DB_PORT: split.kind === "postgres" ? "5432" : "3306",
      DB_DATABASE: parsed.settings.database ?? "app",
      DB_USERNAME: parsed.settings.user ?? "root",
      DB_PASSWORD: parsed.settings.password ?? "",
    });
    Object.assign(common.env, splitEnv);
  }
  for (const f of fills) {
    common.setup.push(f.copy);
    const keys = [...f.keys, ...Object.keys(splitEnv).filter((k) => k in f.template.values && !f.keys.includes(k))];
    if (keys.length) common.setup.push(envFillCommand(f.template, keys));
  }

  const app = ev.appJson;
  if (app) {
    for (const name of app.secrets) common.env[name] ??= secretFor(name);
    for (const [k, v] of Object.entries(app.env)) common.env[k] ??= v;
    for (const r of app.required) if (common.env[r.name] === undefined && !needs.includes(r.name) && THIRD_PARTY.test(r.name)) needIn(ev.envTemplates[0]?.target ?? ".env", r.name);
  }
  if (needs.length) {
    const list = needs.slice(0, 6).join(", ");
    common.notes.push(`Add your own ${list}${needs.length > 6 ? " and others" : ""} to .env if a feature needs ${needs.length > 1 ? "them" : "it"}.`);
  }
  if (services.sources.length) common.evidence.push(`Services: ${services.sources.join(", ")}.`);
  const versions = Object.entries(ev.versions);
  if (versions.length) common.evidence.push(`Version files pin ${versions.map(([t, v]) => `${t} ${v}`).join(", ")}.`);
  return common;
}

// ---------------------------------------------------------------- assembling plans

interface Draft {
  strategy: Strategy | "framework:both";
  prior: number;
  setup: string[];
  /** The foreground command: the server the preview shows. Background programs go in `services`. */
  start: string | null;
  cwd: string;
  /** The repo's own programs started in the background before `start` (a backend, an asset watcher, a sibling). */
  services?: PlanService[];
  /** Start the services from the root without a `cd`, as a Procfile.dev's watchers run. */
  bareServices?: boolean;
  stack?: string[];
  env?: Record<string, string>;
  /** Port evidence specific to this strategy (EXPOSE, compose ports, forwarded ports). */
  ports?: PortHint[];
  /** Runtime versions this evidence implies (Dockerfile FROM, devcontainer features), below version files. */
  runtimes?: Partial<Record<Tool, string>>;
  rationale: string;
  summary?: string;
  previewPath?: string | null;
  confidence?: Plan["confidence"];
  /** Keep the base plan's port when the framework fixes it (a dev server's default). */
  fixedPort?: number | null;
  /** What the evidence itself says to the user, before the notes every plan gets. */
  notes?: string[];
}

const PROD_ENV = /^(NODE_ENV|RAILS_ENV|RACK_ENV|APP_ENV|FLASK_ENV|DJANGO_ENV|ENVIRONMENT|MIX_ENV)$/;

/** Env read from the repo: no production mode, no host paths, nothing that looks like a real credential. */
function cleanEnv(env: Record<string, string>, fromRepo: boolean): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    // Production mode skips dev dependencies during installs and disables dev servers.
    if (PROD_ENV.test(k) && /^prod/i.test(v)) continue;
    // Flask's debug mode serves Werkzeug's debugger (a crashing page's source and a console) on the shared preview.
    if (k === "FLASK_DEBUG" && !/^(0|false|no|off)?$/i.test(v.trim())) continue;
    if (/^(PATH|HOME|USER|SHELL|PWD|HOSTNAME)$/.test(k) || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) continue;
    if (fromRepo && looksSecret(`${k}=${v}`)) continue;
    out[k] = v;
  }
  return out;
}

const isPin = (cmd: string) => Object.values(PINNED).some((re) => re.test(cmd)) && !/^cd /.test(cmd);

/** Setup that already provides a tool, so it needn't be installed again. */
const PROVIDES: Record<string, RegExp> = {
  go: /\bmise use -g go@/,
  air: /\bgo install github\.com\/air-verse/,
  cargo: /\bmise use -g rust@/,
  rustc: /\bmise use -g rust@/,
  ruby: /\bmise use -g ruby@/,
  bundle: /\bmise use -g ruby@/,
  gem: /\bmise use -g ruby@/,
  deno: /\bmise use -g deno@/,
  php: /\bapt-get install\b.*\bphp-cli\b/,
  composer: /\bapt-get install\b.*\bcomposer\b/,
};

/**
 * Commands from a README or Makefile assume tools a contributor has (poetry, composer, just, go). Each one the box
 * lacks is installed first, guarded so it's a no-op when it's already there.
 */
function ensureTools(setup: string[], starts: string[]): string[] {
  const needed: string[] = [];
  for (const cmd of [...setup, ...starts]) {
    for (const segment of splitChain(cmd.replace(/^\(|\)\s*&$/g, ""))) {
      const head = headWord(segment.replace(/^\(?cd \S+ && /, ""));
      const install = TOOLS[head];
      if (!install || needed.some((n) => n.includes(install))) continue;
      if (PROVIDES[head]?.test(setup.join("\n")) || setup.some((c) => c.includes(install))) continue;
      if (head === "php" && (setup.some((c) => c.includes(TOOLS.composer!)) || needed.some((n) => n.includes(TOOLS.composer!)))) continue;
      needed.push(`command -v ${head} >/dev/null || ${/&&|;|\|/.test(install) ? `(${install})` : install}`);
    }
  }
  if (!needed.length) return setup;
  const pins = setup.filter(isPin);
  return [...pins, ...needed, ...setup.filter((c) => !isPin(c))];
}

class Builder {
  readonly plans: Plan[] = [];
  constructor(
    private readonly base: Plan,
    private readonly common: Common,
    private readonly ev: RepoEvidence,
  ) {}

  /** The ranked port evidence shared by every strategy. */
  private sharedHints(env: Record<string, string>): PortHint[] {
    const hints: PortHint[] = [];
    const envPorts = [env.PORT, ...this.ev.envTemplates.map((t) => t.values.PORT)];
    for (const v of envPorts) if (v && /^\d{2,5}$/.test(v)) hints.push({ port: Number(v), source: "env" });
    for (const p of [this.ev.readme, ...this.ev.guides].flatMap((r) => r?.ports ?? [])) hints.push({ port: p, source: "readme" });
    for (const p of this.ev.codePorts) hints.push({ port: p, source: "code" });
    return hints;
  }

  /**
   * `front` is the detector plan for the folder the draft runs in front: the base, or the frontend of a framework:both
   * plan. Every plan keeps the base's signature, the key the whole list is ranked and learned under.
   */
  add(d: Draft, front: Plan = this.base) {
    if (d.prior < MIN_PRIOR) return;
    const base = front;
    // The detector's env (NODE_OPTIONS, analytics opt-outs) belongs to its folder; PORT is decided per plan below.
    const { PORT: _basePort, ...baseEnv } = base.env;
    const env = { ...cleanEnv({ ...this.common.env, ...(d.cwd === base.cwd ? baseEnv : {}) }, false), ...cleanEnv(d.env ?? {}, true) };
    // Runtime pins first, then services, env files, and the strategy's own steps, spelled the same way everywhere.
    const own = d.setup.filter((c) => c.length <= MAX_COMMAND * 2).map((c) => normalizeStep(c, d.cwd));
    const ownStart = d.start ? normalizeStep(d.start, d.cwd) : null;
    const services = ownStart ? (d.services ?? []).map((s) => ({ ...s, command: withoutFlaskDebugger(s.command.trim().replace(/\s+/g, " ")) })) : [];
    const setup = ensureTools(
      withPins(dedupe([...own.filter(isPin), ...this.common.shims.setup, ...this.common.setup, ...own.filter((c) => !isPin(c))]), this.common.pins, d.runtimes ?? {}),
      [...services.map((s) => s.command), ...(ownStart ? [ownStart] : [])],
    );
    // A service shim restarts its daemons when a stopped box wakes up, so it goes first; then the background services,
    // then the server the preview shows.
    const body = ownStart ? withServices(ownStart, services, { bare: d.bareServices }) : null;
    const start = body && this.common.shims.prelude ? `${this.common.shims.prelude}; ${body}` : body;

    let port: number | null = null;
    if (d.start) {
      // The foreground command's own port: a background backend's `--port 8001` is not where the preview goes.
      const own = commandPort(d.start);
      // A dev-server config in the plan's own folder (vite.config.ts `port: 3000`) overrides the framework default.
      const configPort = base.signature?.startsWith("node:") ? this.ev.configPorts.find((p) => p.dir === relDir(d.cwd))?.port : undefined;
      if (own) port = own;
      else if (d.fixedPort !== undefined && d.fixedPort !== null) port = configPort ?? d.fixedPort;
      else {
        const hints: PortHint[] = [...(d.ports ?? []), ...this.sharedHints(env)];
        if (base.port && d.cwd === base.cwd) hints.push({ port: base.port, source: "default" });
        port = choosePort(hints) ?? base.port ?? 3000;
      }
    }
    // Apps that read PORT then listen where the preview expects; the framework detector decides this for its own plan.
    if (d.start && port && (d.strategy !== "framework" || base.env.PORT !== undefined)) env.PORT = String(port);

    const prior = Math.min(0.97, d.prior);
    this.plans.push({
      stack: d.stack ?? base.stack,
      kind: d.start ? (d.strategy === "framework" ? base.kind : base.kind === "cli" || base.kind === "unknown" ? "web" : base.kind) : "cli",
      summary: d.summary ?? base.summary,
      setup,
      start,
      port: d.start ? port : null,
      env,
      cwd: d.cwd,
      previewPath: d.previewPath !== undefined ? d.previewPath : d.cwd === base.cwd ? base.previewPath : null,
      confidence: d.confidence ?? confidenceFor(prior),
      strategy: d.strategy,
      prior,
      signature: this.base.signature,
      rationale: d.rationale,
      ...(d.notes?.length || this.common.notes.length ? { notes: [...(d.notes ?? []), ...this.common.notes] } : {}),
      ...(this.common.needs.length ? { needs: this.common.needs.map((n) => ({ file: n.file, keys: [...n.keys] })) } : {}),
      ...(services.length ? { services } : {}),
      ...(base.facts ? { facts: base.facts } : {}),
    });
  }
}

// ---------------------------------------------------------------- validating mined commands

function scriptsAt(snapshot: Snapshot, dir: string): string[] | null {
  const pkg = parseJson<{ scripts?: Record<string, string> }>(snapshot.contents[dir === "." ? "package.json" : `${dir}/package.json`]);
  return pkg ? Object.keys(pkg.scripts ?? {}) : null;
}

function pmAt(snapshot: Snapshot, files: Set<string>, dir: string, fallback: PM | undefined): PM {
  const pkg = parseJson<{ packageManager?: string }>(snapshot.contents[dir === "." ? "package.json" : `${dir}/package.json`]);
  const field = typeof pkg?.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (field === "pnpm" || field === "yarn" || field === "bun" || field === "npm") return field;
  const at = (f: string) => files.has(dir === "." ? f : `${dir}/${f}`) || files.has(f);
  if (at("pnpm-lock.yaml")) return "pnpm";
  if (at("bun.lockb") || at("bun.lock")) return "bun";
  if (at("yarn.lock")) return "yarn";
  return fallback ?? "npm";
}

/** Rewrites equivalent spellings to one form, so the same instructions from two sources dedupe. */
export function normalizeCommand(cmd: string, dir = "."): string {
  const c = withoutFlaskDebugger(cmd.trim().replace(/\s+/g, " "));
  // `cp .env.example .env` becomes the same never-overwrite copy Pyrovue makes for env templates.
  const envCopy = /^cp (?:-n )?(\S*\.env[\w.-]*|\S*env\.example) (\S*\.env(?:\.local|\.development)?)$/.exec(c);
  if (envCopy) {
    const abs = (f: string) => `/workspace/${path.normalize(path.join(dir, f))}`.replace(/\/\.$/, "");
    return `test -f ${abs(envCopy[2]!)} || cp ${abs(envCopy[1]!)} ${abs(envCopy[2]!)}`;
  }
  const tool = jsTool(c);
  if (tool) {
    if (/^(npm (i|install|ci)|yarn( install)?|pnpm (i|install)|bun (i|install))( --(frozen-lockfile|immutable|no-audit|no-fund|prefer-offline|silent))*$/.test(c)) return installCommand(tool);
    const script = scriptOf(c);
    const rest = /^(?:npm|pnpm|yarn|bun) (?:run )?[\w:.-]+(.*)$/.exec(c)?.[1] ?? "";
    if (script && script !== "test" && !/^(npx|pnpx|bunx)$/.test(c.split(" ")[0]!)) return `${runScript(tool, script)}${rest}`;
  }
  const pip = /^(?:python3? -m )?pip3? install (-r \S+|-e \.(?:\[[\w,-]+\])?|\.(?:\[[\w,-]+\])?|-e ["']\.\[[\w,-]+\]["'])$/.exec(c);
  if (pip) return `uv pip install ${pip[1]}`;
  return c;
}

/** normalizeCommand for a plan step, which may start with `cd /workspace/dir && `. */
function normalizeStep(cmd: string, cwd: string): string {
  const m = /^(cd (\S+) && )(.*)$/.exec(cmd);
  const dir = relDir(m ? m[2]! : cwd);
  const inner = m ? m[3]! : cmd;
  const normal = normalizeCommand(inner, dir);
  return m ? `${m[1]}${normal}` : normal;
}

function exists(files: Set<string>, dir: string, file: string): boolean {
  return files.has(path.normalize(path.join(dir, file)));
}

/** A mined command refers only to things that exist: package.json scripts, Python files, Makefile targets. */
function valid(cmd: string, dir: string, snapshot: Snapshot, ev: RepoEvidence): boolean {
  const script = scriptOf(cmd);
  if (script) {
    const scripts = scriptsAt(snapshot, dir);
    if (scripts && !scripts.includes(script) && !/^(start)$/.test(script)) return false;
    if (scripts && script === "start" && !scripts.includes("start") && !exists(ev.files, dir, "server.js")) return false;
  }
  const py = /^(?:(?:uv|poetry|pipenv|pdm) run )?python3? ([\w/.-]+\.py)\b/.exec(cmd);
  if (py && !exists(ev.files, dir, py[1]!)) return false;
  if (/\bmanage\.py\b/.test(cmd) && !exists(ev.files, dir, "manage.py") && !/cd \S+ && /.test(cmd)) return false;
  const task = /^(make|just|task) ([\w.-]+)/.exec(cmd);
  if (task) {
    if (!ev.tasks || dir !== ev.tasks.dir || !ev.tasks.targets.includes(task[2]!)) return false;
    if (ev.tasks.skipped.some((s) => s.command === `${task[1]} ${task[2]}`)) return false;
  }
  return true;
}

const FILE_OPS = /^(mkdir|cp|touch|chmod \+x|ln -s)\b/;
const FRONTEND_DIR = /(^|\/)(frontend|client|web|ui|webapp|www)$/i;
const BACKEND_DIR = /(^|\/)(backend|server|api)$/i;

/** The language a command runs, matching the first part of a stack signature. */
export function languageOf(cmd: string): string | null {
  const c = cmd.replace(/^cd \S+ && /, "").replace(/^([A-Za-z_]\w*=\S*\s+)+/, "");
  if (jsTool(c) || /^(node|npx|vite|next|nuxt|astro|ng|nodemon|tsx|ts-node|webpack|parcel)\b/.test(c)) return "node";
  if (/^(python3?|uv|poetry|pipenv|pdm|flask|uvicorn|gunicorn|hypercorn|daphne|streamlit|gradio|django-admin|celery)\b|\bmanage\.py\b/.test(c)) return "python";
  if (/^(bin\/rails|rails|bundle|rackup|puma|ruby|bin\/dev|rake)\b/.test(c)) return "ruby";
  if (/^(php|composer)\b|\bartisan\b/.test(c)) return "php";
  if (/^(go|air)\b/.test(c)) return "go";
  if (/^cargo\b/.test(c)) return "rust";
  return null;
}

const at = (cwd: string, dir: string, cmd: string) => (cwdFor(dir) === cwd ? cmd : `cd ${cwdFor(dir)} && ${cmd}`);

/** The standard install for a folder whose instructions don't include one. */
function defaultInstall(snapshot: Snapshot, files: Set<string>, dir: string, base: Plan, cwd: string): string[] {
  const has = (f: string) => files.has(dir === "." ? f : `${dir}/${f}`);
  let cmd: string | null = null;
  if (has("package.json")) cmd = installCommand(pmAt(snapshot, files, dir, base.facts?.pm));
  else if (has("requirements.txt")) cmd = "uv pip install -r requirements.txt";
  else if (has("pyproject.toml")) cmd = "uv pip install -e . || pip install -e .";
  else if (has("Gemfile")) cmd = "bundle install";
  else if (has("go.mod")) cmd = "go mod download";
  return cmd ? [at(cwd, dir, cmd)] : [];
}

// ---------------------------------------------------------------- strategies

/** A background program as the user reads it in a note: "`go run .` in api/". */
export function serviceName(command: string, cwd: string): string {
  return `\`${short(command, 48)}\` in ${folderLabel(cwd)}`;
}

/** A background program the evidence starts next to the server, listening where its command says (if it says). */
function backgroundService(command: string, cwd: string, port: number | null = commandPort(command)): PlanService {
  return { name: serviceName(command, cwd), cwd, command, port };
}

function readmeDraft(snapshot: Snapshot, ev: RepoEvidence, base: Plan): Draft | null {
  const sources = [ev.readme, ...ev.guides].filter((r) => r !== null);
  if (!sources.length) return null;
  const mined: MinedCommand[] = sources.flatMap((r, i) => r.commands.map((c) => ({ ...c, weight: i === 0 ? c.weight : c.weight * 0.9 })));
  const usable = mined.filter((c) => c.weight >= 0.5 && valid(c.command, c.dir, snapshot, ev));
  const normalized = usable.map((c) => ({ ...c, command: normalizeCommand(c.command, c.dir) }));

  const starts = normalized.filter((c) => c.kind === "start");
  // The project's own language starts the server; a JavaScript watcher next to a PHP or Ruby server builds assets.
  const language = base.signature?.split(":")[0] ?? null;
  const scoreOf = (c: MinedCommand, i: number) =>
    c.weight + (isDevStart(c.command) ? 0.15 : 0) - (c.inline ? 0.15 : 0) + (language && languageOf(c.command) === language ? 0.2 : 0) - i * 0.001;
  const ranked = starts.map((c, i) => ({ c, s: scoreOf(c, i) })).sort((a, b) => b.s - a.s).map((x) => x.c);
  let main = ranked[0];
  if (!main && !base.start) return null;

  const background: MinedCommand[] = [];
  if (main) {
    // A README that starts a backend and a frontend from different folders runs both, with the frontend in front.
    const front = ranked.find((c) => FRONTEND_DIR.test(c.dir) && !c.inline);
    const back = ranked.find((c) => BACKEND_DIR.test(c.dir) && !c.inline && c.weight >= 0.6);
    const assets = ranked.find((c) => c !== main && c.dir === main!.dir && !c.inline && languageOf(c.command) === "node" && language !== "node" && languageOf(main!.command) === language);
    if (front && back && front.dir !== back.dir) {
      main = front;
      background.push(back);
    } else if (assets) {
      background.push(assets);
    }
  }
  const cwd = main ? cwdFor(main.dir) : base.cwd;
  const dirs = new Set([main?.dir ?? relDir(base.cwd), ...background.map((b) => b.dir)]);

  const steps: string[] = [];
  const installedDirs = new Set<string>();
  for (const c of normalized) {
    if (c.kind === "start") continue;
    if (c.kind === "other" && !FILE_OPS.test(c.command)) continue;
    if (c.inline && c.kind !== "install") continue;
    // Steps for a folder this plan doesn't run are someone else's instructions; root steps apply to every folder.
    if (!dirs.has(c.dir) && c.dir !== ".") continue;
    if (c.kind === "install") installedDirs.add(c.dir);
    steps.push(at(cwd, c.dir, c.command));
  }
  if (!main && !steps.length) return null;
  // A README that only says how to start it still needs the dependencies installed.
  const missing = [...dirs].filter((d) => !installedDirs.has(d) && !installedDirs.has("."));
  const setup = installedDirs.size && !missing.length ? steps : [...missing.flatMap((d) => (cwdFor(d) === base.cwd ? base.setup : defaultInstall(snapshot, ev.files, d, base, cwd))), ...steps];
  if (!setup.length && !main) return null;

  const start = main?.command ?? base.start;
  const services = background.map((b) => backgroundService(b.command, cwdFor(b.dir)));

  const env: Record<string, string> = {};
  for (const r of sources) Object.assign(env, r.env);
  const runtimes: Partial<Record<Tool, string>> = {};
  for (const v of sources.flatMap((r) => r.versions)) runtimes[v.tool] ??= v.version;

  const weight = main?.weight ?? 0.5;
  let prior = 0.45 + 0.25 * weight + (installedDirs.size ? 0.03 : 0);
  if (main?.inline) prior *= 0.85;
  if (!main) prior -= 0.1;
  if (ev.readme?.installsPublished && !main) prior -= 0.1;
  const file = sources[0]!.file;
  return {
    strategy: "readme",
    prior,
    setup,
    start,
    cwd,
    services,
    env,
    runtimes,
    rationale: main ? `The ${file} says \`${short(main.command)}\`. Trying that.` : `Following the install steps in ${file}.`,
  };
}

function procfileDrafts(ev: RepoEvidence, base: Plan): Draft[] {
  const out: Draft[] = [];
  for (const p of ev.procfiles) {
    if (!p.web) continue;
    const dev = /\.dev$/.test(p.file);
    out.push({
      strategy: "procfile",
      prior: dev ? 0.66 : 0.58,
      setup: [...base.setup, ...p.release],
      // The web process in front and the Procfile.dev's watchers behind it, as withServices writes them.
      start: p.web,
      services: p.watchers.map((w) => backgroundService(w, WORKSPACE)),
      bareServices: true,
      cwd: WORKSPACE,
      // foreman and Heroku hand a Procfile PORT=5000 unless told otherwise.
      ports: base.port ? [] : [{ port: 5000, source: "default" }],
      rationale: `The ${p.file} runs \`${short(p.web)}\`. Trying that.`,
    });
  }
  return out;
}

function makefileDraft(ev: RepoEvidence, base: Plan): Draft | null {
  const t = ev.tasks;
  if (!t?.start) return null;
  const file = t.file.split("/").pop()!;
  return {
    strategy: "makefile",
    prior: t.install ? 0.57 : 0.54,
    setup: [...t.prefix, ...(t.install ? [t.install] : base.setup), ...(t.db ? [t.db] : [])],
    start: t.start,
    cwd: cwdFor(t.dir),
    rationale: `The ${file} has a \`${t.start.split(" ")[1]}\` target. Trying \`${t.start}\`.`,
  };
}

const hasInstall = (setup: string[]) => setup.some((c) => classifyCommand(c.replace(/^cd \S+ && /, "")) === "install");

function dockerfileDrafts(ev: RepoEvidence, base: Plan): Draft[] {
  return ev.dockerfiles
    .filter((d) => d.start)
    .slice(0, 2)
    .map((d) => ({
      strategy: "dockerfile" as const,
      prior: d.dev ? 0.55 : 0.45,
      setup: hasInstall(d.setup) ? d.setup : [...(cwdFor(d.cwd) === base.cwd ? base.setup : []), ...d.setup],
      start: d.start,
      cwd: cwdFor(d.cwd),
      env: d.env,
      ports: d.ports.map((port) => ({ port, source: "expose" as const })),
      runtimes: d.runtime ? { [d.runtime.tool]: d.runtime.version } : {},
      rationale: `The ${d.file} starts it with \`${short(d.start!)}\`. Running that without Docker.`,
    }));
}

/** A compose command split into the setup it does first (installs, migrations) and the server it ends with. */
function splitCommand(raw: string, files: Set<string>, dir: string): { setup: string[]; start: string } | null {
  const setup: string[] = [];
  const rest: string[] = [];
  for (const segment of splitChain(raw)) {
    const s = sanitizeCommand(segment, { files, dir });
    if (s.skip) return null;
    if (!s.command) continue;
    const kind = classifyCommand(s.command);
    if (!rest.length && (kind === "install" || kind === "db" || kind === "build" || kind === "env")) setup.push(s.command);
    else rest.push(s.command);
  }
  return rest.length ? { setup, start: rest.join(" && ") } : null;
}

function composeDraft(snapshot: Snapshot, ev: RepoEvidence, base: Plan): Draft | null {
  const compose = ev.compose;
  const app = compose?.info.app;
  if (!compose || !app) return null;
  const files = ev.files;

  const serviceRun = (svc: typeof app) => {
    const dir = svc.context ?? ".";
    const dfPath = path.normalize(path.join(dir, svc.dockerfile ?? "Dockerfile"));
    const text = snapshot.contents[dfPath];
    const df = text ? dockerEvidence(text, { files, dir, name: `${dfPath} ${svc.target ?? ""}` }) : null;
    // Where the image keeps the checkout: the volume mount, the compose working_dir, or the Dockerfile's COPY target.
    const imageRoot = svc.mount ?? svc.workingDir ?? (text ? (parseDockerfile(text)?.final.appRoot ?? null) : null);
    const target = cwdFor(dir);
    const cmd = svc.command ? splitCommand(translatePaths(svc.command, imageRoot, target), files, dir) : null;
    const start = cmd?.start ?? df?.start ?? (cwdFor(dir) === base.cwd ? base.start : null);
    const own = df ? (hasInstall(df.setup) ? df.setup : [...(cwdFor(df.cwd) === base.cwd ? base.setup : []), ...df.setup]) : cwdFor(dir) === base.cwd ? base.setup : [];
    const cwd = df && !cmd ? cwdFor(df.cwd) : target;
    return { dir, cwd, start, setup: [...own, ...(cmd?.setup ?? [])], env: { ...df?.env, ...svc.env }, df };
  };

  const main = serviceRun(app);
  if (!main.start) return null;
  const setup = [...main.setup];
  const services: PlanService[] = [];
  const names: string[] = [];
  for (const sib of compose.info.siblings.slice(0, 2)) {
    const run = serviceRun(sib);
    if (!run.start || run.dir === main.dir) continue;
    setup.push(...run.setup.map((c) => (/^cd /.test(c) || run.cwd === main.cwd ? c : `cd ${run.cwd} && ${c}`)));
    // Each later sibling starts first, as the start string has always been written.
    services.unshift(backgroundService(run.start, run.cwd, commandPort(run.start) ?? sib.ports[0] ?? null));
    names.push(sib.name);
  }
  const env = localizeEnv(main.env, compose.info.services.map((s) => s.name));
  const companions = compose.info.companions.filter((c) => c.kind).map((c) => c.name);
  const also = [...names, ...companions];
  return {
    strategy: "compose",
    prior: main.df?.dev || /dev/i.test(app.target ?? "") || app.command ? 0.6 : 0.52,
    setup,
    start: main.start,
    services,
    cwd: main.cwd,
    env,
    ports: app.ports.map((port) => ({ port, source: "expose" as const })),
    runtimes: main.df?.runtime ? { [main.df.runtime.tool]: main.df.runtime.version } : {},
    rationale: `${compose.file} runs the ${app.name} service with \`${short(main.start)}\`. Running it directly${also.length ? `, with ${also.join(", ")} alongside` : ""}.`,
  };
}

function devcontainerDraft(ev: RepoEvidence, base: Plan): Draft | null {
  const dc = ev.devcontainer;
  if (!dc || (!dc.setup.length && !dc.start)) return null;
  const runtimes: Partial<Record<Tool, string>> = {};
  for (const r of dc.runtimes) runtimes[r.tool] ??= r.version;
  return {
    strategy: "devcontainer",
    prior: dc.setup.length ? 0.62 : 0.5,
    setup: hasInstall(dc.setup) ? dc.setup : [...base.setup, ...dc.setup],
    start: dc.start ?? base.start,
    cwd: dc.start ? WORKSPACE : base.cwd,
    env: dc.env,
    ports: dc.ports.map((port) => ({ port, source: "expose" as const })),
    runtimes,
    rationale: dc.setup.length ? `The dev container config sets it up with \`${short(dc.setup[0]!)}\`. Following it.` : `The dev container config starts it with \`${short(dc.start!)}\`. Trying that.`,
  };
}

function platformDrafts(ev: RepoEvidence, base: Plan): Draft[] {
  const out: Draft[] = [];
  for (const p of ev.platforms) {
    const dir = p.dir;
    const cwd = cwdFor(dir);
    const start = p.start ?? (p.publish ? `python3 -m http.server 8080 --bind 0.0.0.0 --directory ${shq(p.publish)}` : null);
    if (!start) continue;
    out.push({
      strategy: "platform",
      prior: p.start ? (p.source === "netlify.toml" ? 0.5 : 0.45) : 0.42,
      setup: hasInstall(p.setup) ? p.setup : [...(cwd === base.cwd ? base.setup : []), ...p.setup],
      start,
      cwd,
      env: p.env,
      ports: p.port ? [{ port: p.port, source: "expose" }] : p.publish ? [{ port: 8080, source: "command" }] : [],
      rationale: `${p.source} ${p.start ? `starts it with \`${short(p.start)}\`` : `builds it into ${p.publish}/`}. Trying that.`,
    });
  }
  return out;
}

/** Stacks whose dev server picks its own port: the detector's default is better evidence than a README link. */
const FIXED_PORT = /^(Next\.js|Nuxt|SvelteKit|Astro|Remix|Gatsby|Docusaurus|VitePress|Angular|Create React App|Vue CLI|Storybook|Vite|Parcel|Eleventy|Django|Streamlit|Gradio|FastAPI|Flask|Rails|Laravel|Static site)$/;

/** Servers that render their own pages: with a JavaScript folder next to them, they stay in front of its watcher. */
const SERVER_RENDERED = /^(Django|Rails|Laravel)$/;

/** What to call a detector plan's server in a sentence: its framework, or else its language. */
function serverLabel(p: Plan): string {
  return p.stack.find((s) => FIXED_PORT.test(s) || /^(NestJS|Hono|Fastify|Express|Koa|Spring Boot|ASP\.NET Core)$/.test(s)) ?? p.stack[0] ?? "server";
}

/** A server that can run in the background behind a JavaScript dev server: a web server, or a Go program. */
export function runsBehindFrontend(plan: Plan): plan is Plan & { start: string } {
  return plan.start !== null && (plan.kind === "web" || plan.stack[0] === "Go");
}

/**
 * Both folders' framework defaults as one plan: the JavaScript dev server in front (the preview) with the Python or Go
 * server as a background service, except a Django, Rails or Laravel root, which stays in front with the JavaScript
 * watcher behind it. API calls reach a backend through the frontend dev server's proxy; it gets no public port of its
 * own. Null unless both are servers.
 */
function bothDraft(base: Plan, secondary: Plan): { draft: Draft; front: Plan } | null {
  const node = (p: Plan) => p.stack[0] === "Node.js";
  const [front, back] = !node(base) && node(secondary) && !base.stack.some((s) => SERVER_RENDERED.test(s)) ? [secondary, base] : [base, secondary];
  if (!front.start || front.kind !== "web" || !runsBehindFrontend(back)) return null;
  // Both would bind it (a Vue CLI frontend and a Go server on 8080): the frontend on its own is the better plan.
  if (back.port !== null && back.port === front.port) return null;
  const label = serverLabel(back);
  const where = folderLabel(back.cwd);
  const backend = !node(back);
  // What the backend's own plan sets to start (ASPNETCORE_ENVIRONMENT, SERVER_PORT); PORT is the frontend's here.
  const { PORT: _backPort, ...backEnv } = backend ? back.env : {};
  const service: PlanService = {
    name: `${label} in ${where}`,
    cwd: back.cwd,
    command: back.start,
    port: back.port,
    // A backend whose command names no port only gets the detector's default through PORT.
    ...(backend && back.port !== null && commandPort(back.start) === null ? { portGuessed: true } : {}),
  };
  return {
    front,
    draft: {
      strategy: "framework:both",
      prior: Math.min(0.97, priorFor(front.confidence) + 0.05),
      // The backend's install runs in its own folder, before the frontend's.
      setup: dedupe([...back.setup.map((c) => (back.cwd === front.cwd || /^cd /.test(c) ? c : `cd ${back.cwd} && ${c}`)), ...front.setup]),
      start: front.start,
      cwd: front.cwd,
      services: [service],
      // Hints for a dev-server proxy config that reads where the API is.
      env: { ...backEnv, ...(backend && back.port ? { BACKEND_PORT: String(back.port), API_PORT: String(back.port) } : {}) },
      fixedPort: front.port,
      previewPath: front.previewPath,
      stack: dedupe([...front.stack, ...back.stack]),
      summary: `${front.summary.slice(0, -1)} with ${/^[AEIOU]/.test(label) ? "an" : "a"} ${label} ${backend ? "backend" : "frontend"} in ${where}.`,
      rationale: `Starting ${service.name} in the background and \`${short(front.start)}\` in front.`,
    },
  };
}

function evidenceLines(ev: RepoEvidence, common: Common): string[] {
  const lines: string[] = [];
  for (const r of [ev.readme, ...ev.guides]) {
    if (!r) continue;
    const kept = r.commands.filter((c) => c.weight >= 0.5);
    const sections = [...new Set(kept.map((c) => c.section).filter(Boolean))].slice(0, 3);
    if (kept.length) lines.push(`${r.file}: ${kept.length} command${kept.length > 1 ? "s" : ""}${sections.length ? ` under ${sections.map((s) => `"${s}"`).join(", ")}` : ""}: ${kept.slice(0, 6).map((c) => `\`${short(c.command, 60)}\``).join(", ")}.`);
    for (const s of r.skipped.slice(0, 3)) lines.push(`${r.file}: left out \`${short(s.command, 60)}\` (${s.reason}).`);
    if (r.ports.length) lines.push(`${r.file} mentions localhost:${r.ports.slice(0, 3).join(", localhost:")}.`);
  }
  for (const d of ev.dockerfiles) lines.push(`${d.file}: ${d.setup.length} build step${d.setup.length === 1 ? "" : "s"}${d.ports.length ? `, EXPOSE ${d.ports.join(" ")}` : ""}${d.start ? `, starts \`${short(d.start, 60)}\`` : ""}.`);
  if (ev.compose) {
    const { app, companions } = ev.compose.info;
    lines.push(`${ev.compose.file}: ${app ? `app service ${app.name}${app.ports.length ? ` (port ${app.ports.join(", ")})` : ""}` : "no service built from the repo"}${companions.length ? `; ${companions.map((c) => `${c.name} (${c.kind ?? c.image})`).join(", ")}` : ""}.`);
  }
  if (ev.devcontainer) lines.push(`${ev.devcontainer.file}: ${ev.devcontainer.setup.length} setup command${ev.devcontainer.setup.length === 1 ? "" : "s"}${ev.devcontainer.ports.length ? `, forwards ${ev.devcontainer.ports.join(", ")}` : ""}.`);
  for (const p of ev.procfiles) lines.push(`${p.file}: ${Object.keys(p.processes).join(", ") || "no processes"}${p.web ? `; web runs \`${short(p.web, 60)}\`` : ""}.`);
  if (ev.tasks) lines.push(`${ev.tasks.file}: targets ${ev.tasks.targets.slice(0, 10).join(", ")}${ev.tasks.skipped.length ? ` (skipping ${ev.tasks.skipped.map((s) => s.command).join(", ")})` : ""}.`);
  for (const p of ev.platforms) lines.push(`${p.source}: ${p.start ? `starts \`${short(p.start, 60)}\`` : p.publish ? `publishes ${p.publish}/` : "build only"}.`);
  if (ev.codePorts.length) lines.push(`Source code listens on ${ev.codePorts.slice(0, 3).join(", ")}.`);
  return [...lines, ...common.evidence].slice(0, 24);
}

/**
 * Every plan the evidence supports, deduplicated, best prior first. `base` is the framework detector's plan,
 * `explicit` the repo's own pyrovue.json, if any, and `secondary` the detector's plan for a second stack in another
 * folder (a backend next to a frontend), which runs together with the base when both are servers.
 */
export function buildCandidates(snapshot: Snapshot, ev: RepoEvidence, base: Plan, explicit: Plan | null, secondary: Plan | null = null): Plan[] {
  const common = commonEnrichment(snapshot, ev, base);
  const b = new Builder(base, common, ev);

  if (base.start || base.setup.length || base.kind !== "unknown") {
    const label = base.stack.find((s) => FIXED_PORT.test(s));
    b.add({
      strategy: "framework",
      prior: priorFor(base.confidence),
      confidence: base.confidence,
      setup: base.setup,
      start: base.start,
      cwd: base.cwd,
      fixedPort: label && base.port ? base.port : undefined,
      notes: base.notes,
      rationale: base.start ? `Trying the ${label ?? base.stack[0] ?? "project"} defaults: \`${short(base.start)}\`.` : `Installing it the standard way for ${base.stack[0] ?? "this stack"}.`,
    });
  }
  const both = secondary ? bothDraft(base, secondary) : null;
  if (both) b.add(both.draft, both.front);
  const readme = readmeDraft(snapshot, ev, base);
  if (readme) b.add(readme);
  for (const d of procfileDrafts(ev, base)) b.add(d);
  const make = makefileDraft(ev, base);
  if (make) b.add(make);
  const devcontainer = devcontainerDraft(ev, base);
  if (devcontainer) b.add(devcontainer);
  const compose = composeDraft(snapshot, ev, base);
  if (compose) b.add(compose);
  for (const d of dockerfileDrafts(ev, base)) b.add(d);
  for (const d of platformDrafts(ev, base)) b.add(d);

  // The repo's own config still needs the keys its env template names, like every other plan.
  const needs = common.needs.length ? { needs: common.needs.map((n) => ({ file: n.file, keys: [...n.keys] })) } : {};
  const plans: Plan[] = explicit
    ? [{ ...explicit, strategy: "pyrovue-json", prior: 0.95, signature: base.signature, rationale: "Using the repository's pyrovue.json.", ...needs }, ...b.plans]
    : b.plans;
  const unique = dedupePlans(plans);
  const evidence = evidenceLines(ev, common);
  return unique.map((p) => ({ ...p, evidence }));
}

/** Identical plans from different evidence are one plan, and the agreement makes it more likely to be right. */
export function dedupePlans(plans: Plan[]): Plan[] {
  const sorted = plans.map((p, i) => ({ p, i })).sort((a, b) => (b.p.prior ?? 0) - (a.p.prior ?? 0) || a.i - b.i).map((x) => x.p);
  const byKey = new Map<string, Plan>();
  for (const p of sorted) {
    const key = JSON.stringify([p.setup, p.start, p.cwd]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...p });
      continue;
    }
    prev.prior = Math.min(0.97, (prev.prior ?? 0.5) + 0.1 * (p.prior ?? 0.5));
    if (prev.strategy !== "framework" || p.strategy === "framework") prev.confidence = confidenceFor(prev.prior);
    prev.env = { ...p.env, ...prev.env };
  }
  return [...byKey.values()].sort((a, b) => (b.prior ?? 0) - (a.prior ?? 0));
}

/** Splits ranked candidates into the plan detect() returns and its alternatives. */
export function withAlternatives(ranked: Plan[]): Plan {
  const [best, ...rest] = ranked;
  const alternatives = rest.slice(0, ALTERNATIVES).map(({ alternatives: _drop, ...p }) => p);
  return alternatives.length ? { ...best!, alternatives } : best!;
}

/** A compact account of what the detector read and what it would try, useful as context for an AI agent. */
export function describePlan(plan: Plan): string {
  const lines: string[] = [];
  if (plan.strategy) lines.push(`strategy: ${plan.strategy}${plan.prior !== undefined ? ` (prior ${plan.prior.toFixed(2)})` : ""}`);
  if (plan.signature) lines.push(`signature: ${plan.signature}`);
  if (Object.keys(plan.env).length) lines.push(`env: ${Object.keys(plan.env).join(", ")}`);
  if (plan.notes?.length) lines.push(...plan.notes.map((n) => `note: ${n}`));
  if (plan.evidence?.length) lines.push("evidence:", ...plan.evidence.map((e) => `- ${e}`));
  if (plan.alternatives?.length) {
    lines.push("other plans Pyrovue would try:");
    for (const a of plan.alternatives) lines.push(`- ${a.strategy ?? "plan"}: setup ${a.setup.length ? a.setup.map((s) => short(s, 80)).join(" && ") : "(none)"}; start ${a.start ? short(a.start, 100) : "(none)"}${a.cwd !== WORKSPACE ? `; cwd ${a.cwd}` : ""}`);
  }
  return lines.join("\n");
}
