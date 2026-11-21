import { shq } from "../evidence/shell";
import { listNames, parseJsonc, type Plan, WORKSPACE } from "../plan";
import type { Snapshot } from "../snapshot";
import type { RootLanguage } from "./stack";

const SOLUTION = /\.slnx?$/;
const PROJECT = /\.(cs|fs|vb)proj$/;
/** Folders whose projects demonstrate or test the code rather than being it. */
const SIDE_FOLDER = /(^|\/)(tests?|samples?|examples?|benchmarks?|perf|docs?|templates?|testassets|playground)(\/|$)/i;
/** A project named as a test project (Api.Tests, Web.AcceptanceTests, IntegrationTestHost); case matters: not "Backtest". */
const TEST_PROJECT = /[a-z.]Tests?(\/|$)|TestHost/;
const notTheApp = (path: string) => SIDE_FOLDER.test(path) || TEST_PROJECT.test(path);
/** The .NET LTS release Pyrovue installs when global.json pins none. */
const DEFAULT_SDK = "10";
const LISTEN = "--no-launch-profile --urls http://0.0.0.0:5000";

const depth = (file: string) => file.split("/").length - 1;
const dirOf = (file: string) => (file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : ".");

/** Solutions at the root or one folder down, the root's first. */
function solutions(files: Set<string>): string[] {
  return [...files].filter((f) => SOLUTION.test(f) && depth(f) <= 1).sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b));
}

/**
 * Folders that hold an ASP.NET Core project. The project file says so when the snapshot has read it (the Web SDK);
 * otherwise it is told by the files the template creates beside it: appsettings.json and a Program or Startup class.
 * Only near the root (`.`, `Web`, `src/Web`): one buried deeper is a template or a fixture of a library, not the
 * repository's app. Test and sample projects are left out, and so is an Aspire AppHost, which starts containers
 * rather than serving the site.
 */
function webProjects(snapshot: Snapshot, files: Set<string>): string[] {
  const out: string[] = [];
  for (const f of files) {
    if (!PROJECT.test(f)) continue;
    const dir = dirOf(f);
    if (dir.split("/").length > 2 || notTheApp(dir) || /AppHost$/i.test(dir) || out.includes(dir)) continue;
    const at = (name: string) => files.has(dir === "." ? name : `${dir}/${name}`);
    const text = snapshot.contents[f];
    const web = text !== undefined ? /Sdk\s*=\s*"Microsoft\.NET\.Sdk\.Web"/.test(text) : at("appsettings.json") && (at("Program.cs") || at("Startup.cs") || at("Program.fs"));
    if (web) out.push(dir);
  }
  return out.sort();
}

/**
 * A WPF, WinUI, MAUI or Avalonia application (its App.xaml), or a WinForms form (a designer file with its .resx):
 * a window, not a server. XAML views alone don't say so, since libraries ship those too, and neither does a
 * designer file alone, which Entity Framework migrations also have.
 */
function isDesktop(files: Set<string>): boolean {
  return [...files].some((f) => !notTheApp(f) && (/(^|\/)App\.a?xaml$/.test(f) || (/Form\w*\.Designer\.cs$/.test(f) && files.has(f.replace(/\.Designer\.cs$/, ".resx")))));
}

/**
 * A .NET solution or project. Only an ASP.NET Core project gets a start command (`dotnet run`, listening where the
 * preview looks): the single one in the repository. A library or console program has its packages restored, and a
 * desktop app is recognised and left alone.
 */
function detectDotnet(snapshot: Snapshot, files: Set<string>): Plan {
  // The exact SDK when global.json pins one: its default roll-forward only accepts the same feature band.
  const pinned = parseJsonc<{ sdk?: { version?: unknown } }>(snapshot.contents["global.json"])?.sdk?.version;
  const sdk = typeof pinned === "string" && /^\d+\.\d+\.\d+[\w.-]*$/.test(pinned) ? pinned : DEFAULT_SDK;
  const setup = [`mise use -g dotnet@${sdk}`];
  const solution = solutions(files)[0];
  const restoreAll = solution ? `dotnet restore ${shq(solution)}` : "dotnet restore";
  const base = { cwd: WORKSPACE, previewPath: null, env: {} as Record<string, string> };
  const run = (dir: string) => `dotnet run${dir === "." ? "" : ` --project ${shq(dir)}`} ${LISTEN}`;

  const web = webProjects(snapshot, files);
  if (web.length === 1) {
    const dir = web[0]!;
    return {
      ...base,
      stack: [".NET", "ASP.NET Core"],
      kind: "web",
      summary: dir === "." ? "ASP.NET Core app." : `ASP.NET Core app in ${dir}/.`,
      setup: [...setup, dir === "." ? "dotnet restore" : `dotnet restore ${shq(dir)}`],
      start: run(dir),
      port: 5000,
      // `--no-launch-profile` drops the profile that sets Development; an SDK newer than the target still runs it.
      env: { ASPNETCORE_ENVIRONMENT: "Development", DOTNET_ROLL_FORWARD: "Major" },
      confidence: "medium",
      signature: "dotnet:aspnet:nuget",
    };
  }
  if (web.length > 1) {
    const n = web.length;
    return {
      ...base,
      stack: [".NET", "ASP.NET Core"],
      kind: "cli",
      summary: `.NET solution with ${n} ASP.NET Core projects (${listNames(web)}).`,
      setup: [...setup, restoreAll],
      start: null,
      port: null,
      confidence: "low",
      notes: [`This solution has ${n} ASP.NET Core projects, so Pyrovue does not pick one to start. Packages are restored; start one with \`${run(web[0]!)}\` in the terminal.`],
      // Its own signature: what is learned from solutions that start nothing mustn't count for the ones that start a server.
      signature: "dotnet:aspnet-multi:nuget",
    };
  }
  if (isDesktop(files)) {
    return {
      ...base,
      stack: [".NET", "Desktop app"],
      kind: "unknown",
      summary: ".NET desktop app.",
      setup: [],
      start: null,
      port: null,
      confidence: "low",
      notes: ["This is a .NET desktop app: it opens a window (most need Windows), so there is nothing to run or preview in the box."],
      signature: "dotnet:desktop:nuget",
    };
  }
  return {
    ...base,
    stack: [".NET"],
    kind: "cli",
    summary: solution ? ".NET solution." : ".NET project.",
    setup: [...setup, restoreAll],
    start: null,
    port: null,
    confidence: "low",
    signature: "dotnet:none:nuget",
  };
}

export const DOTNET: RootLanguage = {
  // A solution only counts with a .NET project somewhere: Visual C++ uses .sln files too.
  marks: (files) => {
    const projects = [...files].filter((f) => PROJECT.test(f));
    return projects.some((f) => depth(f) === 0) || (projects.length > 0 && solutions(files).length > 0);
  },
  source: /\.(cs|fs|vb)$/,
  detect: detectDotnet,
};
