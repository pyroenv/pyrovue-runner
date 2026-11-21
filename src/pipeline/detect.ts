import type { AppKind } from "../types";
import { isRecord } from "../util/text";
import { buildCandidates, runsBehindFrontend, serviceName, withAlternatives } from "./candidates";
import { gatherEvidence, type RepoEvidence } from "./evidence";
import { scriptOf, shq } from "./evidence/shell";
import { parseToml, tomlGet } from "./evidence/toml";
import { cwdFor, dedupe, installCommand, listNames, parseJson, type Plan, type PlanFacts, type PlanService, type PM, priorFor, relDir, runScript, WORKSPACE, withoutFlaskDebugger, withServices } from "./plan";
import { rankPlans } from "./ranking";
import { nodeMajorFor, pythonFor, pythonVenv } from "./repairs";
import type { Snapshot } from "./snapshot";
import { DOTNET } from "./stacks/dotnet";
import { JAVA } from "./stacks/java";
import type { RootLanguage } from "./stacks/stack";
import { ELECTRON_NOTHING_NOTE, ELECTRON_RUNS_NOTE, electronProject, START_SCRIPTS, TAURI_NOTHING_NOTE, TAURI_RUNS_NOTE, tauriProject } from "./stacks/desktop";

export type { Plan, PlanFacts } from "./plan";
/**
 * detectorTrust(plan, learning?) -> 0..1: the posterior that the detector's primary plan works for this stack (its
 * evidence prior, updated by recorded outcomes for the same signature). A caller with a slower or costlier
 * fallback (such as an AI agent) can let the detector go first when this is high enough.
 */
export { detectorTrust } from "./ranking";

interface PackageJson {
  name?: string;
  version?: string;
  main?: string;
  module?: unknown;
  exports?: unknown;
  bin?: unknown;
  types?: unknown;
  typings?: unknown;
  files?: unknown;
  publishConfig?: unknown;
  private?: boolean;
  packageManager?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  workspaces?: unknown;
  engines?: { node?: string };
}

function has(files: Set<string>, ...names: string[]) {
  return names.some((n) => files.has(n));
}

const PYTHON_MARKERS = ["requirements.txt", "pyproject.toml", "Pipfile", "setup.py", "manage.py", "app.py", "main.py", "uv.lock"];
const BACKEND_DIRS = ["backend", "server", "api", "app", "src", "web"];

/**
 * Reads the repo's evidence (manifests, README, Dockerfile, compose, Procfile, devcontainer, Makefile, hosting
 * configs), builds a complete plan per strategy, and returns the most likely one with the rest as alternatives.
 */
export function detect(snapshot: Snapshot): Plan {
  const ev = gatherEvidence(snapshot);
  const { base, secondary } = detectFramework(snapshot, ev);
  const explicit = fromPyrovueJson(snapshot);
  // With two servers, both run as one plan first ("framework:both"); each on its own stays a fallback.
  const together = secondary && !startsBoth(snapshot, base, secondary) ? secondary : null;
  const candidates = buildCandidates(snapshot, ev, base, explicit, together);
  if (secondary) {
    // Ranked and learned under the primary's signature, but as their own strategy: a FastAPI backend's results
    // mustn't move the stats of the Vite frontend's framework defaults.
    for (const p of buildCandidates(snapshot, ev, secondary, null).filter((p) => p.strategy === "framework")) {
      candidates.push({ ...p, strategy: "framework:secondary", prior: Math.max(0.2, (p.prior ?? 0.5) - 0.2), signature: base.signature });
    }
  }
  if (!candidates.length) return { ...base, strategy: "framework", prior: priorFor(base.confidence) };
  const ranked = rankPlans(candidates);
  const best = withAlternatives(ranked);
  // The manifest's "this is a library" stands only while nothing else in the repository (README, Dockerfile, Procfile,
  // Makefile, a hosting config) gives a start command: a package by its manifest can be a server by everything else.
  const somethingRuns = ranked.some((p) => p.start) || FRONTEND_DIRS.some((d) => hasDevScript(snapshot, d)) || snapshot.files.some((f) => DEPLOYED.test(f));
  return base.nothingToServe && !somethingRuns ? { ...best, nothingToServe: base.nothingToServe } : best;
}

/**
 * Root files that say the repository is deployed or run as a service, whether or not a strategy could read a start
 * command out of them. A Dockerfile is not one: libraries keep those for their tests.
 */
const DEPLOYED = /^((docker-)?compose(\.[\w.-]+)?\.ya?ml|Procfile(\.[\w-]+)?|fly\.toml|render\.ya?ml|vercel\.json|netlify\.toml|railway\.(json|toml)|wrangler\.(toml|jsonc?)|app\.json|nixpacks\.toml)$/;

