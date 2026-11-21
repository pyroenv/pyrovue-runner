import { parseJsonc } from "../plan";
import { SERVICE_PORTS } from "./readme";
import { runtimeOfImage } from "./dockerfile";
import { classifyCommand, isPlaceholder, looksSecret, redact, SECRET_NAME, sanitizeCommand, shq, splitChain, type Tool } from "./shell";

/**
 * Reading .devcontainer/devcontainer.json: the lifecycle commands a contributor's editor runs after creating the
 * container (installs, migrations), the ports it forwards, its environment, and the runtime its image or features
 * pin. It's written for development, so it's close to what Pyrovue wants.
 */

type Lifecycle = string | string[] | Record<string, string | string[]>;

interface DevcontainerJson {
  image?: string;
  build?: { dockerfile?: string; context?: string };
  dockerFile?: string;
  dockerComposeFile?: string | string[];
  service?: string;
  workspaceFolder?: string;
  features?: Record<string, unknown>;
  onCreateCommand?: Lifecycle;
  updateContentCommand?: Lifecycle;
  postCreateCommand?: Lifecycle;
  postStartCommand?: Lifecycle;
  postAttachCommand?: Lifecycle;
  forwardPorts?: (number | string)[];
  appPort?: number | string | (number | string)[];
  containerEnv?: Record<string, string>;
  remoteEnv?: Record<string, string>;
}

export interface DevcontainerEvidence {
  file: string;
  setup: string[];
  start: string | null;
  ports: number[];
  env: Record<string, string>;
  runtimes: { tool: Tool; version: string }[];
  /** The Dockerfile it builds, relative to the repo root. */
  dockerfile: string | null;
  compose: { files: string[]; service: string | null } | null;
  skipped: { command: string; reason: string }[];
}

/** Lifecycle commands come as a string, an exec-form array, or a map of named commands run in parallel. */
function lifecycleCommands(v: Lifecycle | undefined): string[] {
  if (!v) return [];
  if (typeof v === "string") return [v];
  if (Array.isArray(v)) return v.every((p) => typeof p === "string") ? [v.map(shq).join(" ")] : [];
  return Object.values(v).flatMap((c) => lifecycleCommands(c));
}

/** `npm start &` is `npm start`. No whitespace regex: those are quadratic on a long run of spaces. */
function withoutTrailingAmpersand(command: string): string {
  const body = command.endsWith("&") ? command.slice(0, -1) : null;
  return body !== null && body.length > 0 && body.trimEnd() !== body ? body.trimEnd() : command;
}

function relPath(base: string, p: string): string {
  const parts = `${base}/${p}`.split("/");
  const out: string[] = [];
  for (const part of parts) {
    if (part === "" || part === ".") continue;
    if (part === "..") out.pop();
    else out.push(part);
  }
  return out.join("/");
}

const FEATURE_TOOLS: [RegExp, Tool][] = [
  [/\/features\/node(:|$)/, "node"],
  [/\/features\/python(:|$)/, "python"],
  [/\/features\/ruby(:|$)/, "ruby"],
  [/\/features\/go(:|$)/, "go"],
];

export function devcontainerEvidence(text: string, opts: { files: Set<string>; file: string }): DevcontainerEvidence | null {
  const cfg = parseJsonc<DevcontainerJson>(text);
  if (!cfg || typeof cfg !== "object") return null;
  const base = opts.file.split("/").slice(0, -1).join("/");
  const workspace = (cfg.workspaceFolder ?? "").replace(/\/+$/, "");
  const translate = (s: string) => {
    let out = s.replace(/\$\{(containerWorkspaceFolder|localWorkspaceFolder)\}/g, "/workspace").replace(/\/workspaces\/(\$\{localWorkspaceFolderBasename\}|[\w.-]+)/g, "/workspace");
    if (workspace && workspace !== "/workspace" && !workspace.includes("$")) out = out.split(workspace).join("/workspace");
    return out;
  };

  const ev: DevcontainerEvidence = { file: opts.file, setup: [], start: null, ports: [], env: {}, runtimes: [], dockerfile: null, compose: null, skipped: [] };
  const take = (raw: string, allowStart: boolean) => {
    const kept: string[] = [];
    let cd = ".";
    for (const segment of splitChain(translate(raw))) {
      const s = sanitizeCommand(segment, { files: opts.files, dir: cd });
      if (s.skip) ev.skipped.push({ command: redact(segment), reason: s.skip });
      if (s.cd !== undefined) cd = s.cd;
      if (s.env) ev.env[s.env[0]] = s.env[1];
      if (s.version && !ev.runtimes.some((r) => r.tool === s.version!.tool)) ev.runtimes.push(s.version);
      if (!s.command) continue;
      const command = cd === "." ? s.command : `cd /workspace/${cd} && ${s.command}`;
      if (classifyCommand(s.command) === "start") {
        if (allowStart && !ev.start) ev.start = withoutTrailingAmpersand(command);
        continue;
      }
      kept.push(command);
    }
    for (const c of kept) if (!ev.setup.includes(c)) ev.setup.push(c);
  };
  for (const c of [...lifecycleCommands(cfg.onCreateCommand), ...lifecycleCommands(cfg.updateContentCommand), ...lifecycleCommands(cfg.postCreateCommand)]) take(c, false);
  for (const c of [...lifecycleCommands(cfg.postStartCommand), ...lifecycleCommands(cfg.postAttachCommand)]) take(c, true);

  const portList = [...(cfg.forwardPorts ?? []), ...(Array.isArray(cfg.appPort) ? cfg.appPort : cfg.appPort !== undefined ? [cfg.appPort] : [])];
  for (const p of portList) {
    const n = typeof p === "number" ? p : Number(String(p).split(":").pop());
    if (Number.isInteger(n) && n > 0 && n < 65536 && !SERVICE_PORTS.has(n) && !ev.ports.includes(n)) ev.ports.push(n);
  }

  for (const [k, v] of Object.entries({ ...cfg.containerEnv, ...cfg.remoteEnv })) {
    if (typeof v !== "string" || /\$\{(localEnv|containerEnv|env):/.test(v)) continue;
    if (/^(PATH|HOME|USER|SHELL|DEBIAN_FRONTEND)$/.test(k) || (SECRET_NAME.test(k) && !isPlaceholder(v)) || looksSecret(`${k}=${v}`)) continue;
    ev.env[k] = translate(v);
  }

  if (cfg.image) {
    const r = runtimeOfImage(cfg.image);
    if (r) ev.runtimes.push(r);
  }
  for (const [id, options] of Object.entries(cfg.features ?? {})) {
    const tool = FEATURE_TOOLS.find(([re]) => re.test(id))?.[1];
    const version = options && typeof options === "object" ? (options as { version?: unknown }).version : undefined;
    if (tool && typeof version === "string" && /^\d+(\.\d+)*$/.test(version) && !ev.runtimes.some((r) => r.tool === tool)) ev.runtimes.push({ tool, version });
  }

  const dockerfile = cfg.build?.dockerfile ?? cfg.dockerFile;
  if (dockerfile) ev.dockerfile = relPath(base, dockerfile);
  if (cfg.dockerComposeFile) {
    const list = Array.isArray(cfg.dockerComposeFile) ? cfg.dockerComposeFile : [cfg.dockerComposeFile];
    ev.compose = { files: list.filter((f) => typeof f === "string").map((f) => relPath(base, f)), service: cfg.service ?? null };
  }
  return ev;
}
