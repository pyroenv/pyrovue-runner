import { parseJson } from "../plan";
import type { Snapshot } from "../snapshot";
import { type ComposeInfo, parseCompose } from "./compose";
import { type DevcontainerEvidence, devcontainerEvidence } from "./devcontainer";
import { type DockerEvidence, dockerEvidence } from "./dockerfile";
import { type EnvTemplate, isEnvTemplate, readEnvTemplate } from "./envfile";
import {
  type AppJsonEvidence,
  appJsonEvidence,
  flyEvidence,
  netlifyEvidence,
  nixpacksEvidence,
  type PlatformEvidence,
  railwayEvidence,
  renderEvidence,
  vercelEvidence,
} from "./platform";
import { codePorts } from "./ports";
import { type ProcfileEvidence, procfileEvidence } from "./procfile";
import { mineReadme, type ReadmeEvidence } from "./readme";
import type { Tool } from "./shell";
import { type TaskRunnerEvidence, taskRunnerEvidence } from "./tasks";
import { parseToml, tomlGet } from "./toml";

/** Everything the parsers could read from a snapshot, for the candidate builder. All of it is optional. */
export interface RepoEvidence {
  files: Set<string>;
  readme: (ReadmeEvidence & { file: string }) | null;
  /** CONTRIBUTING, DEVELOPMENT and docs guides, mined the same way. */
  guides: (ReadmeEvidence & { file: string })[];
  /** Root Dockerfiles, development flavours first. */
  dockerfiles: (DockerEvidence & { file: string })[];
  compose: { file: string; info: ComposeInfo } | null;
  devcontainer: DevcontainerEvidence | null;
  /** Procfile.dev before Procfile. */
  procfiles: ProcfileEvidence[];
  tasks: TaskRunnerEvidence | null;
  platforms: PlatformEvidence[];
  appJson: AppJsonEvidence | null;
  envTemplates: EnvTemplate[];
  /** Ports that source files bind, in file order. */
  codePorts: number[];
  /** Ports dev-server config files ask for (vite.config.ts `port: 3000`). */
  configPorts: { dir: string; port: number }[];
  /** Runtime versions pinned by version files (.nvmrc, .python-version, .tool-versions, runtime.txt …). */
  versions: Partial<Record<Tool, string>>;
}

const DEV_FIRST = (name: string) => (/dev|local/i.test(name) ? 0 : /prod|release|ci|test/i.test(name) ? 2 : 1);

