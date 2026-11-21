import type { Box } from "../sandbox/box";

/** A cheap, read-only picture of the repo: the file list plus the contents of files that explain how to run it. */
export interface Snapshot {
  files: string[];
  contents: Record<string, string>;
}

const KEY_FILE_PATTERNS: RegExp[] = [
  /^readme(\.[a-z]+)?$/i,
  /^(contributing|development|developing|hacking|running|setup|install|installation|getting[-_]started)\.(md|markdown|rst|txt)$/i,
  // pyroenv.json is the name from before the rename to Pyrovue; repos that ship it still get it honoured.
  /^(pyrovue|pyroenv)\.json$/,
  /(^|\/)package\.json$/,
  /^(pnpm-workspace\.yaml|lerna\.json|turbo\.json|nx\.json)$/,
  /^(requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py|setup\.cfg|environment\.ya?ml)$/,
  /^(backend|server|api|app|web|src)\/(manage\.py|requirements[\w.-]*\.txt|pyproject\.toml|Pipfile|setup\.py)$/,
  /^(go\.mod|Cargo\.toml|Gemfile|composer\.json|deno\.jsonc?|mix\.exs|pom\.xml|build\.gradle(\.kts)?|global\.json)$/,
  // .NET project files near the root: the SDK attribute says whether a project is a web app.
  /^([\w.-]+\/){0,2}[\w. -]+\.(cs|fs|vb)proj$/,
  // A Go backend next to a frontend: its go.mod names the Go version to install.
  /^(backend|server|api|app|web|src)\/go\.mod$/,
  // Container, process and task-runner configs, at the root and one level down.
  /^([\w.-]+\/)?(Dockerfile|dockerfile|Containerfile)(\.[\w.-]+)?$/,
  /^[\w.-]+\.(Dockerfile|dockerfile)$/,
  /^([\w.-]+\/)?(docker-)?compose(\.[\w.-]+)?\.ya?ml$/,
  /^Procfile(\.[\w-]+)?$/,
  /^(GNUmakefile|Makefile|makefile|justfile|Justfile|\.justfile|Taskfile\.ya?ml|taskfile\.ya?ml)$/,
  // Hosting configs.
  /^(app\.json|fly\.toml|render\.ya?ml|netlify\.toml|vercel\.json|railway\.(json|toml)|nixpacks\.toml)$/,
  /^(\.nvmrc|\.node-version|\.python-version|\.ruby-version|\.go-version|\.tool-versions|mise\.toml|\.mise\.toml|runtime\.txt)$/,
  /^\.devcontainer\.json$/,
  // Flask's own env file (FLASK_APP names the app); committed on purpose, unlike .env.
  /^([\w.-]+\/)?\.flaskenv$/,
  /^\.devcontainer\/(devcontainer\.json|[\w.-]+\/devcontainer\.json|(docker-)?compose[\w.-]*\.ya?ml)$/,
  /^([\w.-]+\/)?(\.env\.(example|sample|template|dist|defaults|local\.example|local\.sample|development\.example|dev\.example)|env\.example|example\.env|\.env-example|\.env_example)$/,
  /^(\w+\/)?(vite|next|nuxt|astro|svelte|remix|gatsby|vue|webpack|angular)\.config\.[cm]?[jt]s$/,
  /^angular\.json$/,
  // A Tauri app's config names the web frontend's dev command and address; the app may sit a folder or two down.
  /^([\w.-]+\/){0,2}src-tauri\/(tauri\.conf\.json5?|Tauri\.toml)$/,
  /^(\w+\/)?prisma\/schema\.prisma$|^schema\.prisma$/,
  /^config\/(application|routes|puma)\.rb$|^config\/database\.yml$/,
  /^[\w-]+\/settings\.py$|^[\w-]+\/settings\/(__init__|base|common|dev|development|local)\.py$/,
  /^(manage\.py|app\.py|main\.py|server\.py|wsgi\.py|asgi\.py|streamlit_app\.py|api\.py|run\.py|[\w-]+_app\.py)$/,
  /^(app|src|backend|api|server)\/(__init__|main|app|server|api)\.py$/,
  /^[\w-]+\/__init__\.py$/,
  /^(index|server|app|main)\.[cm]?[jt]s$/,
  /^(src|server|backend|api)\/(index|server|app|main)\.[cm]?[jt]sx?$/,
  /^index\.html$/,
  /^(main\.go|cmd\/[\w-]+\/main\.go)$/,
  /^src\/main\.rs$/,
  /^artisan$/,
];

