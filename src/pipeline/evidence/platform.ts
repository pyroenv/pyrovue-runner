import { parseJson } from "../plan";
import { isPlaceholder, looksSecret, redact, SECRET_NAME, sanitizeCommand, splitChain } from "./shell";
import { parseToml, type TomlTable, tomlGet } from "./toml";
import { asString, isMap, parseYaml } from "./yaml";

/**
 * Hosting configs (fly.toml, render.yaml, netlify.toml, vercel.json, railway.json, nixpacks.toml, app.json) say how
 * the project is built and started in production. That's usually runnable in a box too, just less dev-friendly.
 */

export interface PlatformEvidence {
  source: string;
  /** Directory the commands run in, relative to the repo root. */
  dir: string;
  setup: string[];
  start: string | null;
  port: number | null;
  env: Record<string, string>;
  /** A static build's output directory, when the platform serves files rather than running a server. */
  publish: string | null;
  skipped: { command: string; reason: string }[];
}

function commands(raw: string | null | undefined, files: Set<string>, ev: PlatformEvidence, allowPartial: boolean): string[] {
  if (!raw) return [];
  const kept: string[] = [];
  for (const segment of splitChain(raw)) {
    const s = sanitizeCommand(segment, { files, dir: ev.dir, stripProductionFlags: true });
    if (s.skip) {
      ev.skipped.push({ command: redact(segment), reason: s.skip });
      if (!allowPartial) return [];
    }
    if (s.command) kept.push(s.command);
  }
  return kept;
}

function startOf(raw: string | null | undefined, files: Set<string>, ev: PlatformEvidence): string | null {
  const parts = commands(raw, files, ev, false);
  return parts.length ? parts.join(" && ") : null;
}

function safeEnv(entries: [string, unknown][]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of entries) {
    const value = typeof v === "number" || typeof v === "boolean" ? String(v) : typeof v === "string" ? v : null;
    if (value === null || !/^[A-Za-z_]\w*$/.test(k) || /^(NODE_ENV|RAILS_ENV|RACK_ENV|APP_ENV|PORT)$/.test(k)) continue;
    if ((SECRET_NAME.test(k) && !isPlaceholder(value)) || looksSecret(`${k}=${value}`) || /\$\{\{|\$\{/.test(value)) continue;
    out[k] = value;
  }
  return out;
}

const empty = (source: string, dir = "."): PlatformEvidence => ({ source, dir, setup: [], start: null, port: null, env: {}, publish: null, skipped: [] });
const num = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v > 0 && v < 65536 ? v : typeof v === "string" && /^\d{2,5}$/.test(v) ? Number(v) : null);

export function flyEvidence(text: string, files: Set<string>): PlatformEvidence | null {
  const t = parseToml(text);
  const ev = empty("fly.toml");
  const processes = tomlGet(t, "processes");
  const proc = processes && typeof processes === "object" && !Array.isArray(processes) ? ((processes as TomlTable).app ?? (processes as TomlTable).web) : undefined;
  ev.start = typeof proc === "string" ? startOf(proc, files, ev) : null;
  const release = tomlGet(t, "deploy.release_command");
  if (typeof release === "string") ev.setup.push(...commands(release, files, ev, false));
  const services = tomlGet(t, "services");
  ev.port = num(tomlGet(t, "http_service.internal_port")) ?? (Array.isArray(services) ? num((services[0] as TomlTable | undefined)?.internal_port) : null);
  const env = tomlGet(t, "env");
  if (env && typeof env === "object" && !Array.isArray(env)) ev.env = safeEnv(Object.entries(env));
  return ev.start || ev.port || ev.setup.length ? ev : null;
}

export function renderEvidence(text: string, files: Set<string>): PlatformEvidence[] {
  const doc = parseYaml(text);
  if (!isMap(doc) || !Array.isArray(doc.services)) return [];
  const out: PlatformEvidence[] = [];
  for (const raw of doc.services) {
    if (!isMap(raw)) continue;
    const type = asString(raw.type) ?? "web";
    if (!/^(web|static|pserv)$/.test(type)) continue;
    const dir = (asString(raw.rootDir) ?? ".").replace(/^\.?\/+/, "").replace(/\/+$/, "") || ".";
    const ev = empty("render.yaml", dir);
    ev.setup = commands(asString(raw.buildCommand), files, ev, true);
    ev.start = startOf(asString(raw.startCommand), files, ev);
    ev.publish = asString(raw.staticPublishPath);
    if (Array.isArray(raw.envVars)) ev.env = safeEnv(raw.envVars.filter(isMap).map((e) => [asString(e.key) ?? "", e.value ?? null]));
    if (ev.start || ev.publish) out.push(ev);
  }
  return out;
}

export function netlifyEvidence(text: string, files: Set<string>): PlatformEvidence | null {
  const t = parseToml(text);
  const base = tomlGet(t, "build.base");
  const dir = (typeof base === "string" ? base : ".").replace(/^\.?\/+/, "").replace(/\/+$/, "") || ".";
  const ev = empty("netlify.toml", dir);
  const dev = tomlGet(t, "dev.command");
  if (typeof dev === "string") {
    ev.start = startOf(dev, files, ev);
    ev.port = num(tomlGet(t, "dev.targetPort")) ?? num(tomlGet(t, "dev.port"));
  }
  const build = tomlGet(t, "build.command");
  const publish = tomlGet(t, "build.publish");
  if (!ev.start && typeof publish === "string") {
    ev.setup = commands(typeof build === "string" ? build : null, files, ev, true);
    ev.publish = publish.replace(/^\.?\/+/, "").replace(/\/+$/, "") || ".";
  }
  const env = tomlGet(t, "build.environment");
  if (env && typeof env === "object" && !Array.isArray(env)) ev.env = safeEnv(Object.entries(env));
  return ev.start || ev.publish ? ev : null;
}

export function vercelEvidence(text: string, files: Set<string>): PlatformEvidence | null {
  const cfg = parseJson<{ devCommand?: string; buildCommand?: string; installCommand?: string; outputDirectory?: string; framework?: string | null }>(text);
  if (!cfg) return null;
  const ev = empty("vercel.json");
  if (typeof cfg.installCommand === "string") ev.setup.push(...commands(cfg.installCommand, files, ev, false));
  if (typeof cfg.devCommand === "string" && cfg.devCommand) ev.start = startOf(cfg.devCommand.replace(/\$PORT\b/g, "${PORT:-3000}"), files, ev);
  else if (typeof cfg.outputDirectory === "string" && cfg.outputDirectory && typeof cfg.buildCommand === "string" && cfg.buildCommand && !cfg.framework) {
    ev.setup.push(...commands(cfg.buildCommand, files, ev, false));
    ev.publish = cfg.outputDirectory.replace(/^\.?\/+/, "").replace(/\/+$/, "");
  }
  return ev.start || ev.publish ? ev : null;
}

export function railwayEvidence(text: string, files: Set<string>, source: string): PlatformEvidence | null {
  const cfg = source.endsWith(".toml") ? (parseToml(text) as Record<string, unknown>) : parseJson<Record<string, unknown>>(text);
  if (!cfg) return null;
  const get = (path: string) => path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), cfg);
  const ev = empty(source);
  const build = get("build.buildCommand");
  const start = get("deploy.startCommand");
  if (typeof build === "string") ev.setup = commands(build, files, ev, true);
  if (typeof start === "string") ev.start = startOf(start, files, ev);
  return ev.start ? ev : null;
}