/** The plan the stack's conventions give, before any other evidence; plus a second stack in another folder, if any. */
export function detectFramework(snapshot: Snapshot, ev: RepoEvidence): { base: Plan; secondary: Plan | null } {
  const files = ev.files;
  // A root-level manifest says what the project is; a JS app in a subfolder only wins when the root has none.
  // A second stack in its own folder (a backend next to a JavaScript app, or a web server's frontend/ dev server)
  // is returned as the secondary, and runs next to the base when both are servers.
  // Rails, Laravel and Django apps keep a package.json for their assets; the server is still Ruby, PHP or Python.
  const rails = files.has("Gemfile") && (files.has("config/application.rb") || files.has("bin/rails"));
  if (files.has("package.json") && (rails || files.has("artisan") || files.has("manage.py"))) {
    const server = rails ? detectRuby(snapshot, files, ev) : files.has("artisan") ? detectPhp(snapshot, files) : detectPython(snapshot, files, ".", ev);
    return { base: withAssets(server, snapshot, files), secondary: null };
  }
  const pyDir = BACKEND_DIRS.find((d) => PYTHON_MARKERS.some((m) => files.has(`${d}/${m}`) && (m !== "app.py" && m !== "main.py" ? true : files.has(`${d}/requirements.txt`))));
  const goDir = BACKEND_DIRS.find((d) => files.has(`${d}/go.mod`));
  const backend = () => (pyDir ? detectPython(snapshot, files, pyDir, ev) : goDir ? detectGo(snapshot, files, ev, goDir) : null);
  const owner = rootOwner(files);
  // The owner's server, with the frontend/ dev server that runs next to it; a library's UI folder is part of the library.
  const withFrontend = (plan: Plan) => {
    const frontDir = runsBehindFrontend(plan) ? FRONTEND_DIRS.find((d) => hasDevScript(snapshot, d)) : undefined;
    return { base: plan, secondary: frontDir ? detectNode(snapshot, files, frontDir, ev) : null };
  };
  if (files.has("package.json")) {
    const node = detectNode(snapshot, files, ".", ev);
    // With nothing of its own to start, a package.json is the tooling of the project that owns the root, unless most of
    // the code is JavaScript (a library that also publishes to Packagist, or keeps a Gemfile for its docs site).
    // An index.html it could serve statically doesn't count as a start: that isn't the package.json's.
    const startsItself = node.start !== null && !node.stack.includes("Static site");
    if (startsItself || !owner || owner.sources < owner.javascript) return { base: node, secondary: backend() };
    const plan = owner.language.detect(snapshot, files, ev);
    // A build script makes it that project's asset pipeline; without one nothing in it needs installing.
    return withFrontend(assetBuilds(snapshot).length ? withAssets(plan, snapshot, files) : plan);
  }
  const nodeDir = findNodeDir(snapshot, files);
  const front = nodeDir === null ? null : detectNode(snapshot, files, nodeDir, ev);
  if (owner) {
    const plan = owner.language.detect(snapshot, files, ev);
    // The owner takes the root from a JavaScript app in a subfolder when it holds at least as much code (not a web app
    // with a small Rust or Go program at its root) and that doesn't give up a dev server Pyrovue can start: either the
    // folder has nothing to start, or the owner's server can run behind it. Python keeps the root either way.
    const ownerTakesRoot = !front || owner.language.keepsRootOverSubfolderApp || (owner.sources >= owner.javascript && (front.start === null || runsBehindFrontend(plan)));
    if (ownerTakesRoot) return withFrontend(plan);
  }
  if (front) return { base: front, secondary: backend() };
  if (pyDir) return { base: detectPython(snapshot, files, pyDir, ev), secondary: null };
  if (has(files, "deno.json", "deno.jsonc")) return { base: detectDeno(snapshot), secondary: null };
  if (files.has("index.html")) return { base: staticSite("."), secondary: null };
  // Nothing at the root says how to run it: a MkDocs config, or a page kept in a docs folder, is what there is to show.
  if (isMkdocsSite(files, ".")) return { base: detectPython(snapshot, files, ".", ev), secondary: null };
  const siteDir = STATIC_DIRS.find((d) => files.has(`${d}/index.html`));
  if (siteDir) return { base: { ...staticSite(siteDir), summary: `Static website in ${siteDir}/.`, confidence: "medium" }, secondary: null };

  return {
    base: {
      stack: [],
      kind: "unknown",
      summary: "Couldn't recognise a standard project layout.",
      setup: [],
      start: null,
      port: null,
      env: {},
      cwd: WORKSPACE,
      previewPath: null,
      confidence: "low",
      signature: "unknown",
    },
    secondary: null,
  };
}

/** In the order that settles a tie. */
const ROOT_LANGUAGES: RootLanguage[] = [
  { marks: (files) => has(files, ...PYTHON_MARKERS), source: /\.py$/, keepsRootOverSubfolderApp: true, detect: (snapshot, files, ev) => detectPython(snapshot, files, ".", ev) },
  { marks: (files) => files.has("go.mod"), source: /\.go$/, detect: (snapshot, files, ev) => detectGo(snapshot, files, ev) },
  { marks: (files) => files.has("Cargo.toml"), source: /\.rs$/, detect: (snapshot, files) => detectRust(snapshot, files) },
  { marks: (files) => files.has("Gemfile") || rootGemspec(files) !== undefined, source: /\.(rb|rake|gemspec)$/, detect: (snapshot, files, ev) => detectRuby(snapshot, files, ev) },
  { marks: (files) => has(files, "composer.json", "index.php"), source: /\.php$/, detect: (snapshot, files) => detectPhp(snapshot, files) },
  JAVA,
  DOTNET,
];

const JS_SOURCE = /\.(?:[cm]?[jt]sx?|vue|svelte|coffee)$/;
/** Folders of code the repository didn't write. */
const VENDORED = /(^|\/)(node_modules|vendor|third_party|bower_components|dist|build)\//;
/** Where a server-side app keeps the scripts it serves: its pages' JavaScript, not what the project is written in. */
const SERVED_ASSETS = /(^|\/)(public|static|assets)\//;

/**
 * The language that owns the root: of those with a manifest there, the one most of the source files are written in
 * (a Rust tool's pyproject.toml, or a gem's requirements.txt for its docs, doesn't make it Python). `sources` and
 * `javascript` count its files and the JavaScript and TypeScript ones, for the caller that has a package.json to weigh.
 * Null when no such language has a manifest at the root.
 */
function rootOwner(files: Set<string>): { language: RootLanguage; sources: number; javascript: number } | null {
  const marked = ROOT_LANGUAGES.filter((l) => l.marks(files));
  if (!marked.length) return null;
  const counts = marked.map(() => 0);
  let javascript = 0;
  for (const f of files) {
    if (VENDORED.test(f)) continue;
    if (JS_SOURCE.test(f)) javascript += SERVED_ASSETS.test(f) ? 0 : 1;
    else for (const [i, l] of marked.entries()) if (l.source.test(f)) counts[i]!++;
  }
  const sources = Math.max(...counts);
  return { language: marked[counts.indexOf(sources)]!, sources, javascript };
}

/** The root package.json's scripts that build assets once and exit. */
function assetBuilds(snapshot: Snapshot): string[] {
  const scripts = parseJson<PackageJson>(snapshot.contents["package.json"])?.scripts ?? {};
  return ["build", "build:css", "build:js"].filter((s) => scripts[s] && !/\bwatch\b/.test(scripts[s]!));
}

/** Installs and builds the JavaScript assets a server-rendered app serves (Vite for Laravel, cssbundling for Rails). */
function withAssets(plan: Plan, snapshot: Snapshot, files: Set<string>): Plan {
  const pkg = parseJson<PackageJson>(snapshot.contents["package.json"]) ?? {};
  const scripts = pkg.scripts ?? {};
  const pm = packageManager(pkg, files, ".");
  const builds = assetBuilds(snapshot).map((s) => `${runScript(pm, s)} || true`);
  // Assets come before migrations and server-side steps that may render templates.
  const idx = plan.setup.findIndex((c) => /\b(migrate|db:prepare|db upgrade|key:generate)\b/.test(c));
  const setup = [...plan.setup];
  setup.splice(idx === -1 ? setup.length : idx, 0, installCommand(pm), ...builds);
  return { ...plan, setup, stack: [...plan.stack, pm], facts: { ...plan.facts, pm, scripts: Object.keys(scripts) } };
}

/** A plain JSON object (not an array or a scalar). */

/**
 * The repo's own config, checked field by field: it is hand-written JSON, and a wrong type here used to crash the
 * setup (or the dashboard, which renders the stored stack) instead of falling back.
 */