/** Development guides under docs/ are worth reading even though the rest of docs/ isn't. */
const DOC_GUIDES = /^docs?\/(development|developing|contributing|setup|getting[-_]started|install(ation)?|local[-_]?(development|setup)|running|quick[-_]?start)\.(md|rst)$/i;

const SKIP_DIRS = /(^|\/)(node_modules|vendor|dist|build|\.git|\.next|__pycache__|\.venv|venv|target|coverage|fixtures|examples?|test|tests|docs?)\//;

/** Source files are only read for port hints and app objects, which sit near the top. */
const SOURCE = /\.([cm]?[jt]sx?|py|go|rs|rb)$/;
const SOURCE_LINES = 200;
const MAX_FILES = 64;
/** How many source files at a Go module's root are read for their package clause (`package main` or a library's name). */
const ROOT_GO_FILES = 2;
/** Each read is its own docker exec; a few at a time keeps the analyze step short without flooding dockerd. */
const READ_CONCURRENCY = 8;

export function selectKeyFiles(files: string[]): string[] {
  const picked: string[] = [];
  let rootGo = 0;
  const goModule = files.includes("go.mod");
  for (const file of files) {
    const depth = file.split("/").length - 1;
    if (depth > 3) continue;
    if (goModule && depth === 0 && file.endsWith(".go") && !file.endsWith("_test.go") && file !== "main.go") {
      if (rootGo++ < ROOT_GO_FILES) picked.push(file);
      continue;
    }
    if (DOC_GUIDES.test(file)) {
      picked.push(file);
      continue;
    }
    if (depth > 0 && SKIP_DIRS.test(file)) continue;
    // Nested package.json files are useful in monorepos, but only near the top.
    if (/package\.json$/.test(file) && depth > 2) continue;
    if (KEY_FILE_PATTERNS.some((re) => re.test(file))) picked.push(file);
  }
  // Root files first, then shallow ones; cap the total.
  return picked.sort((a, b) => a.split("/").length - b.split("/").length || a.localeCompare(b)).slice(0, MAX_FILES);
}

function maxBytesFor(file: string): number {
  if (/readme/i.test(file)) return 24 * 1024;
  if (SOURCE.test(file) && !/(^|\/)(manage|setup)\.py$/.test(file)) return 16 * 1024;
  if (/\.(md|markdown|rst|txt)$/i.test(file)) return 16 * 1024;
  return 48 * 1024;
}

/**
 * Paths the snapshot asks for. git lists them in byte order, so a smaller cut keeps only an alphabetical prefix of a big
 * repo; what reads the list (key files, the detector) picks from it by priority and caps it itself.
 */
const SNAPSHOT_FILE_LIMIT = 200_000;

export async function collectSnapshot(box: Box): Promise<Snapshot> {
  const files = await box.listFiles(SNAPSHOT_FILE_LIMIT);
  const contents: Record<string, string> = {};
  const picked = selectKeyFiles(files);
  const texts: (string | null)[] = new Array(picked.length).fill(null);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(READ_CONCURRENCY, picked.length) }, async () => {
      while (next < picked.length) {
        const i = next++;
        texts[i] = await box.readText(`/workspace/${picked[i]}`, maxBytesFor(picked[i]!));
      }
    }),
  );
  // In selection order, not completion order: the agent's prompt and the Python detector both read contents in order.
  for (const [i, file] of picked.entries()) {
    const text = texts[i] ?? null;
    if (text === null || text.includes("\u0000")) continue;
    contents[file] = SOURCE.test(file) ? text.split("\n").slice(0, SOURCE_LINES).join("\n") : text;
  }
  return { files, contents };
}

/** Renders a compact tree-ish listing for prompts, keeping the most informative paths when the repo is huge. */
export function summarizeFiles(files: string[], max = 600): string {
  if (files.length <= max) return files.join("\n");
  const shallow = files.filter((f) => f.split("/").length <= 3);
  const chosen = shallow.slice(0, max);
  return `${chosen.join("\n")}\n… and ${files.length - chosen.length} more files`;
}
