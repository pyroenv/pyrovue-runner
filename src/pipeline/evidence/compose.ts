import { type ServiceKind, serviceKind } from "../services";
import { shq } from "./shell";
import { asString, isMap, parseYaml, type YamlMap, type YamlValue } from "./yaml";

/**
 * Reading docker-compose for what it says about running the repo: which service is built from the checkout (the
 * app), what command and ports it uses, its environment, and which databases or caches it expects next to it.
 */

export interface ComposeService {
  name: string;
  image: string | null;
  /** Build context relative to the repo root ("." for the root), when the service is built from the checkout. */
  context: string | null;
  dockerfile: string | null;
  target: string | null;
  command: string | null;
  /** Ports inside the container (the right-hand side of "8080:3000"). */
  ports: number[];
  env: Record<string, string>;
  envFiles: string[];
  dependsOn: string[];
  /** Where the checkout is mounted or copied inside the container, if a volume says so. */
  mount: string | null;
  workingDir: string | null;
}

export interface Companion {
  name: string;
  kind: ServiceKind | null;
  image: string;
  env: Record<string, string>;
}

export interface ComposeInfo {
  services: ComposeService[];
  /** The service built from the repo that a person would open in the browser. */
  app: ComposeService | null;
  /** Other services built from the repo that the app depends on (an API for a frontend), started alongside. */
  siblings: ComposeService[];
  /** Databases, caches and brokers, and anything else that runs from a prebuilt image. */
  companions: Companion[];
}

/** Compose-style interpolation: ${VAR}, ${VAR:-default}, ${VAR-default}, ${VAR:?error}, $VAR and $$. */
export function interpolate(s: string, vars: Record<string, string>): string {
  return s
    .replace(/\$\$/g, "\u0000")
    .replace(/\$\{(\w+)(?:(:?[-?+])([^}]*))?\}/g, (_w, name: string, op: string | undefined, arg: string | undefined) => {
      const v = vars[name];
      if (op === ":-") return v ? v : (arg ?? "");
      if (op === "-") return v !== undefined ? v : (arg ?? "");
      if (op === ":+" || op === "+") return v ? (arg ?? "") : "";
      return v ?? "";
    })
    .replace(/\$(\w+)/g, (_w, name: string) => vars[name] ?? "")
    .replace(/\u0000/g, "$");
}

function str(v: YamlValue | undefined, vars: Record<string, string>): string | null {
  const s = asString(v);
  return s === null ? null : interpolate(s, vars);
}

