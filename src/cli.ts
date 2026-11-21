import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { buildImage, checkDocker, connect, imageExists, type StartedBox } from "./docker";
import { LearningRepo } from "./learning";
import { parseEnvFile } from "./pipeline/evidence/envfile";
import { parseRepo } from "./repo";
import { type Reporter, runRepo } from "./run";
import type { StepId, StepState } from "./types";

const VERSION = "0.1.0";
const DEFAULT_IMAGE = "pyrovue-runner/box:1";

const HELP = `
Run any Git repository in a disposable Docker box. No config file needed.

Usage
  pyrovue-run <repo> [options]

  <repo> is a GitHub or GitLab link, owner/repo for GitHub, or any https git URL:
    pyrovue-run satnaing/astro-paper
    pyrovue-run https://github.com/owner/repo/tree/some-branch
    pyrovue-run https://gitlab.com/group/project

Options
  -b, --branch <name>     Branch or tag to run
  -p, --port <port>       Port on this machine for the preview (default: a free one)
  -e, --env KEY=VALUE     Pass a variable to the app (repeat for more)
      --env-file <file>   Pass every variable in a dotenv file
      --plan              Only show how the repo would be run; install nothing
      --shell             Open a shell in the box once it's ready
      --open              Open the preview in your browser
      --keep              Keep the box when you exit
      --gvisor            Run the box on gVisor (runsc) for stronger isolation
      --runtime <name>    Use another Docker runtime
      --cpus <n>          CPU limit (default: 2)
      --memory <mb>       Memory limit in MB (default: 4096)
      --timeout <min>     Give up on install and start after this long (default: 20)
      --image <name>      Box image (default: ${DEFAULT_IMAGE}, built on first run)
      --no-learn          Don't read or record what worked on this machine
  -q, --quiet             Hide install output
  -h, --help              Show this help
  -v, --version           Show the version
`;

// ---------------------------------------------------------------- output

const color = process.stdout.isTTY && !process.env.NO_COLOR;
const paint = (code: string) => (s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = paint("2");
const bold = paint("1");
const green = paint("32");
const red = paint("31");
const cyan = paint("36");
const yellow = paint("33");

const STEP_LABEL: Record<StepId, string> = {
  provision: "Starting a box",
  clone: "Cloning",
  analyze: "Reading the repo",
  install: "Installing",
  launch: "Starting the app",
  tour: "Writing a tour",
};

function reporter(quiet: boolean): Reporter {
  let atLineStart = true;
  const write = (text: string) => {
    for (const line of text.split(/(?<=\n)/)) {
      if (atLineStart) process.stdout.write(dim("  │ "));
      process.stdout.write(dim(line));
      atLineStart = line.endsWith("\n");
    }
  };
  const endLine = () => {
    if (!atLineStart) process.stdout.write("\n");
    atLineStart = true;
  };
  return {
    step(step: StepId, state: StepState, detail?: string) {
      endLine();
      const label = STEP_LABEL[step];
      const more = detail ? dim(` · ${detail}`) : "";
      if (state === "active") console.log(`${cyan("●")} ${label}${more}`);
      else if (state === "done") console.log(`${green("✓")} ${label}${more}`);
      else if (state === "failed") console.log(`${red("✗")} ${label}${more}`);
      else if (state === "skipped") console.log(`${dim("–")} ${label}${more}`);
    },
    log(source, text) {
      if (quiet && source === "setup") return;
      write(text);
    },
    thought(text) {
      endLine();
      console.log(`${yellow("→")} ${text}`);
    },
  };
}

// ---------------------------------------------------------------- helpers

function boxDir(): string {
  // dist/cli.js and src/cli.ts both sit one level below the package root, next to box/.
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "box");
}

function readEnv(pairs: string[], files: string[]): Record<string, string> {
  const env: Record<string, string> = {};
  for (const file of files) {
    if (!existsSync(file)) throw new Error(`There's no file at ${file}.`);
    Object.assign(env, parseEnvFile(readFileSync(file, "utf8")));
  }
  for (const pair of pairs) {
    const eq = pair.indexOf("=");
    const key = eq === -1 ? pair : pair.slice(0, eq);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new Error(`"${key}" isn't a valid variable name.`);
    // KEY alone takes the value from this shell, like docker run -e KEY.
    const value = eq === -1 ? process.env[key] : pair.slice(eq + 1);
    if (value !== undefined) env[key] = value;
  }
  return env;
}

function openInBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  spawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).on("error", () => {}).unref();
}

function openShell(name: string): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn("docker", ["exec", "-it", "-w", "/workspace", name, "bash"], { stdio: "inherit" });
    child.on("exit", () => resolve());
    child.on("error", () => resolve());
  });
}

const positiveNumber = (value: string | undefined, fallback: number, name: string): number => {
  if (value === undefined) return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new Error(`--${name} needs a positive number.`);
  return n;
};

// ---------------------------------------------------------------- main

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      branch: { type: "string", short: "b" },
      port: { type: "string", short: "p" },
      env: { type: "string", short: "e", multiple: true },
      "env-file": { type: "string", multiple: true },
      plan: { type: "boolean" },
      shell: { type: "boolean" },
      open: { type: "boolean" },
      keep: { type: "boolean" },
      gvisor: { type: "boolean" },
      runtime: { type: "string" },
      cpus: { type: "string" },
      memory: { type: "string" },
      timeout: { type: "string" },
      image: { type: "string" },
      "no-learn": { type: "boolean" },
      quiet: { type: "boolean", short: "q" },
      help: { type: "boolean", short: "h" },
      version: { type: "boolean", short: "v" },
    },
  });
  if (values.version) {
    console.log(VERSION);
    return 0;
  }
  if (values.help || positionals.length === 0) {
    console.log(HELP);
    return values.help ? 0 : 1;
  }
  if (positionals.length > 1) throw new Error("Give one repository at a time.");

  const target = parseRepo(positionals[0]!, values.branch ?? null);
  if (!target) throw new Error(`"${positionals[0]}" doesn't look like a repository. Try owner/repo or a GitHub or GitLab link.`);

  const env = readEnv(values.env ?? [], values["env-file"] ?? []);
  const image = values.image ?? DEFAULT_IMAGE;
  const hostPort = values.port === undefined ? 0 : positiveNumber(values.port, 0, "port");
  if (!Number.isInteger(hostPort) || hostPort > 65535) throw new Error("--port needs a port number between 1 and 65535.");

  const docker = connect();
  await checkDocker(docker);
  if (!(await imageExists(docker, image))) {
    if (values.image) throw new Error(`There's no Docker image called ${image}.`);
    console.log(`${cyan("●")} Building the box image once ${dim("(a few minutes; later runs skip this)")}`);
    const quietBuild = Boolean(values.quiet);
    await buildImage(image, boxDir(), (text) => {
      if (!quietBuild) process.stdout.write(dim(text));
    });
    console.log(`${green("✓")} Box image ready`);
  }

  const controller = new AbortController();
  let started: StartedBox | null = null;
  let cleaning = false;
  const cleanup = async () => {
    if (cleaning) return;
    cleaning = true;
    if (!started) return;
    if (values.keep) {
      console.log(`\n${dim(`The box is still running. Open a shell with: docker exec -it ${started.name} bash`)}`);
      console.log(dim(`Remove it with: docker rm -f ${started.name}`));
      return;
    }
    process.stdout.write(dim("\nRemoving the box… "));
    await started.remove();
    console.log(dim("done."));
  };
  let interrupted = false;
  process.on("SIGINT", () => {
    if (interrupted) {
      // A second Ctrl+C leaves at once; say how to clean up what is left.
      const name = (started as StartedBox | null)?.name;
      if (name && !values.keep) console.log(dim(`\nLeft the box running. Remove it with: docker rm -f ${name}`));
      process.exit(130);
    }
    interrupted = true;
    controller.abort(new Error("Stopped."));
    void cleanup().then(() => process.exit(130));
  });

  console.log(`\n${bold(`Running ${target.label}`)}${target.branch ? dim(` (${target.branch})`) : ""}\n`);
  const result = await runRepo(docker, target, {
    box: {
      image,
      cpus: positiveNumber(values.cpus, 2, "cpus"),
      memoryMb: Math.round(positiveNumber(values.memory, 4096, "memory")),
      pidsLimit: 2048,
      runtime: values.gvisor ? "runsc" : (values.runtime ?? ""),
      hostPort,
      env,
      label: target.label,
    },
    reporter: reporter(Boolean(values.quiet)),
    signal: controller.signal,
    timeoutMs: positiveNumber(values.timeout, 20, "timeout") * 60_000,
    ...(values["no-learn"] ? {} : { learning: new LearningRepo() }),
    planOnly: Boolean(values.plan),
    onBox: (box) => {
      started = box;
    },
  }).catch(async (err: unknown) => {
    await cleanup();
    throw err;
  });

  const { plan, outcome } = result;
  console.log("");

  if (result.empty) {
    console.log(`There's nothing to run in this repository yet (${result.empty}).`);
  } else if (values.plan && plan) {
    printPlan(plan);
  } else if (outcome?.status === "running" && outcome.port !== null) {
    const url = `http://localhost:${result.started.hostPort}${outcome.start?.previewPath ?? ""}`;
    console.log(`${green("✓")} ${bold("It's running:")} ${cyan(url)}`);
    console.log(dim(`  The app listens on port ${outcome.port} inside the box. Press Ctrl+C to stop.`));
  } else if (outcome?.status === "cli") {
    const how = process.stdin.isTTY ? "Here's a shell in the box to use it." : "Run again with --shell to use it.";
    console.log(`${green("✓")} Everything is installed. This repo has no web server to preview. ${how}`);
  } else if (outcome) {
    console.log(`${red("✗")} ${bold("Couldn't get it running.")}\n\n${outcome.error ?? "The app didn't start."}`);
  }

  const needs = outcome?.needs ?? plan?.needs ?? [];
  const missing = needs.flatMap((n) => n.keys.filter((k) => env[k] === undefined).map((k) => ({ key: k, file: n.file })));
  if (missing.length) {
    console.log(`\n${yellow("!")} This repo expects keys you haven't passed: ${missing.map((m) => m.key).join(", ")}`);
    console.log(dim(`  Pass them with -e KEY=value or --env-file, and run again.`));
  }
  // The line above already says when there is no web server.
  for (const note of outcome?.notes ?? []) if (!/didn't find a web server/.test(note)) console.log(dim(`  · ${note}`));

  const running = outcome?.status === "running" && outcome.port !== null;
  if (running && values.open) openInBrowser(`http://localhost:${result.started.hostPort}${outcome?.start?.previewPath ?? ""}`);

  const wantsShell = values.shell || (outcome?.status === "cli" && process.stdin.isTTY);
  if (wantsShell && process.stdin.isTTY) {
    console.log(dim(`\nOpening a shell in the box. Type exit to leave.\n`));
    await openShell(result.started.name);
    await cleanup();
    return 0;
  }

  if (running) {
    console.log(dim("\n─── app output ───"));
    await result.started.box.followAppLog((text) => process.stdout.write(text), false);
    // Runs until Ctrl+C, which removes the box and exits. Meanwhile, say so if the app stops by itself.
    await new Promise<void>((resolve) => {
      const timer = setInterval(async () => {
        if (cleaning) return;
        if (!(await result.started.box.appRunning().catch(() => true))) {
          clearInterval(timer);
          console.log(`\n${red("✗")} The app stopped.`);
          resolve();
        }
      }, 5000);
    });
  }

  await cleanup();
  return outcome && outcome.status === "failed" ? 1 : 0;
}

function printPlan(plan: NonNullable<Awaited<ReturnType<typeof runRepo>>["plan"]>) {
  console.log(bold("How it would run"));
  console.log(`  ${dim("Stack")}       ${plan.stack.join(", ") || "unknown"}`);
  console.log(`  ${dim("Folder")}      ${plan.cwd}`);
  console.log(`  ${dim("Install")}     ${plan.setup.length ? plan.setup.join("\n              ") : "nothing"}`);
  console.log(`  ${dim("Start")}       ${plan.start ?? "no server (command-line project)"}`);
  if (plan.port) console.log(`  ${dim("Port")}        ${plan.port}`);
  console.log(`  ${dim("Confidence")}  ${plan.confidence}`);
  if (plan.alternatives?.length) {
    console.log(`  ${dim("If that fails")}`);
    for (const alt of plan.alternatives.slice(0, 4)) console.log(`    ${dim("·")} ${alt.summary}${alt.start ? dim(` → ${alt.start}`) : ""}`);
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`\n${red("✗")} ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  },
);
