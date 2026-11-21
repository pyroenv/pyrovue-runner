import { posix } from "node:path";
import { isRecord } from "../../util/text";
import { parseToml } from "../evidence/toml";
import { parseJsonc, runScript, type PM } from "../plan";
import type { Snapshot } from "../snapshot";

/**
 * Desktop apps made of a web frontend and a native shell: Tauri (Rust) and Electron. A box has no window for the shell
 * (and no Rust toolchain for Tauri), so Pyrovue runs the frontend and says that the native side is not there. This
 * module reads the project; detect.ts decides what to do with it.
 */

/** What the plan says about a Tauri project. */
export const TAURI_RUNS_NOTE = "This is a Tauri desktop app. Pyrovue runs its web page; anything the page asks of the Rust side (native windows, files, the app's own commands) does not work in the box.";
export const TAURI_NOTHING_NOTE = "This is a Tauri desktop app and the only way to start it is `tauri dev`, which opens a native window and needs Rust, so there is nothing to run or preview in the box.";

/** The scripts a Node project starts its frontend with, in the detector's order. */
export const START_SCRIPTS = ["dev", "start", "serve", "develop", "start:dev", "preview"];

const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const ENV_ASSIGNMENT = /^[A-Za-z_]\w*=/;
const isTauriWord = (word: string | undefined) => word === "tauri" || (word?.startsWith("tauri:") ?? false);
const isElectronWord = (word: string | undefined) => /^electron(-forge|-vite|-webpack|-builder|-packager)?$/.test(word ?? "");

/** Whether one simple command (no `&&`, pipes or quotes) runs the tool: `tauri dev`, `cargo tauri dev`, `npx tauri`, `npm run tauri`, `pnpm tauri`, `cross-env A=1 tauri`. */
function opens(words: string[], isTool: (word: string | undefined) => boolean): boolean {
  let i = 0;
  while (i < words.length && (ENV_ASSIGNMENT.test(words[i]!) || words[i] === "cross-env" || words[i] === "env")) i++;
  const first = words[i];
  if (isTool(first)) return true;
  const launcher = first === "cargo" || first === "npx" || first === "bunx" || (first !== undefined && PACKAGE_MANAGERS.has(first));
  if (!launcher) return false;
  // The word after the launcher and its flags and subcommand: `cargo tauri`, `npm run tauri`, `pnpm exec tauri`, `yarn tauri`.
  const rest = words.slice(i + 1).filter((w) => !w.startsWith("-"));
  const word = rest[0] === "run" || rest[0] === "exec" || rest[0] === "dlx" ? rest[1] : rest[0];
  return isTool(word);
}