function commandOf(v: YamlValue | undefined, vars: Record<string, string>): string | null {
  if (Array.isArray(v)) {
    const parts = v.map((p) => str(p, vars)).filter((p): p is string => p !== null);
    if (parts.length === 3 && /^(\/bin\/)?(ba)?sh$/.test(parts[0]!) && parts[1] === "-c") return parts[2]!;
    return parts.length ? parts.map(shq).join(" ") : null;
  }
  const s = str(v, vars);
  if (!s) return null;
  const sh = /^(?:\/bin\/)?(?:ba)?sh\s+-c\s+(["'])(.*)\1$/s.exec(s.trim());
  return sh ? sh[2]! : s.trim();
}

function portsOf(v: YamlValue | undefined, vars: Record<string, string>): number[] {
  const out: number[] = [];
  for (const p of Array.isArray(v) ? v : []) {
    let container: string | null = null;
    if (isMap(p)) container = str(p.target, vars);
    else {
      const s = str(p, vars);
      if (s) container = s.split("/")[0]!.split(":").pop()!;
    }
    const n = Number(container?.split("-")[0]);
    if (Number.isInteger(n) && n > 0 && n < 65536 && !out.includes(n)) out.push(n);
  }
  return out;
}

function envOf(v: YamlValue | undefined, vars: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  if (isMap(v)) {
    for (const [k, val] of Object.entries(v)) {
      const s = val === null ? vars[k] : str(val, vars);
      if (s !== undefined && s !== null) out[k] = s;
    }
  } else if (Array.isArray(v)) {
    for (const item of v) {
      const s = str(item, vars);
      const m = s ? /^([\w.-]+)=(.*)$/.exec(s) : null;
      if (m) out[m[1]!] = m[2]!.replace(/^["']|["']$/g, "");
      else if (s && vars[s] !== undefined) out[s] = vars[s]!;
    }
  }
  return out;
}

function listOf(v: YamlValue | undefined): string[] {
  if (Array.isArray(v)) return v.map((x) => asString(x)).filter((x): x is string => !!x);
  if (isMap(v)) return Object.keys(v);
  const s = asString(v);
  return s ? [s] : [];
}

function relContext(ctx: string): string | null {
  const c = ctx.trim().replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (/^(https?:|git@|github\.com)/.test(c) || c.startsWith("/") || c.startsWith("..")) return null;
  if (c !== "" && !/^[\w./-]+$/.test(c)) return null;
  return c === "" || c === "." ? "." : c;
}

function parseService(name: string, raw: YamlMap, vars: Record<string, string>): ComposeService {
  let context: string | null = null;
  let dockerfile: string | null = null;
  let target: string | null = null;
  if (typeof raw.build === "string") context = relContext(interpolate(raw.build, vars));
  else if (isMap(raw.build)) {
    context = relContext(str(raw.build.context, vars) ?? ".");
    dockerfile = str(raw.build.dockerfile, vars);
    target = str(raw.build.target, vars);
  }
  // `volumes: [".:/app"]` on a stock runtime image is the same as building from the checkout.
  let mount: string | null = null;
  const image = str(raw.image, vars) ?? "";
  const runtimeImage = context !== null || /^(?:library\/)?(node|python|ruby|golang|php|oven\/bun|denoland\/deno|elixir|rust|openjdk|eclipse-temurin|mcr\.microsoft\.com\/devcontainers\/[\w-]+)(:|$)/.test(image);
  for (const vol of runtimeImage && Array.isArray(raw.volumes) ? raw.volumes : []) {
    const s = isMap(vol) ? `${str(vol.source, vars) ?? ""}:${str(vol.target, vars) ?? ""}` : (str(vol, vars) ?? "");
    const m = /^(\.{1,2}(?:\/[\w-]+)*\/?):(\/[^:]+)/.exec(s);
    if (m) {
      const rel = relContext(m[1]!);
      if (rel !== null) {
        mount = m[2]!.replace(/\/$/, "");
        context ??= rel;
        break;
      }
    }
  }
  return {
    name,
    image: str(raw.image, vars),
    context,
    dockerfile,
    target,
    command: commandOf(raw.command, vars),
    ports: [...portsOf(raw.ports, vars), ...portsOf(raw.expose, vars)].filter((p, i, a) => a.indexOf(p) === i),
    env: envOf(raw.environment, vars),
    envFiles: listOf(raw.env_file).map((f) => f.replace(/^\.\//, "")),
    dependsOn: listOf(raw.depends_on),
    mount,
    workingDir: str(raw.working_dir, vars),
  };
}

const WORKER = /\b(celery|sidekiq|worker|beat|rq\s+worker|dramatiq|huey|cron|scheduler|queue:work|resque|delayed_job|good_job|bull|temporal)\b/i;
const APP_NAMES = ["web", "app", "frontend", "client", "ui", "site", "www", "dashboard", "server", "api", "backend"];

/** Compose service hostnames inside URLs and host settings become localhost: everything runs in one box. */
export function localizeEnv(env: Record<string, string>, hosts: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  const names = hosts.map((h) => h.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  // A host, not a URL scheme: "redis://redis:6379" keeps its scheme and loses its host.
  const re = names ? new RegExp(`(^|[/@=,\\s])(${names})(?=:(?!\\/\\/)|[/,\\s?]|$)`, "gi") : null;
  for (const [k, v] of Object.entries(env)) {
    const hostish = /HOST|URL|URI|ADDR|SERVER|ENDPOINT|DSN|BROKER|CONNECTION|NODES?$/i.test(k) || v.includes("://");
    out[k] = re && hostish ? v.replace(re, "$1localhost") : v;
  }
  return out;
}

export function parseCompose(text: string, vars: Record<string, string> = {}): ComposeInfo | null {
  const doc = parseYaml(text);
  if (!isMap(doc)) return null;
  const raw = isMap(doc.services) ? doc.services : null;
  if (!raw) return null;
  const services = Object.entries(raw)
    .filter(([, v]) => isMap(v))
    .map(([name, v]) => parseService(name, v as YamlMap, vars));
  const hostNames = services.map((s) => s.name);
  for (const s of services) s.env = localizeEnv(s.env, hostNames);

  const built = services.filter((s) => s.context !== null && !serviceKind(s.image) && !WORKER.test(`${s.name} ${s.command ?? ""}`));
  const dependedOn = new Set(built.flatMap((s) => s.dependsOn));
  const rank = (s: ComposeService) => {
    const nameIdx = APP_NAMES.indexOf(s.name.toLowerCase());
    return (dependedOn.has(s.name) ? 20 : 0) + (s.ports.length ? 0 : 10) + (nameIdx === -1 ? 9 : nameIdx);
  };
  const app = [...built].sort((a, b) => rank(a) - rank(b))[0] ?? null;

  const siblings: ComposeService[] = [];
  if (app) {
    const queue = [...app.dependsOn];
    while (queue.length) {
      const name = queue.shift()!;
      const s = built.find((b) => b.name === name);
      if (s && s !== app && !siblings.includes(s)) {
        siblings.push(s);
        queue.push(...s.dependsOn);
      }
    }
  }
  const companions: Companion[] = services
    .filter((s) => s.image && (s.context === null || serviceKind(s.image)))
    .map((s) => ({ name: s.name, kind: serviceKind(s.image), image: s.image!, env: s.env }));
  return { services, app, siblings, companions };
}