/** Names the project publishes under, so README lines that install the published package are recognised. */
export function packageNames(snapshot: Snapshot): string[] {
  const names: string[] = [];
  const pkg = parseJson<{ name?: string }>(snapshot.contents["package.json"]);
  if (pkg?.name) names.push(pkg.name);
  const py = parseToml(snapshot.contents["pyproject.toml"]);
  for (const path of ["project.name", "tool.poetry.name"]) {
    const v = tomlGet(py, path);
    if (typeof v === "string") names.push(v);
  }
  const setup = /\bname\s*=\s*["']([\w.-]+)["']/.exec(snapshot.contents["setup.py"] ?? "")?.[1];
  if (setup) names.push(setup);
  return [...new Set(names)];
}

/** The repository's own name, from a `git clone …/name.git` line in the README. */
export function repoNameFrom(text: string): string | undefined {
  return /git\s+clone\s+(?:--\S+\s+)*\S*?\/([\w.-]+?)(?:\.git)?\/?(?:\s|$)/.exec(text)?.[1];
}

/** Versions end up inside `mise use -g tool@<version>`, so only plain numbers (and `.x` for Node) are taken from a repo. */
const PLAIN_VERSION = /^\d+(\.\d+){0,2}$/;
const NODE_VERSION = /^\d+(\.(\d+|x)){0,2}$/;

function versionFiles(snapshot: Snapshot): Partial<Record<Tool, string>> {
  const c = snapshot.contents;
  const out: Partial<Record<Tool, string>> = {};
  const clean = (v: string | undefined) => v?.trim().split(/\s+/)[0]?.replace(/^v/, "") || undefined;
  const node = clean(c[".nvmrc"]) ?? clean(c[".node-version"]);
  if (node && NODE_VERSION.test(node)) out.node = node;
  const python = clean(c[".python-version"]) ?? /python-(\d+\.\d+(?:\.\d+)?)/.exec(c["runtime.txt"] ?? "")?.[1];
  if (python && /^3\.\d+/.test(python) && PLAIN_VERSION.test(python)) out.python = python;
  const ruby = clean(c[".ruby-version"])?.replace(/^ruby-/, "");
  if (ruby && /^\d+\.\d+/.test(ruby) && PLAIN_VERSION.test(ruby)) out.ruby = ruby;
  const go = clean(c[".go-version"]);
  if (go && /^\d+\.\d+/.test(go) && PLAIN_VERSION.test(go)) out.go = go;
  for (const line of (c[".tool-versions"] ?? "").split("\n")) {
    const m = /^\s*(nodejs|node|python|ruby|golang|go)\s+(\d[\w.]*)/.exec(line);
    if (!m || !(m[1]!.startsWith("node") ? NODE_VERSION : PLAIN_VERSION).test(m[2]!)) continue;
    const tool: Tool = m[1]!.startsWith("node") ? "node" : m[1]!.startsWith("go") ? "go" : (m[1] as Tool);
    out[tool] ??= m[2]!;
  }
  const mise = parseToml(c["mise.toml"] ?? c[".mise.toml"]);
  for (const [key, tool] of [["tools.node", "node"], ["tools.python", "python"], ["tools.ruby", "ruby"], ["tools.go", "go"]] as const) {
    const v = tomlGet(mise, key);
    const version = typeof v === "string" ? v : Array.isArray(v) && typeof v[0] === "string" ? v[0] : null;
    if (version && (tool === "node" ? NODE_VERSION : PLAIN_VERSION).test(version)) out[tool] ??= version;
  }
  return out;
}

/** One source's reading, or the fallback when its parser trips on a value of the wrong type: one odd file mustn't fail the whole setup. */
function guard<T>(read: () => T, fallback: T): T {
  try {
    return read();
  } catch {
    return fallback;
  }
}

export function gatherEvidence(snapshot: Snapshot): RepoEvidence {
  const files = new Set(snapshot.files);
  const c = snapshot.contents;
  const names = packageNames(snapshot);
  const entries = Object.entries(c);

  const readmeFile = entries.find(([f]) => /^readme(\.[a-z]+)?$/i.test(f))?.[0] ?? null;
  const repoName = readmeFile ? repoNameFrom(c[readmeFile]!) : undefined;
  const mine = (file: string) => guard(() => ({ ...mineReadme(c[file]!, { files, repoName, packageNames: names }), file }), null);
  const readme = readmeFile ? mine(readmeFile) : null;
  const guides = entries
    .filter(([f]) => f !== readmeFile && /^(docs?\/)?(contributing|development|developing|hacking|running|setup|install|installation|getting[-_]started|local[-_]?(development|setup)|quick[-_]?start)\.(md|markdown|rst|txt)$/i.test(f))
    .map(([f]) => mine(f))
    .filter((g): g is NonNullable<typeof g> => g !== null);

  const dockerfiles = entries
    .filter(([f]) => /^((Dockerfile|dockerfile|Containerfile)(\.[\w.-]+)?|[\w.-]+\.(Dockerfile|dockerfile))$/.test(f))
    .sort(([a], [b]) => DEV_FIRST(a) - DEV_FIRST(b) || a.length - b.length)
    .map(([file, text]) => {
      const ev = guard(() => dockerEvidence(text, { files, dir: ".", name: file }), null);
      return ev ? { ...ev, file } : null;
    })
    .filter((d): d is DockerEvidence & { file: string } => d !== null);

  const envTemplates = entries.filter(([f]) => isEnvTemplate(f)).map(([f, text]) => readEnvTemplate(f, text));
  const rootTemplate = envTemplates.find((t) => !t.file.includes("/"));

  const composeFile = entries
    .map(([f]) => f)
    .filter((f) => /^(docker-)?compose(\.[\w.-]+)?\.ya?ml$/.test(f) && !/prod|release|test|ci\b/i.test(f))
    .sort((a, b) => DEV_FIRST(a) - DEV_FIRST(b) || a.length - b.length)[0];
  let compose = composeFile ? { file: composeFile, info: guard(() => parseCompose(c[composeFile]!, rootTemplate?.values ?? {}), null) } : null;

  const devFile = [".devcontainer/devcontainer.json", ".devcontainer.json", ...entries.map(([f]) => f).filter((f) => /^\.devcontainer\/[\w.-]+\/devcontainer\.json$/.test(f))].find((f) => c[f]);
  const devcontainer = devFile ? guard(() => devcontainerEvidence(c[devFile]!, { files, file: devFile }), null) : null;
  // A dev container built from compose names its own compose file; its companions count too.
  if (!compose?.info && devcontainer?.compose) {
    const file = devcontainer.compose.files.find((f) => c[f]);
    if (file) compose = { file, info: guard(() => parseCompose(c[file]!, rootTemplate?.values ?? {}), null) };
  }

  const procfiles = ["Procfile.dev", "Procfile"].filter((f) => c[f]).flatMap((file) => guard(() => [procfileEvidence(c[file]!, { files, file })], []));
  const taskFile = ["Makefile", "GNUmakefile", "makefile", "justfile", "Justfile", ".justfile", "Taskfile.yml", "Taskfile.yaml", "taskfile.yml"].find((f) => c[f]);
  const tasks = taskFile ? guard(() => taskRunnerEvidence(c[taskFile]!, { files, file: taskFile }), null) : null;

  const platforms: PlatformEvidence[] = [];
  const add = (read: () => PlatformEvidence | null) => {
    const ev = guard(read, null);
    if (ev) platforms.push(ev);
  };
  if (c["netlify.toml"]) add(() => netlifyEvidence(c["netlify.toml"]!, files));
  if (c["fly.toml"]) add(() => flyEvidence(c["fly.toml"]!, files));
  for (const f of ["render.yaml", "render.yml"]) if (c[f]) platforms.push(...guard(() => renderEvidence(c[f]!, files), []));
  if (c["vercel.json"]) add(() => vercelEvidence(c["vercel.json"]!, files));
  for (const f of ["railway.json", "railway.toml"]) if (c[f]) add(() => railwayEvidence(c[f]!, files, f));
  if (c["nixpacks.toml"]) add(() => nixpacksEvidence(c["nixpacks.toml"]!, files));
  const appJson = c["app.json"] ? guard(() => appJsonEvidence(c["app.json"]!, files), null) : null;

  const ports: number[] = [];
  const configPorts: { dir: string; port: number }[] = [];
  for (const [file, text] of entries) {
    if (/\.config\.[cm]?[jt]s$/.test(file)) {
      const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".";
      for (const port of codePorts(text)) configPorts.push({ dir, port });
    } else if (/\.([cm]?[jt]sx?|py|go|rs|rb)$/.test(file) && !/(^|\/)(setup|manage|conftest)\.py$|settings/.test(file)) {
      for (const p of codePorts(text)) if (!ports.includes(p)) ports.push(p);
    }
  }

  return {
    files,
    readme,
    guides,
    dockerfiles,
    compose: compose?.info ? (compose as { file: string; info: ComposeInfo }) : null,
    devcontainer,
    procfiles,
    tasks,
    platforms,
    appJson,
    envTemplates,
    codePorts: ports,
    configPorts,
    versions: versionFiles(snapshot),
  };
}