const wordsOf = (command: string) => command.split(/\s/).filter(Boolean);
const opensShell = (command: string, isTool: (word: string | undefined) => boolean) => command.split(/[;&|()"'`]/).some((part) => opens(wordsOf(part), isTool));

/** Whether the command runs the tool, following one level of indirection (a script that only calls another script). */
function runs(command: string, scripts: Record<string, unknown>, isTool: (word: string | undefined) => boolean): boolean {
  if (opensShell(command, isTool)) return true;
  const call = scriptCall(command);
  const body = call !== null && Object.hasOwn(scripts, call.script) ? scripts[call.script] : undefined;
  return typeof body === "string" && opensShell(body, isTool);
}

export const runsTauri = (command: string, scripts: Record<string, unknown>) => runs(command, scripts, isTauriWord);
const runsElectron = (command: string, scripts: Record<string, unknown>) => runs(command, scripts, isElectronWord);

export const ELECTRON_RUNS_NOTE = "This is an Electron desktop app. Pyrovue runs its web page; anything the page asks of the Electron side (native windows, files, the app's own commands) does not work in the box.";
export const ELECTRON_NOTHING_NOTE = "This is an Electron desktop app and the only way to start it opens a native window, so there is nothing to run or preview in the box.";

/**
 * An Electron project's web page: the dev script that doesn't open the Electron window (the renderer's own dev
 * server), by the detector's usual order. Null when every start script opens the window.
 */
export function electronProject(scripts: unknown, pm: PM): { start: string | null } {
  const all: Record<string, unknown> = isRecord(scripts) ? scripts : {};
  const script = START_SCRIPTS.find((s) => typeof all[s] === "string" && all[s] !== "" && !runsElectron(all[s], all));
  return { start: script ? runScript(pm, script) : null };
}

/** `npm run dev -- --port 1`, `pnpm dev`, `yarn dev`: the script it runs and the arguments after it; null for any other command. */
function scriptCall(command: string): { manager: string; script: string; args: string[] } | null {
  const words = wordsOf(command);
  const manager = words[0];
  if (manager === undefined || !PACKAGE_MANAGERS.has(manager)) return null;
  const at = words[1] === "run" ? 2 : 1;
  const script = words[at];
  return script !== undefined && /^[\w:.-]+$/.test(script) && !script.startsWith("-") ? { manager, script, args: words.slice(at + 1) } : null;
}

const CONFIGS = ["tauri.conf.json", "tauri.conf.json5", "Tauri.toml"];
/** Dev servers that are run by name, which a shell cannot find without npx. */
const BARE_TOOL = /^(vite|next|nuxt|astro|ng|webpack|webpack-dev-server|parcel|react-scripts|vue-cli-service|svelte-kit|remix|gatsby|docusaurus|vitepress|eleventy|serve|http-server)(\s|$)/;
/** One word of a command that carries no shell syntax. */
const SAFE_WORD = /^[\w:.\/=@,+-]+$/;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

export interface TauriProject {
  /** The web frontend's start command, or null when the only way to start is the native shell. */
  start: string | null;
  /** The port the config says the frontend listens on. */
  port: number | null;
}

interface BuildConfig {
  command: string | null;
  /** Where the command runs, relative to the config's folder, when the config says. */
  cwd: string | null;
  url: string | null;
}

const text = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);

/** The `build` table of the first Tauri config near the project, in whichever of its formats; null when there is none or it can't be read. */
function readBuild(snapshot: Snapshot, folder: string): { build: BuildConfig; folder: string } | null {
  for (const name of CONFIGS) {
    const path = `${folder}/${name}`;
    const raw = snapshot.contents[path];
    if (raw === undefined) continue;
    // Tauri.toml spells its keys in kebab case; the JSON formats in camel case. JSON5 is read as far as comments and trailing commas.
    const parsed: unknown = name.endsWith(".toml") ? safe(() => parseToml(raw)) : parseJsonc<unknown>(raw);
    const section = isRecord(parsed) ? parsed.build : undefined;
    if (!isRecord(section)) return { build: { command: null, cwd: null, url: null }, folder };
    const before = section.beforeDevCommand ?? section["before-dev-command"];
    const object = isRecord(before) ? before : null;
    return {
      folder,
      build: {
        command: text(object ? object.script : before),
        cwd: text(object?.cwd),
        url: text(section.devUrl ?? section["dev-url"] ?? section.devPath ?? section["dev-path"]),
      },
    };
  }
  return null;
}

function safe<T>(read: () => T): T | null {
  try {
    return read();
  } catch {
    return null;
  }
}

/** The port of an http(s) address on this machine; null for a folder, another host, or an address with no port. */
function portOf(url: string | null): number | null {
  if (!url || !/^https?:\/\//i.test(url)) return null;
  try {
    const u = new URL(url);
    const port = Number(u.port);
    return LOOPBACK.has(u.hostname) && Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
}

/**
 * The command Tauri runs before opening its window, written the way the box runs scripts: `npm run dev` in a pnpm
 * project becomes `pnpm run dev`. Null when it is missing, runs the native shell itself, runs in another folder, or is
 * anything but a call of the project's own script or a bare dev server.
 */
function frontendCommand(build: BuildConfig, configFolder: string, dir: string, pm: PM, scripts: Record<string, unknown>): string | null {
  const command = build.command;
  if (!command || runsTauri(command, scripts)) return null;
  if (build.cwd) {
    // Relative to the config's folder or to the project around it: either way, the folder holding the package.json.
    const here = [configFolder, posix.dirname(configFolder)].map((base) => posix.normalize(posix.join(base, build.cwd!)));
    if (!here.includes(dir)) return null;
  }
  // The config is repository text: only a call of one of the project's own scripts, or a bare dev server, with plain
  // words after it. Anything with `;`, `|`, `&`, `$(` or a backtick goes unused and the dev-script fallback takes over.
  const words = wordsOf(command);
  if (!words.every((w) => SAFE_WORD.test(w))) return null;
  const call = scriptCall(command);
  if (call) return Object.hasOwn(scripts, call.script) ? [runScript(pm, call.script), ...call.args].join(" ") : null;
  return BARE_TOOL.test(command) ? `npx ${command}` : null;
}

/**
 * Null when the folder is not a Tauri project: it lists the Tauri cli or runs `tauri` in a script, or has a src-tauri folder (its own, or the
 * project root's when the web app lives in a subfolder). Otherwise the web frontend's start command and port.
 * `dir` is the folder of the package.json ("." or "frontend"), `files` the repository's files.
 */
export function tauriProject(snapshot: Snapshot, files: Set<string>, dir: string, deps: Record<string, unknown>, rawScripts: unknown, pm: PM): TauriProject | null {
  const scripts: Record<string, unknown> = isRecord(rawScripts) ? rawScripts : {};
  const folders = [dir === "." ? "src-tauri" : `${dir}/src-tauri`, ...(dir === "." ? [] : ["src-tauri"])];
  const found = folders.find((f) => CONFIGS.some((c) => files.has(`${f}/${c}`)));
  // @tauri-apps/api alone is no sign: libraries and web builds list it for an optional adapter. The cli, or a script that runs `tauri`, is.
  const named = "@tauri-apps/cli" in deps || Object.values(scripts).some((body) => typeof body === "string" && runsTauri(body, scripts));
  if (!found && !named) return null;

  const config = found ? readBuild(snapshot, found) : null;
  const fromConfig = config ? frontendCommand(config.build, config.folder, dir, pm, scripts) : null;
  const script = START_SCRIPTS.find((s) => typeof scripts[s] === "string" && scripts[s] !== "" && !runsTauri(scripts[s], scripts));
  const start = fromConfig ?? (script ? runScript(pm, script) : null);
  return { start, port: start ? portOf(config?.build.url ?? null) : null };
}