export function nixpacksEvidence(text: string, files: Set<string>): PlatformEvidence | null {
  const t = parseToml(text);
  const ev = empty("nixpacks.toml");
  for (const phase of ["install", "build"]) {
    const cmds = tomlGet(t, `phases.${phase}.cmds`);
    if (Array.isArray(cmds)) for (const c of cmds) if (typeof c === "string") ev.setup.push(...commands(c, files, ev, true));
  }
  const start = tomlGet(t, "start.cmd");
  if (typeof start === "string") ev.start = startOf(start, files, ev);
  return ev.start ? ev : null;
}

export interface AppJsonEvidence {
  env: Record<string, string>;
  /** Variables Heroku would generate a secret for. */
  secrets: string[];
  /** Variables the deployer must provide, with their descriptions. */
  required: { name: string; description: string }[];
  setup: string[];
  addons: string[];
}

/** Heroku's app.json: default env, generated secrets, required keys, add-ons and the postdeploy script. */
export function appJsonEvidence(text: string, files: Set<string>): AppJsonEvidence | null {
  const cfg = parseJson<{
    env?: Record<string, string | { value?: string; required?: boolean; generator?: string; description?: string }>;
    scripts?: { postdeploy?: string };
    addons?: (string | { plan?: string })[];
  }>(text);
  if (!cfg) return null;
  const out: AppJsonEvidence = { env: {}, secrets: [], required: [], setup: [], addons: [] };
  for (const [name, v] of Object.entries(cfg.env ?? {})) {
    if (typeof v === "string") Object.assign(out.env, safeEnv([[name, v]]));
    else if (v && typeof v === "object") {
      if (v.generator === "secret") out.secrets.push(name);
      else if (v.value !== undefined && v.value !== "") Object.assign(out.env, safeEnv([[name, v.value]]));
      else if (v.required !== false) out.required.push({ name, description: (v.description ?? "").slice(0, 160) });
    }
  }
  const ev = empty("app.json");
  out.setup = commands(cfg.scripts?.postdeploy, files, ev, false);
  out.addons = (cfg.addons ?? []).map((a) => (typeof a === "string" ? a : (a.plan ?? ""))).filter(Boolean);
  return out;
}