function fromPyrovueJson(snapshot: Snapshot): Plan | null {
  const cfg = parseJson<unknown>(snapshot.contents["pyrovue.json"] ?? snapshot.contents["pyroenv.json"]);
  if (!isRecord(cfg)) return null;
  // `"PORT": 3000` is what the author meant as "3000"; setup commands already see it that way through Docker's env.
  const env: Record<string, string> = {};
  if (isRecord(cfg.env)) {
    for (const [k, v] of Object.entries(cfg.env)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") env[k] = String(v);
    }
  }
  // A start of the wrong type still renders as the same text in the start script, so it fails as a launch and the
  // alternatives get their turn; turning it into null would make this a "successful" CLI plan that hides them.
  const start = typeof cfg.start === "string" ? cfg.start : cfg.start ? String(cfg.start) : null;
  const services = start ? pyrovueServices(cfg.services) : [];
  return {
    stack: Array.isArray(cfg.stack) ? cfg.stack.filter((s): s is string => typeof s === "string") : [],
    kind: start ? "web" : "cli",
    summary: "Using the repository's pyrovue.json.",
    setup: Array.isArray(cfg.setup) ? cfg.setup.filter((s): s is string => typeof s === "string") : [],
    start: start && services.length ? withServices(start, services) : start,
    ...(services.length ? { services } : {}),
    port: typeof cfg.port === "number" ? cfg.port : null,
    env,
    cwd: typeof cfg.cwd === "string" && cfg.cwd ? `${WORKSPACE}/${cfg.cwd.replace(/^\/+/, "")}` : WORKSPACE,
    // Appended to the app's origin for the probe and the preview link, so it must stay on that origin.
    previewPath: typeof cfg.previewPath === "string" && /^(\/(?!\/)|[?#])/.test(cfg.previewPath) ? cfg.previewPath : null,
    confidence: "high",
  };
}

/**
 * pyrovue.json's `services: [{ cwd, start, port }]`: the repo's own background programs, such as a backend for the
 * frontend that `start` runs. An entry without a start, or with a folder that isn't a plain relative path (it lands
 * unquoted in the start script), is left out.
 */
function pyrovueServices(raw: unknown): PlanService[] {
  if (!Array.isArray(raw)) return [];
  const out: PlanService[] = [];
  for (const s of raw.slice(0, 5)) {
    if (!isRecord(s) || typeof s.start !== "string" || !s.start.trim()) continue;
    const dir = typeof s.cwd === "string" ? s.cwd.trim().replace(/^\.?\/+/, "").replace(/\/+$/, "") : "";
    if (!/^[\w./-]*$/.test(dir) || dir.split("/").includes("..")) continue;
    const cwd = cwdFor(dir);
    const command = s.start.trim();
    const port = typeof s.port === "number" && Number.isInteger(s.port) && s.port > 0 && s.port < 65536 ? s.port : null;
    out.push({ name: serviceName(command, cwd), cwd, command, port });
  }
  return out;
}

// ---------------------------------------------------------------- Node

const FRONTEND_DIRS = ["frontend", "web", "client", "app", "site", "www", "ui", "apps/web", "packages/web", "website"];

function findNodeDir(snapshot: Snapshot, files: Set<string>): string | null {
  if (files.has("package.json")) return ".";
  for (const dir of FRONTEND_DIRS) if (snapshot.contents[`${dir}/package.json`]) return dir;
  return null;
}

/**
 * The JavaScript side's own script already starts more than its dev server (concurrently, turbo, the other folder's
 * server): running the other folder next to it would start that part twice.
 */
function startsBoth(snapshot: Snapshot, a: Plan, b: Plan): boolean {
  const [node, other] = a.stack[0] === "Node.js" ? [a, b] : [b, a];
  const dir = relDir(node.cwd);
  const scripts = parseJson<PackageJson>(snapshot.contents[dir === "." ? "package.json" : `${dir}/package.json`])?.scripts ?? {};
  const body = scripts[scriptOf(node.start ?? "") ?? ""] ?? "";
  const folder = relDir(other.cwd);
  const mentions = folder !== "." && new RegExp(`\\b${folder.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(body);
  return mentions || /\b(concurrently|npm-run-all|run-p|turbo|nx|lerna|foreman|honcho|overmind|uvicorn|gunicorn|flask|manage\.py|go run)\b|--parallel/.test(body);
}

/** The folder's package.json has a dev server to start. */
function hasDevScript(snapshot: Snapshot, dir: string): boolean {
  const scripts = parseJson<PackageJson>(snapshot.contents[`${dir}/package.json`])?.scripts;
  return Boolean(scripts?.dev || scripts?.start);
}

function packageManager(pkg: PackageJson, files: Set<string>, dir: string): PM {
  const pmField = typeof pkg.packageManager === "string" ? pkg.packageManager.split("@")[0] : undefined;
  if (pmField === "pnpm" || pmField === "yarn" || pmField === "bun" || pmField === "npm") return pmField;
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  if (files.has(p("pnpm-lock.yaml")) || files.has("pnpm-lock.yaml")) return "pnpm";
  if (files.has(p("bun.lockb")) || files.has(p("bun.lock"))) return "bun";
  if (files.has(p("yarn.lock")) || files.has("yarn.lock")) return "yarn";
  return "npm";
}

interface Framework {
  name: string;
  dep: string;
  port: number;
  env?: Record<string, string>;
}

const FRAMEWORKS: Framework[] = [
  { name: "Next.js", dep: "next", port: 3000 },
  { name: "Nuxt", dep: "nuxt", port: 3000 },
  { name: "SvelteKit", dep: "@sveltejs/kit", port: 5173 },
  { name: "Astro", dep: "astro", port: 4321 },
  { name: "Remix", dep: "@remix-run/dev", port: 5173 },
  { name: "Gatsby", dep: "gatsby", port: 8000 },
  { name: "Docusaurus", dep: "@docusaurus/core", port: 3000 },
  { name: "VitePress", dep: "vitepress", port: 5173 },
  { name: "Angular", dep: "@angular/core", port: 4200, env: { NG_CLI_ANALYTICS: "false" } },
  { name: "Create React App", dep: "react-scripts", port: 3000 },
  { name: "Vue CLI", dep: "@vue/cli-service", port: 8080 },
  { name: "Storybook", dep: "storybook", port: 6006 },
  { name: "Vite", dep: "vite", port: 5173 },
  { name: "Parcel", dep: "parcel", port: 1234 },
  { name: "Eleventy", dep: "@11ty/eleventy", port: 8080 },
  { name: "NestJS", dep: "@nestjs/core", port: 3000 },
  { name: "Hono", dep: "hono", port: 3000 },
  { name: "Fastify", dep: "fastify", port: 3000 },
  { name: "Express", dep: "express", port: 3000 },
  { name: "Koa", dep: "koa", port: 3000 },
];

const UI_LIBS: [string, string][] = [
  ["react", "React"],
  ["vue", "Vue"],
  ["svelte", "Svelte"],
  ["solid-js", "Solid"],
  ["preact", "Preact"],
  ["tailwindcss", "Tailwind CSS"],
  ["typescript", "TypeScript"],
  ["prisma", "Prisma"],
  ["@prisma/client", "Prisma"],
  ["electron", "Electron"],
];

const slug = (s: string) => s.toLowerCase().replace(/\.js$/, "").replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

function detectNode(snapshot: Snapshot, files: Set<string>, dir: string, ev: RepoEvidence): Plan {
  const pkgPath = dir === "." ? "package.json" : `${dir}/package.json`;
  const pkg = parseJson<PackageJson>(snapshot.contents[pkgPath]) ?? {};
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const scripts = pkg.scripts ?? {};
  // Monorepos often install from the root even when the app lives in a subfolder.
  const rootPkg = dir === "." ? pkg : parseJson<PackageJson>(snapshot.contents["package.json"]);
  const pm = packageManager(pkg, files, dir);
  const cwd = cwdFor(dir);

  const framework = FRAMEWORKS.find((f) => f.dep in deps);
  const stack = ["Node.js"];
  if (framework) stack.push(framework.name);
  for (const [dep, label] of UI_LIBS) if (dep in deps && !stack.includes(label)) stack.push(label);
  // A desktop app with a web frontend (Tauri, Electron): the frontend is what runs here, never the native shell.
  const tauri = tauriProject(snapshot, files, dir, deps, scripts, pm);
  const electron = !tauri && "electron" in deps ? electronProject(scripts, pm) : null;
  const shell = tauri
    ? { name: "Tauri", start: tauri.start, port: tauri.port, runs: TAURI_RUNS_NOTE, nothing: TAURI_NOTHING_NOTE }
    : electron
      ? { name: "Electron", start: electron.start, port: null, runs: ELECTRON_RUNS_NOTE, nothing: ELECTRON_NOTHING_NOTE }
      : null;
  if (tauri) stack.push("Tauri");
  stack.push(pm);

  const setup: string[] = [];
  const nodeVersion = ev.versions.node;
  const engine = !nodeVersion && typeof pkg.engines?.node === "string" && pkg.engines.node ? nodeMajorFor(pkg.engines.node) : null;
  if (nodeVersion && !/^v?22(\.|$)/.test(nodeVersion) && /^v?\d+/.test(nodeVersion)) {
    const major = nodeVersion.replace(/^v/, "").split(".")[0];
    setup.push(`mise use -g node@${major}`);
    stack.push(`Node ${major}`);
  } else if (engine) {
    setup.push(`mise use -g node@${engine}`);
    stack.push(`Node ${engine}`);
  }
  setup.push(installCommand(pm));
  const prisma = Boolean(deps["prisma"] || deps["@prisma/client"]);
  if (prisma) setup.push(`npx prisma generate || true`);
  const env: Record<string, string> = { ...framework?.env };

  if (framework?.dep === "react-scripts") {
    const major = Number((deps["react-scripts"] ?? "").replace(/[^\d.]/g, "").split(".")[0]);
    if (major && major < 5) env.NODE_OPTIONS = "--openssl-legacy-provider";
  }

  const startScript = START_SCRIPTS.find((s) => scripts[s]);
  let start: string | null = shell ? shell.start : startScript ? runScript(pm, startScript) : null;
  let kind: AppKind = start ? "web" : "cli";
  const port = shell?.port ?? framework?.port ?? (start ? 3000 : null);

  if (!start && !shell && pkg.main && /\.(c|m)?js$/.test(pkg.main) && (deps["express"] || deps["fastify"] || deps["koa"])) {
    start = `node ${pkg.main}`;
    kind = "web";
  }
  const facts: PlanFacts = { pm, scripts: Object.keys(scripts), ...(tauri ? { tauri } : {}), ...(prisma ? { migrate: "npx prisma migrate deploy || npx prisma db push --skip-generate" } : {}) };
  const signature = `node:${framework ? slug(framework.name) : "none"}:${pm}`;
  if (!start && files.has(dir === "." ? "index.html" : `${dir}/index.html`)) {
    return { ...staticSite(dir), stack: [...stack, "Static site"], setup, facts, signature, ...(shell ? { notes: [shell.runs] } : {}) };
  }
  if (!shell && start && scripts[startScript!] && /\b(build|tsc|test|jest|lint)\b/.test(scripts[startScript!]!) && !/\b(dev|serve|start|watch)\b/.test(scripts[startScript!]!)) {
    kind = "cli";
  }

  if (port && kind === "web") env.PORT = String(port);
  if (rootPkg && dir !== "." && (rootPkg.workspaces || files.has("pnpm-workspace.yaml"))) {
    setup.unshift(`cd ${WORKSPACE} && ${installCommand(pm)}`);
  }

  // A published package: a name, a version, and a field only publishing needs (what it exports, what it installs as
  // a command, which files go in the tarball). `main` alone is what `npm init` writes for anything. And nothing that
  // may be a server: no script named like one, no framework, no Electron, and not a private root, which may be an
  // app run some other way.
  const published = [pkg.exports, pkg.bin, pkg.module, pkg.types, pkg.typings, pkg.files, pkg.publishConfig].some((v) => v !== undefined);
  const mayServe = Object.keys(scripts).some((name) => /^(dev|start|serve|server|develop|preview|watch)\b/.test(name));
  const library = !start && !shell && Boolean(pkg.name) && Boolean(pkg.version) && !pkg.private && published && !mayServe && !framework && !("electron" in deps);
  const label = framework ? `${framework.name} app` : kind === "web" ? "Node.js app" : "Node.js package";
  const where = dir !== "." ? ` in ${dir}/` : "";
  const summary = !shell ? `${label} using ${pm}${where}.` : shell.start ? `${shell.name} desktop app: its ${framework?.name ?? "web"} page using ${pm}${where}.` : `${shell.name} desktop app${where}.`;
  return {
    stack,
    kind: shell && !start ? "unknown" : kind,
    summary,
    setup: dedupe(setup),
    start,
    port: kind === "web" ? port : null,
    env,
    cwd,
    previewPath: null,
    confidence: framework && start ? "high" : start ? "medium" : "low",
    ...(shell ? { notes: [shell.start ? shell.runs : shell.nothing] } : {}),
    facts,
    // Nothing to start is its own kind of result: what is learned from it mustn't count for the projects that do start.
    signature: library ? `node:library:${pm}` : shell && !start ? `node:${slug(shell.name)}:${pm}` : signature,
    ...(library ? { nothingToServe: "package.json publishes a package and no script starts anything" } : {}),
  };
}

// ---------------------------------------------------------------- Python

/**
 * Finds the module that creates the app object (a file, or a package whose __init__.py does), returning
 * { file, module } where module is importable ("main", "app.main", or a package name like "app"), relative to dir.
 */
function findPythonApp(snapshot: Snapshot, dir: string, needle: RegExp): { file: string; module: string } | null {
  const prefix = dir === "." ? "" : `${dir}/`;
  const entries = Object.entries(snapshot.contents)
    .filter(([f]) => f.startsWith(prefix) && f.endsWith(".py"))
    .map(([f, content]) => [f.slice(prefix.length), content] as const)
    .filter(([f]) => f.split("/").length <= 2);
  // Prefer conventional names, then anything else that matches.
  const rank = (f: string) => {
    const base = f.split("/").pop()!;
    const i = ["app.py", "main.py", "server.py", "streamlit_app.py", "api.py", "asgi.py", "wsgi.py", "run.py", "__init__.py"].indexOf(base);
    return (f.includes("/") ? 10 : 0) + (i === -1 ? 9 : i);
  };
  for (const [file, content] of entries.sort(([a], [b]) => rank(a) - rank(b))) {
    if (!needle.test(content)) continue;
    const module = file.replace(/\/__init__\.py$/, "").replace(/\.py$/, "").replace(/\//g, ".");
    return { file, module };
  }
  return null;
}

/**
 * The app FLASK_APP names in the folder's .flaskenv, the file `flask` reads it from itself (Miguel Grinberg's microblog
 * keeps `FLASK_APP=microblog.py` there, a module that only calls the app factory), as `--app` takes it: `microblog`,
 * `pkg.wsgi:app`. Null when there is none, or when it doesn't name a module the repo has.
 */
function flaskAppFromEnv(snapshot: Snapshot, files: Set<string>, dir: string): string | null {
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const value = /^[ \t]*(?:export[ \t]+)?FLASK_APP[ \t]*=[ \t]*["']?([^"'\s#]+)["']?/m.exec(snapshot.contents[p(".flaskenv")] ?? "")?.[1];
  // A module or a file, then perhaps `:app` or `:create_app()`; arguments to the factory would need quoting.
  const m = value ? /^(?:\.\/)?([\w.\/-]+?)(?:\.py)?(:\w+(?:\(\))?)?$/.exec(value) : null;
  if (!m) return null;
  const path = m[1]!.includes("/") ? m[1]! : m[1]!.replace(/\./g, "/");
  if (!files.has(p(`${path}.py`)) && !files.has(p(`${path}/__init__.py`))) return null;
  const app = `${m[1]}${m[2] ?? ""}`;
  return app.includes("(") ? shq(app) : app;
}

/**
 * The folder keeps Flask-Migrate's migrations (the migrations/ folder `flask db init` writes: alembic.ini and env.py)
 * and uses Flask-Migrate, so `flask db upgrade` makes its tables. An app that calls `db.create_all()` has no such folder.
 */
function usesFlaskMigrate(snapshot: Snapshot, files: Set<string>, dir: string, requirements: string): boolean {
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  if (!has(files, p("migrations/env.py"), p("migrations/alembic.ini"))) return false;
  if (/\bflask[-_]migrate\b/.test(requirements)) return true;
  const prefix = dir === "." ? "" : `${dir}/`;
  return Object.entries(snapshot.contents).some(([f, text]) => f.startsWith(prefix) && f.endsWith(".py") && /^[ \t]*(from|import)[ \t]+flask_migrate\b/m.test(text));
}

/** Top-level modules and packages in the repo, which a missing-import repair must never fetch from PyPI. */
function localPythonModules(files: Set<string>, dir: string): string[] {
  const prefix = dir === "." ? "" : `${dir}/`;
  const out = new Set<string>();
  for (const f of files) {
    if (!f.startsWith(prefix)) continue;
    const rel = f.slice(prefix.length);
    const m = /^(?:src\/)?([A-Za-z_]\w*)\/__init__\.py$/.exec(rel) ?? /^([A-Za-z_]\w*)\.py$/.exec(rel);
    if (m) out.add(m[1]!);
  }
  return [...out].slice(0, 200);
}

function requiresPython(snapshot: Snapshot, dir: string): string | null {
  const py = parseToml(snapshot.contents[dir === "." ? "pyproject.toml" : `${dir}/pyproject.toml`]);
  const v = tomlGet(py, "project.requires-python") ?? tomlGet(py, "tool.poetry.dependencies.python");
  return typeof v === "string" ? v : null;
}

/**
 * Markdown, mkdocs.yml and perhaps a requirements.txt for the theme: the site is the project. Not a package that
 * documents itself with MkDocs (it has a pyproject.toml or setup.py), and not Python code with a docs site beside it
 * (more Python files than Markdown ones).
 */
function isMkdocsSite(files: Set<string>, dir: string): boolean {
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  if (!has(files, p("mkdocs.yml"), p("mkdocs.yaml")) || has(files, p("pyproject.toml"), p("setup.py"))) return false;
  let markdown = 0;
  let python = 0;
  for (const f of files) {
    if (dir !== "." && !f.startsWith(`${dir}/`)) continue;
    if (/\.md$/i.test(f)) markdown++;
    else if (f.endsWith(".py")) python++;
  }
  return markdown > python;
}

/** Packages that serve HTTP or a UI: a project that depends on one may be an app, however its manifest is written. */
const PYTHON_SERVERS = /\b(fastapi|uvicorn|flask|django|aiohttp|starlette|tornado|sanic|gradio|streamlit|gunicorn|hypercorn|quart|litestar|bottle|falcon|daphne|chainlit|nicegui|dash|bokeh|panel|pyramid|cherrypy|reflex|waitress|twisted)\b/g;
/** Source that builds a web app object. */
const PYTHON_APP_OBJECT = /Flask\(\s*__name__|def create_app\(|=\s*FastAPI\(|Starlette\(|web\.Application\(|import streamlit|from streamlit|import gradio|from gradio/;

function detectPython(snapshot: Snapshot, files: Set<string>, dir: string, ev: RepoEvidence): Plan {
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const req = Object.entries(snapshot.contents)
    .filter(([k]) => {
      const rel = dir === "." ? k : k.startsWith(`${dir}/`) ? k.slice(dir.length + 1) : null;
      return rel !== null && (/^requirements[\w.-]*\.txt$/.test(rel) || rel === "pyproject.toml" || rel === "Pipfile" || rel === "setup.py" || rel === "setup.cfg");
    })
    .map(([, v]) => v)
    .join("\n")
    .toLowerCase();
  const setup: string[] = [];
  const stack = ["Python"];

  // Version files are applied to every plan; requires-python only matters when nothing pins a version.
  const requires = !ev.versions.python ? requiresPython(snapshot, dir) : null;
  const wanted = requires ? pythonFor(requires) : null;
  if (wanted) setup.push(pythonVenv(wanted));

  let installer = "none";
  if (files.has(p("uv.lock"))) {
    setup.push("UV_PROJECT_ENVIRONMENT=/opt/venv uv sync");
    stack.push("uv");
    installer = "uv";
  } else if (files.has(p("requirements.txt"))) {
    setup.push("uv pip install -r requirements.txt");
    installer = "requirements";
  } else if (files.has(p("Pipfile"))) {
    setup.push("pip install pipenv && pipenv install --system --skip-lock");
    installer = "pipenv";
  } else if (files.has(p("pyproject.toml")) || files.has(p("setup.py"))) {
    setup.push("uv pip install -e . || pip install -e .");
    installer = files.has(p("poetry.lock")) ? "poetry" : "pyproject";
  }
  if (files.has(p("requirements-dev.txt")) && !files.has(p("uv.lock"))) setup.push("uv pip install -r requirements-dev.txt || true");

  const facts: PlanFacts = { localModules: localPythonModules(files, dir) };
  const where = dir === "." ? "" : ` in ${dir}/`;
  const base = { cwd: cwdFor(dir), previewPath: null as string | null, env: {} as Record<string, string>, facts };
  const sig = (framework: string) => `python:${framework}:${installer}`;

  if (files.has(p("manage.py"))) {
    stack.push("Django");
    const migrate = "python manage.py migrate --noinput";
    return {
      ...base,
      stack,
      kind: "web",
      summary: `Django project${where}.`,
      setup: [...setup, migrate],
      start: "python manage.py runserver 0.0.0.0:8000",
      port: 8000,
      confidence: "high",
      facts: { ...facts, migrate },
      signature: sig("django"),
    };
  }
  const streamlit = req.includes("streamlit") ? findPythonApp(snapshot, dir, /import streamlit|from streamlit/) : null;
  if (streamlit) {
    const file = streamlit.file;
    stack.push("Streamlit");
    return {
      ...base,
      stack,
      kind: "web",
      summary: `Streamlit app${where}.`,
      setup,
      start: `streamlit run ${file} --server.port 8501 --server.address 0.0.0.0 --server.headless true --server.enableCORS false --server.enableXsrfProtection false`,
      port: 8501,
      confidence: "high",
      signature: sig("streamlit"),
    };
  }
  const gradio = req.includes("gradio") ? findPythonApp(snapshot, dir, /import gradio|from gradio/) : null;
  if (gradio) {
    const file = gradio.file;
    stack.push("Gradio");
    return {
      ...base,
      stack,
      kind: "web",
      summary: `Gradio app${where}.`,
      setup,
      start: `python ${file}`,
      port: 7860,
      env: { GRADIO_SERVER_NAME: "0.0.0.0", GRADIO_SERVER_PORT: "7860" },
      confidence: "medium",
      signature: sig("gradio"),
    };
  }
  const fastapi = req.includes("fastapi") ? findPythonApp(snapshot, dir, /=\s*FastAPI\(/) : null;
  if (fastapi) {
    const { file, module } = fastapi;
    const appVar = /(\w+)\s*=\s*FastAPI\(/.exec(snapshot.contents[p(file)] ?? "")?.[1] ?? "app";
    stack.push("FastAPI");
    return {
      ...base,
      stack,
      kind: "web",
      summary: `FastAPI service${where}.`,
      setup: [...setup, "pip show uvicorn >/dev/null 2>&1 || uv pip install 'uvicorn[standard]'"],
      start: `uvicorn ${module}:${appVar} --host 0.0.0.0 --port 8000 --reload`,
      port: 8000,
      previewPath: "/docs",
      confidence: "medium",
      signature: sig("fastapi"),
    };
  }
  const flask = req.includes("flask") ? (flaskAppFromEnv(snapshot, files, dir) ?? findPythonApp(snapshot, dir, /Flask\(\s*__name__|def create_app\(/)?.module ?? null) : null;
  if (flask) {
    stack.push("Flask");
    // Flask-Migrate's tables only exist once its migrations have run: `flask run` never creates them.
    const migrate = usesFlaskMigrate(snapshot, files, dir, req) ? `flask --app ${flask} db upgrade` : null;
    return {
      ...base,
      stack,
      kind: "web",
      summary: `Flask app${where}.`,
      setup: migrate ? [...setup, migrate] : setup,
      // No debug mode: previews are shared, and its debugger serves a crashing page's source with a Python console.
      // --reload still restarts the server when a file is edited.
      start: withoutFlaskDebugger(`flask --app ${flask} run --host 0.0.0.0 --port 5000 --reload`),
      port: 5000,
      confidence: "medium",
      ...(migrate ? { facts: { ...facts, migrate } } : {}),
      signature: sig("flask"),
    };
  }
  const entry = ["app.py", "main.py", "server.py"].find((f) => files.has(p(f)));
  if (!entry && isMkdocsSite(files, dir)) {
    stack.push("MkDocs");
    return {
      ...base,
      stack,
      kind: "web",
      summary: `MkDocs documentation site${where}.`,
      setup: [...setup, "pip show mkdocs >/dev/null 2>&1 || uv pip install mkdocs mkdocs-material"],
      start: "mkdocs serve --dev-addr 0.0.0.0:8000",
      port: 8000,
      // The config may name plugins nothing here installs.
      confidence: "low",
      signature: sig("mkdocs"),
    };
  }
  // A package by its build manifest: pyproject.toml names a build backend, or there is a setup.py. A requirements.txt
  // alone, or a pyproject.toml that only names a project or configures tools, says nothing about what the code is.
  const toml = parseToml(snapshot.contents[p("pyproject.toml")]);
  const builds = ["build-system.build-backend", "build-system.requires"].some((key) => tomlGet(toml, key) !== undefined);
  const manifest = builds ? "pyproject.toml" : files.has(p("setup.py")) ? "setup.py" : null;
  // A package that depends on a web server, or whose source builds an app object, may be a server started by a console
  // script the detector doesn't know: that is "couldn't work out how to start it", not a library. A server's own
  // repository names itself, not a dependency.
  const ownName = String(tomlGet(toml, "project.name") ?? tomlGet(toml, "tool.poetry.name") ?? "").toLowerCase();
  const servers = (req.match(PYTHON_SERVERS) ?? []).filter((name) => name !== ownName);
  const library = !entry && manifest !== null && servers.length === 0 && findPythonApp(snapshot, dir, PYTHON_APP_OBJECT) === null;
  return {
    ...base,
    stack,
    kind: entry ? "unknown" : "cli",
    summary: entry ? `Python project with ${entry}${where}.` : "Python package.",
    setup,
    start: entry ? `python ${entry}` : null,
    port: entry ? 8000 : null,
    env: entry ? { PORT: "8000" } : {},
    confidence: "low",
    signature: sig(library ? "library" : "none"),
    ...(library ? { nothingToServe: `${manifest} builds a package, and nothing in it serves the web` } : {}),
  };
}

// ---------------------------------------------------------------- Others

/** Folders whose main.go is an example or a tool of the module, not the module's program. */
const GO_SIDE_FOLDERS = /(^|\/)(_?examples?|tutorials?|testdata|tests?|docs?|scripts|tools|hack|\.github)\//;

function detectGo(snapshot: Snapshot, files: Set<string>, ev: RepoEvidence, dir = "."): Plan {
  const p = (name: string) => (dir === "." ? name : `${dir}/${name}`);
  const version = /^go\s+(\d+\.\d+(?:\.\d+)?)/m.exec(snapshot.contents[p("go.mod")] ?? "")?.[1]?.replace(/^(\d+\.\d+)\.0$/, "$1") ?? ev.versions.go ?? "latest";
  const inModule = [...files].map((f) => (dir === "." ? f : f.startsWith(`${dir}/`) ? f.slice(dir.length + 1) : "")).filter(Boolean);
  const cmdMain = inModule.find((f) => /^cmd\/[\w-]+\/main\.go$/.test(f));
  // The package the root's source files declare, where the snapshot read them. A file with a build constraint
  // (`//go:build ignore` on a generator, `//go:build mage` on a magefile) can be `package main` beside a library, so
  // only unconstrained files count.
  const rootPackages = inModule
    .filter((f) => /^[^/]+\.go$/.test(f) && !f.endsWith("_test.go"))
    .map((f) => snapshot.contents[p(f)])
    .filter((text): text is string => text !== undefined && !/^\/\/\s*(go:build|\+build)\b/m.test(text))
    .map((text) => /^package\s+(\w+)/m.exec(text)?.[1])
    .filter((name): name is string => name !== undefined);
  // A program has a main package: at the module's root, in cmd/<name>/, or in cmd/.
  const mainAtRoot = files.has(p("main.go")) || rootPackages.includes("main");
  const target = mainAtRoot ? "." : cmdMain ? `./${cmdMain.replace(/\/main\.go$/, "")}` : files.has(p("cmd/main.go")) ? "./cmd" : null;
  // A library, positively: the root package has a name of its own, nothing lives under cmd/, and no main.go sits
  // anywhere but among examples and tools. With nothing to start and none of that, the detector says nothing.
  const programElsewhere = inModule.some((f) => f.startsWith("cmd/") || (/(^|\/)main\.go$/.test(f) && !GO_SIDE_FOLDERS.test(f)));
  const library = !target && rootPackages.length > 0 && !programElsewhere ? rootPackages[0] : undefined;
  return {
    stack: ["Go"],
    kind: target ? "unknown" : "cli",
    summary: dir === "." ? "Go module." : `Go module in ${dir}/.`,
    setup: [`mise use -g go@${version}`, "go mod download"],
    start: target ? `go run ${target}` : null,
    port: target ? 8080 : null,
    env: target ? { PORT: "8080" } : {},
    cwd: cwdFor(dir),
    previewPath: null,
    confidence: target ? "medium" : "low",
    signature: `go:${library ? "library" : "none"}:gomod`,
    ...(library ? { nothingToServe: `its root package is \`${library}\`, not \`main\`, and it has no cmd/ folder` } : {}),
  };
}

/** One path segment against a pattern whose `*` matches any run of characters; linear, with no backtracking blow-up. */
function wildcardSegment(pattern: string, text: string): boolean {
  let p = 0, t = 0, star = -1, mark = 0;
  while (t < text.length) {
    if (p < pattern.length && pattern[p] === "*") { star = p++; mark = t; }
    else if (p < pattern.length && pattern[p] === text[t]) { p++; t++; }
    else if (star >= 0) { p = star + 1; t = ++mark; }
    else return false;
  }
  while (pattern[p] === "*") p++;
  return p === pattern.length;
}

/** A Cargo member pattern against a folder, segment by segment (a `*` never crosses a `/`). */
function matchesMember(pattern: string[], dir: string[]): boolean {
  return pattern.length === dir.length && pattern.every((seg, i) => wildcardSegment(seg, dir[i]!));
}

/**
 * The members of a Cargo workspace that build a program (a `<member>/src/main.rs`), in the order the root Cargo.toml
 * lists them, with glob members such as `crates/*` matched against the file list; null when the root isn't a
 * workspace or its member list can't be read.
 */
function cargoPrograms(text: string | undefined, files: Set<string>): string[] | null {
  const members = tomlGet(parseToml(text), "workspace.members");
  if (!Array.isArray(members)) return null;
  const patterns = members
    .filter((m): m is string => typeof m === "string" && m.length <= 200)
    .map((m) => m.replace(/^\.\/+/, "").replace(/\/+$/, ""))
    .filter((m) => m && m !== ".")
    .slice(0, 100);
  if (!patterns.length) return null;
  const dirs = [...files].filter((f) => f.endsWith("/src/main.rs")).map((f) => f.slice(0, -"/src/main.rs".length));
  const out: string[] = [];
  for (const m of patterns) {
    const parts = m.split("/");
    for (const d of dirs) if (matchesMember(parts, d.split("/")) && !out.includes(d)) out.push(d);
  }
  return out;
}

function detectRust(snapshot: Snapshot, files: Set<string>): Plan {
  const isBin = /\[\[bin\]\]/.test(snapshot.contents["Cargo.toml"] ?? "") || "src/main.rs" in snapshot.contents;
  // A workspace with no program at its root: run its one program, or, when it has several (daemons, tools), only fetch
  // the dependencies and say so, rather than compiling all of them on a shared server. Members are named by their
  // folder in sentences but run by their manifest: cargo's -p wants the package name, which needn't match the folder.
  const dirs = (isBin ? null : cargoPrograms(snapshot.contents["Cargo.toml"], files)) ?? [];
  const names = dirs.map((d) => d.split("/").pop()!);
  if (names.length === 1) {
    return {
      stack: ["Rust"],
      kind: "unknown",
      summary: `Rust workspace; runs the ${names[0]} binary.`,
      setup: ["mise use -g rust@stable", "cargo build"],
      start: `cargo run --manifest-path ${dirs[0]}/Cargo.toml`,
      port: 8080,
      env: { PORT: "8080" },
      cwd: WORKSPACE,
      previewPath: null,
      confidence: "low",
      signature: "rust:none:cargo",
    };
  }
  if (names.length > 1) {
    const n = names.length;
    const listed = listNames(names);
    return {
      stack: ["Rust"],
      kind: "cli",
      summary: `Rust workspace with ${n} programs (${listed}) and no web server.`,
      setup: ["mise use -g rust@stable", "cargo fetch"],
      start: null,
      port: null,
      env: {},
      cwd: WORKSPACE,
      previewPath: null,
      confidence: "low",
      notes: [
        `This is a Rust workspace with ${n} programs and no web server, so there is nothing to preview. Dependencies are downloaded; build one with \`cargo build --manifest-path ${dirs[0]}/Cargo.toml\` in the terminal.`,
      ],
      signature: "rust:workspace:cargo",
    };
  }
  // One crate with a library target and no binary of any kind; a workspace may hold programs the detector can't see.
  const library = !isBin && files.has("src/lib.rs") && ![...files].some((f) => f.startsWith("src/bin/")) && !/^\[workspace\]/m.test(snapshot.contents["Cargo.toml"] ?? "");
  return {
    stack: ["Rust"],
    kind: isBin ? "unknown" : "cli",
    summary: "Rust crate.",
    setup: ["mise use -g rust@stable", "cargo build"],
    start: isBin ? "cargo run" : null,
    port: isBin ? 8080 : null,
    env: { PORT: "8080" },
    cwd: WORKSPACE,
    previewPath: null,
    confidence: "low",
    signature: `rust:${library ? "library" : "none"}:cargo`,
    ...(library ? { nothingToServe: "Cargo.toml with a library target and no binary" } : {}),
  };
}

/** A gem's specification at the root, which declares a Ruby project even without a Gemfile. */
function rootGemspec(files: Set<string>): string | undefined {
  return [...files].filter((f) => /^[^/]+\.gemspec$/.test(f)).sort()[0];
}

function detectRuby(snapshot: Snapshot, files: Set<string>, ev: RepoEvidence): Plan {
  const rails = files.has("config/application.rb") || files.has("bin/rails");
  // Bundler needs a Gemfile; a gem with only its gemspec is built and installed, which brings its dependencies.
  const gemspec = files.has("Gemfile") ? undefined : rootGemspec(files);
  const install = gemspec ? `gem build ${shq(gemspec)} -o /tmp/pyrovue-gem.gem && gem install /tmp/pyrovue-gem.gem` : "bundle install";
  // A gemspec is how a repository says it publishes a gem. A Gemfile alone could be a Jekyll site or a Sinatra app,
  // and a gem that ships a config.ru or an app.rb has an app to run.
  const library = !rails && rootGemspec(files) !== undefined && !has(files, "config.ru", "app.rb", "server.rb");
  const pinned = ev.versions.ruby ?? /^[ \t]*ruby[ \t]+["'](\d+\.\d+(?:\.\d+)?)["']/m.exec(snapshot.contents.Gemfile ?? "")?.[1] ?? "3.3";
  const migrate = "bin/rails db:prepare";
  return {
    stack: rails ? ["Ruby", "Rails"] : ["Ruby"],
    kind: rails ? "web" : "cli",
    summary: rails ? "Ruby on Rails app." : "Ruby project.",
    setup: [`mise use -g ruby@${pinned}`, install, ...(rails ? [`${migrate} || true`] : [])],
    start: rails ? "bin/rails server -b 0.0.0.0 -p 3000" : null,
    port: rails ? 3000 : null,
    env: {},
    cwd: WORKSPACE,
    previewPath: null,
    confidence: rails ? "medium" : "low",
    facts: rails ? { migrate } : {},
    signature: `ruby:${rails ? "rails" : library ? "library" : "none"}:${gemspec ? "rubygems" : "bundler"}`,
    ...(library ? { nothingToServe: "a gemspec and no Rails or Rack app" } : {}),
  };
}

/**
 * Laravel runs through artisan; any other PHP project is a site only when it has a front controller to serve (index.php
 * at the root, or in public/ or web/). Without one it is a library or a command-line tool: installed, not started.
 */
function detectPhp(snapshot: Snapshot, files: Set<string>): Plan {
  const laravel = files.has("artisan");
  const setup = [
    "apt-get update && apt-get install -y php-cli php-mbstring php-xml php-curl php-sqlite3 php-zip composer",
  ];
  if (files.has("composer.json")) setup.push("composer install --no-interaction");
  if (laravel) setup.push("cp -n .env.example .env || true", "php artisan key:generate || true");
  const docroot = files.has("index.php") ? "." : ["public", "web"].find((d) => files.has(`${d}/index.php`));
  const serve = docroot === undefined ? null : `php -S 0.0.0.0:8000${docroot === "." ? "" : ` -t ${docroot}`}`;
  const start = laravel ? "php artisan serve --host=0.0.0.0 --port=8000" : serve;
  // A package, positively: Composer's type is not "project" (its word for an application), and no front controller
  // sits anywhere near the root for a server the detector doesn't know how to point (www/index.php, web/app.php).
  const type = parseJson<{ type?: unknown }>(snapshot.contents["composer.json"])?.type;
  const frontController = [...files].some((f) => f.split("/").length <= 3 && /(^|\/)(index|app|app_dev)\.php$/.test(f));
  const library = !start && files.has("composer.json") && type !== "project" && !frontController;
  return {
    stack: laravel ? ["PHP", "Laravel"] : ["PHP"],
    kind: start ? "web" : "cli",
    summary: laravel ? "Laravel app." : start ? "PHP site." : "PHP package.",
    setup,
    start,
    port: start ? 8000 : null,
    env: {},
    cwd: WORKSPACE,
    previewPath: null,
    confidence: start ? "medium" : "low",
    facts: laravel ? { migrate: "php artisan migrate --force" } : {},
    signature: `php:${laravel ? "laravel" : library ? "library" : "none"}:${files.has("composer.json") ? "composer" : "none"}`,
    ...(library ? { nothingToServe: "composer.json for a package, and no index.php to serve" } : {}),
  };
}

function detectDeno(snapshot: Snapshot): Plan {
  const cfg = parseJson<{ tasks?: Record<string, string> }>(snapshot.contents["deno.json"] ?? snapshot.contents["deno.jsonc"]);
  const task = ["dev", "start", "serve"].find((t) => cfg?.tasks?.[t]);
  return {
    stack: ["Deno"],
    kind: task ? "web" : "cli",
    summary: "Deno project.",
    setup: ["mise use -g deno@latest"],
    start: task ? `deno task ${task}` : null,
    port: task ? 8000 : null,
    env: { PORT: "8000" },
    cwd: WORKSPACE,
    previewPath: null,
    confidence: "low",
    signature: "deno:none:deno",
  };
}

/** Folders a repository with no app of its own publishes a site from. */
const STATIC_DIRS = ["docs", "site", "public", "html", "www"];

function staticSite(dir: string): Plan {
  return {
    stack: ["HTML", "Static site"],
    kind: "web",
    summary: "Static website.",
    setup: [],
    start: "python3 -m http.server 8080 --bind 0.0.0.0",
    port: 8080,
    env: {},
    cwd: cwdFor(dir),
    previewPath: null,
    confidence: "high",
    signature: "static:none:none",
  };
}
