import { describe, expect, it } from "vitest";
import type { PipelineContext } from "../../src/pipeline/context";
import { runPlan } from "../../src/pipeline/heuristic";
import type { LaunchResult, LaunchSpec } from "../../src/pipeline/launch";
import type { Plan } from "../../src/pipeline/plan";
import type { Box, ExecResult } from "../../src/sandbox/box";

/** A box whose commands answer from a script: the first rule whose pattern matches decides the result. */
class ScriptedBox {
  commands: { command: string; env: Record<string, string> }[] = [];
  constructor(private readonly rules: [RegExp, number, string?][]) {}
  async sh(command: string, opts: { env?: Record<string, string> } = {}): Promise<ExecResult> {
    this.commands.push({ command, env: opts.env ?? {} });
    const rule = this.rules.find(([re]) => re.test(command));
    const [, exitCode, output = ""] = rule ?? [/./, 0, ""];
    return { exitCode, output, stdout: Buffer.from(output), timedOut: false };
  }
  ran(): string[] {
    return this.commands.map((c) => c.command);
  }
}

/** Launches answer by start command, in order of the rules. */
function scriptedLaunch(rules: [RegExp, Partial<LaunchResult>][]) {
  const launches: LaunchSpec[] = [];
  const launch = async (_box: Box, spec: LaunchSpec): Promise<LaunchResult> => {
    launches.push(structuredClone(spec));
    const rule = rules.find(([re]) => re.test(spec.command))?.[1] ?? {};
    return {
      ok: false,
      port: null,
      httpStatus: null,
      reason: "The process exited before opening a port.",
      logTail: "",
      listeners: [],
      ...rule,
    };
  };
  return { launch, launches };
}

const up = (port: number): Partial<LaunchResult> => ({ ok: true, port, httpStatus: 200, reason: null });

function context(box: ScriptedBox, stats: Record<string, { key: string; successes: number; failures: number }[]> = {}) {
  const events: { kind: string; text: string }[] = [];
  const steps: string[] = [];
  const recorded: string[] = [];
  const ctx: PipelineContext = {
    envId: "e1",
    box: box as unknown as Box,
    signal: new AbortController().signal,
    log: () => {},
    agent: (kind, text) => events.push({ kind, text }),
    step: (step, state) => steps.push(`${step}:${state}`),
    learning: {
      stats: (scope: string) => stats[scope] ?? [],
      record: (scope: string, key: string, ok: boolean) => recorded.push(`${scope} ${key} ${ok ? "ok" : "fail"}`),
    } as unknown as PipelineContext["learning"],
  };
  return { ctx, events, steps, recorded };
}

const plan = (over: Partial<Plan>): Plan => ({
  stack: ["Node.js"],
  kind: "web",
  summary: "Node.js app.",
  setup: ["npm install --no-audit --no-fund"],
  start: "npm run dev",
  port: 3000,
  env: { PORT: "3000" },
  cwd: "/workspace",
  previewPath: null,
  confidence: "high",
  strategy: "framework",
  prior: 0.8,
  signature: "node:vite:npm",
  ...over,
});

describe("runPlan", () => {
  it("repairs a failing install and keeps the fix in the recipe", async () => {
    const box = new ScriptedBox([
      [/--legacy-peer-deps/, 0],
      [/^npm install/, 1, "npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree"],
    ]);
    const { launch } = scriptedLaunch([[/npm run dev/, up(5173)]]);
    const { ctx, events, recorded } = context(box);
    const outcome = await runPlan(ctx, plan({}), "detected plan", { launch });

    expect(outcome.status).toBe("running");
    expect(outcome.port).toBe(5173);
    expect(outcome.setupCommands).toEqual(["npm install --no-audit --no-fund --legacy-peer-deps"]);
    expect(events.some((e) => e.kind === "thought" && /--legacy-peer-deps/.test(e.text))).toBe(true);
    expect(recorded).toEqual(["repair npm-peer-deps ok", "strategy:node:vite:npm framework ok", "strategy:node framework ok"]);
  });

  it("installs a missing header before retrying the same command", async () => {
    const box = new ScriptedBox([
      [/apt-get install .*libffi-dev/, 0],
      [/^uv pip install/, 1, "c/_cffi_backend.c:15:10: fatal error: ffi.h: No such file or directory"],
    ]);
    let headerInstalled = false;
    const sh = box.sh.bind(box);
    box.sh = async (command, opts) => {
      if (/libffi-dev/.test(command)) headerInstalled = true;
      if (/^uv pip install/.test(command) && headerInstalled) return { exitCode: 0, output: "", stdout: Buffer.from(""), timedOut: false };
      return sh(command, opts);
    };
    const { launch } = scriptedLaunch([[/./, up(8000)]]);
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ setup: ["uv pip install -r requirements.txt"], start: "python app.py", strategy: undefined, signature: undefined }), "detected plan", { launch });
    expect(outcome.status).toBe("running");
    expect(outcome.setupCommands).toEqual(["apt-get update -qq && apt-get install -y --no-install-recommends libffi-dev", "uv pip install -r requirements.txt"]);
  });

  it("reads the log after a failed launch, fixes it, and relaunches with the fix", async () => {
    const box = new ScriptedBox([]);
    let attempts = 0;
    const launches: LaunchSpec[] = [];
    const launch = async (_box: Box, spec: LaunchSpec): Promise<LaunchResult> => {
      launches.push(structuredClone(spec));
      attempts++;
      if (attempts === 1) return { ok: false, port: null, httpStatus: null, reason: "The process exited before opening a port.", logTail: "ModuleNotFoundError: No module named 'dotenv'", listeners: [] };
      if (attempts === 2) return { ok: false, port: null, httpStatus: null, reason: "The process exited before opening a port.", logTail: "KeyError: 'SECRET_KEY'", listeners: [] };
      return { ok: true, port: 5000, httpStatus: 200, reason: null, logTail: "", listeners: [] };
    };
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ setup: [], start: "python app.py", env: {} }), "detected plan", { launch });
    expect(outcome.status).toBe("running");
    expect(box.ran()).toEqual(["uv pip install python-dotenv || pip install python-dotenv"]);
    expect(outcome.setupCommands).toEqual(["uv pip install python-dotenv || pip install python-dotenv"]);
    expect(launches[2]?.env.SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    // The recipe's start env carries the placeholder, so a replay boots the same way.
    expect(outcome.start?.env.SECRET_KEY).toBe(launches[2]?.env.SECRET_KEY);
    expect(outcome.notes.join(" ")).toMatch(/It needs SECRET_KEY/);
  });

  it("moves a server that hits a taken port", async () => {
    const box = new ScriptedBox([]);
    const { launch, launches } = scriptedLaunch([[/--port 8001/, up(8001)], [/./, { logTail: "ERROR: [Errno 98] error while attempting to bind on address ('0.0.0.0', 8000): address already in use" }]]);
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ setup: [], start: "uvicorn main:app --port 8000", port: 8000, env: {} }), "detected plan", { launch });
    expect(outcome.status).toBe("running");
    expect(launches.map((l) => l.command)).toEqual(["uvicorn main:app --port 8000", "uvicorn main:app --port 8001"]);
    expect(outcome.start).toMatchObject({ command: "uvicorn main:app --port 8001", env: { PORT: "8001" } });
  });

  it("falls through to the next plan, reusing what already installed", async () => {
    const box = new ScriptedBox([]);
    const { launch, launches } = scriptedLaunch([
      [/npm run dev:all/, up(3000)],
      [/npm run dev/, { logTail: "Error: something only the authors understand" }],
    ]);
    const { ctx, events, steps, recorded } = context(box);
    const primary = plan({
      alternatives: [plan({ strategy: "readme", prior: 0.65, confidence: "medium", start: "npm run dev:all", setup: ["npm install --no-audit --no-fund", "npm run build:lib"], rationale: "The README.md says `npm run dev:all`. Trying that." })],
    });
    const outcome = await runPlan(ctx, primary, "detected plan", { launch });

    expect(outcome.status).toBe("running");
    expect(outcome.start?.command).toBe("npm run dev:all");
    expect(launches.map((l) => l.command)).toEqual(["npm run dev", "npm run dev:all"]);
    // npm install ran once; the second plan's recipe still includes it.
    expect(box.ran()).toEqual(["npm install --no-audit --no-fund", "npm run build:lib"]);
    expect(outcome.setupCommands).toEqual(["npm install --no-audit --no-fund", "npm run build:lib"]);
    expect(steps).toEqual(["install:active", "install:done", "launch:active", "launch:failed", "install:pending", "launch:pending", "install:active", "install:done", "launch:active", "launch:done"]);
    expect(events.filter((e) => e.kind === "thought").map((e) => e.text)).toContain("The README.md says `npm run dev:all`. Trying that.");
    expect(recorded).toEqual([
      "strategy:node:vite:npm framework fail",
      "strategy:node framework fail",
      "strategy:node:vite:npm readme ok",
      "strategy:node readme ok",
    ]);
  });

  it("tries what has worked before for this kind of project first", async () => {
    const box = new ScriptedBox([]);
    const { launch, launches } = scriptedLaunch([[/./, up(3000)]]);
    const { ctx } = context(box, { "strategy:node:vite:npm": [{ key: "framework", successes: 0, failures: 8 }, { key: "readme", successes: 6, failures: 0 }] });
    const primary = plan({ alternatives: [plan({ strategy: "readme", prior: 0.65, start: "npm run dev:all" })] });
    await runPlan(ctx, primary, "detected plan", { launch });
    expect(launches.map((l) => l.command)).toEqual(["npm run dev:all"]);
  });

  it("stops after three plans and says what it tried", async () => {
    const box = new ScriptedBox([]);
    const { launch, launches } = scriptedLaunch([]);
    const { ctx } = context(box);
    const alt = (strategy: string, start: string, prior: number) => plan({ strategy, start, prior });
    const primary = plan({ alternatives: [alt("readme", "a", 0.7), alt("procfile", "b", 0.6), alt("makefile", "c", 0.55)] });
    const outcome = await runPlan(ctx, primary, "detected plan", { launch });
    expect(outcome.status).toBe("failed");
    expect(launches).toHaveLength(3);
    expect(outcome.error).toMatch(/^Pyrovue tried 3 ways to run this \(framework defaults, README, Procfile\)\. The last one failed\./);
  });

  it("skips plans that need a command that already failed for good", async () => {
    const box = new ScriptedBox([[/^npm install/, 1, "npm error 404 Not Found - GET https://registry.npmjs.org/@private%2fpkg"]]);
    const { launch, launches } = scriptedLaunch([[/./, up(3000)]]);
    const { ctx } = context(box);
    const primary = plan({ alternatives: [plan({ strategy: "readme", prior: 0.6, start: "npm run dev:all" }), plan({ strategy: "dockerfile", prior: 0.5, setup: ["pnpm install"], start: "node server.js" })] });
    const outcome = await runPlan(ctx, primary, "detected plan", { launch });
    expect(box.ran()).toEqual(["npm install --no-audit --no-fund", "pnpm install"]);
    expect(launches.map((l) => l.command)).toEqual(["node server.js"]);
    expect(outcome.status).toBe("running");
  });

  it("stops repairing after the budget", async () => {
    const box = new ScriptedBox([[/./, 1, "ModuleNotFoundError: No module named 'x1'"]]);
    let n = 0;
    box.sh = async (command) => {
      box.commands.push({ command, env: {} });
      n++;
      return { exitCode: /pip install mod/.test(command) ? 0 : 1, output: `ModuleNotFoundError: No module named 'mod${n}'`, stdout: Buffer.from(""), timedOut: false };
    };
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ setup: ["python setup_db.py"], start: null }), "detected plan", { launch: scriptedLaunch([]).launch, maxRepairs: 3 });
    expect(outcome.status).toBe("failed");
    expect(box.ran().filter((c) => c === "python setup_db.py")).toHaveLength(4);
  });

  it("treats a low-confidence guess that serves nothing as a library", async () => {
    const box = new ScriptedBox([]);
    const { launch } = scriptedLaunch([]);
    const { ctx, steps } = context(box);
    const outcome = await runPlan(ctx, plan({ confidence: "low", start: "python main.py", setup: ["uv pip install -e ."] }), "detected plan", { launch });
    expect(outcome).toMatchObject({ status: "cli", kind: "cli", start: null, error: null });
    expect(outcome.notes[0]).toMatch(/didn't start a server/);
    expect(steps.at(-1)).toBe("launch:skipped");
  });

  it("makes a CLI outcome's setup replayable from /workspace without the plan's env", async () => {
    const box = new ScriptedBox([]);
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ cwd: "/workspace/packages/cli", env: { NODE_ENV: "development" }, setup: ["npm install"], start: null }), "detected plan", {
      launch: scriptedLaunch([]).launch,
    });
    expect(outcome).toMatchObject({ status: "cli", setupCommands: ["cd packages/cli && export NODE_ENV=development && npm install"] });
    // In this box the command itself still runs plainly, from the plan's cwd.
    expect(box.ran()).toEqual(["npm install"]);
  });

  it("ends a plan without a start as cli, with a note that there is no preview", async () => {
    const box = new ScriptedBox([]);
    const { launch, launches } = scriptedLaunch([[/./, up(3000)]]);
    const { ctx, steps } = context(box);
    const outcome = await runPlan(ctx, plan({ start: null, port: null, notes: [] }), "detected plan", { launch });
    expect(outcome).toMatchObject({ status: "cli", kind: "cli", start: null });
    expect(outcome.notes.join(" ")).toMatch(/didn't find a web server/);
    expect(outcome.notes).toEqual(["Pyrovue didn't find a web server in this repo, so there is no preview. Everything is installed: open a shell in the box to use it."]);
    expect(launches).toEqual([]);
    expect(steps).toContain("launch:skipped");
  });

  it("doesn't repeat that there is no web server when a note already says so", async () => {
    const box = new ScriptedBox([]);
    const { ctx } = context(box);
    const said = "This is a Rust workspace with 14 programs and no web server, so there is nothing to preview.";
    const outcome = await runPlan(ctx, plan({ start: null, port: null, notes: [said] }), "detected plan", { launch: scriptedLaunch([]).launch });
    expect(outcome.notes).toEqual([said]);
  });

  it("replays a cached recipe as a single plan", async () => {
    const box = new ScriptedBox([]);
    const { launch } = scriptedLaunch([[/./, up(4321)]]);
    const { ctx, recorded } = context(box);
    const recipe = plan({ strategy: undefined, signature: undefined, prior: undefined, setup: ["pnpm install", "pnpm build"], start: "pnpm preview" });
    const result = await runPlan(ctx, recipe, "cached recipe", { launch });
    expect(result).toMatchObject({ status: "running", port: 4321, setupCommands: ["pnpm install", "pnpm build"] });
    // A recipe isn't a strategy, so nothing is learned from it.
    expect(recorded).toEqual([]);
  });

  it("copies the keys the plan needs into the outcome", async () => {
    const box = new ScriptedBox([]);
    const { ctx } = context(box);
    const needs = [{ file: ".env", keys: ["OPENAI_API_KEY"] }];
    const outcome = await runPlan(ctx, plan({ needs }), "detected plan", { launch: scriptedLaunch([[/./, up(3000)]]).launch });
    expect(outcome.needs).toEqual(needs);
    const none = await runPlan(context(new ScriptedBox([])).ctx, plan({}), "detected plan", { launch: scriptedLaunch([[/./, up(3000)]]).launch });
    expect(none.needs).toEqual([]);
  });
});

describe("runPlan with a backend in the background", () => {
  const backend = { name: "FastAPI in backend/", cwd: "/workspace/backend", command: "uvicorn main:app --host 0.0.0.0 --port 8000 --reload", port: 8000 };
  const both = plan({
    strategy: "framework:both",
    cwd: "/workspace/frontend",
    port: 5173,
    env: { PORT: "5173" },
    services: [backend],
    start: "(cd /workspace/backend && PORT=8000 uvicorn main:app --host 0.0.0.0 --port 8000 --reload) & npm run dev",
  });
  const at = (...ports: number[]) => ports.map((port) => ({ port, address: "0.0.0.0", family: "4" as const }));

  it("says the backend is running too, and never relays to it", async () => {
    const { launch, launches } = scriptedLaunch([[/npm run dev/, { ...up(5173), listeners: at(8000, 5173) }]]);
    const { ctx } = context(new ScriptedBox([]));
    const outcome = await runPlan(ctx, both, "detected plan", { launch });
    expect(outcome.status).toBe("running");
    expect(launches[0]?.ignorePorts).toEqual([8000]);
    expect(outcome.notes).toContain(
      "Also running: FastAPI in backend/ on port 8000. The preview shows the frontend. API calls reach it through the frontend's dev server proxy.",
    );
    // The recipe replays both: the start command is the combined one.
    expect(outcome.start?.command).toBe(both.start);
    expect(outcome.port).toBe(5173);
  });

  it("tells the user when the backend didn't come up, without failing the setup", async () => {
    const { launch } = scriptedLaunch([[/npm run dev/, { ...up(5173), listeners: at(5173) }]]);
    const { ctx } = context(new ScriptedBox([]));
    const outcome = await runPlan(ctx, both, "detected plan", { launch });
    expect(outcome.status).toBe("running");
    const said = outcome.notes.join(" ");
    expect(said).toMatch(/Only the frontend is running/);
    expect(said).toMatch(/cd backend && uvicorn/);
    expect(outcome.notes).toContain(
      "Only the frontend is running. FastAPI in backend/ didn't open port 8000; its output is in the logs. Start it from the terminal with `cd backend && uvicorn main:app --host 0.0.0.0 --port 8000 --reload`.",
    );
  });

  it("names a watcher without a port plainly, and a server in front of its watcher without the frontend's words", async () => {
    const { launch, launches } = scriptedLaunch([[/./, { ...up(8000), listeners: at(8000) }]]);
    const { ctx } = context(new ScriptedBox([]));
    const django = plan({
      stack: ["Python", "Django"],
      port: 8000,
      env: { PORT: "8000" },
      services: [
        { name: "Vite in frontend/", cwd: "/workspace/frontend", command: "npm run dev", port: 5173 },
        { name: "`npm run tailwind` in the repo root", cwd: "/workspace", command: "npm run tailwind", port: null },
      ],
      start: "(cd /workspace/frontend && PORT=5173 npm run dev) & (cd /workspace && npm run tailwind) & python manage.py runserver 0.0.0.0:8000",
    });
    const outcome = await runPlan(ctx, django, "detected plan", { launch });
    expect(launches[0]?.ignorePorts).toEqual([5173]);
    expect(outcome.notes).toEqual([
      "Vite in frontend/ didn't open port 5173; its output is in the logs. Start it from the terminal with `cd frontend && npm run dev`.",
      "Also running: `npm run tailwind` in the repo root.",
    ]);
  });

  it("doesn't skip a port that is only Pyrovue's guess for the backend, since the frontend may be the one on it", async () => {
    // A Vite frontend whose env file moves it to 8080, next to a Go server told PORT=8080 that listens on 8888.
    const { launch, launches } = scriptedLaunch([[/npm run dev/, { ...up(8080), listeners: at(8080, 8888) }]]);
    const go = { name: "Go in server/", cwd: "/workspace/server", command: "go run .", port: 8080, portGuessed: true as const };
    const outcome = await runPlan(context(new ScriptedBox([])).ctx, plan({ port: 5173, env: { PORT: "5173" }, services: [go], start: "(cd /workspace/server && PORT=8080 go run .) & npm run dev" }), "detected plan", { launch });
    expect(outcome.status).toBe("running");
    // An empty list, not none: the launch would otherwise read PORT=8080 from the start command and skip it.
    expect(launches[0]?.ignorePorts).toEqual([]);
    // 8080 is the frontend, so nothing is said about the backend being there, nor that only the frontend runs.
    expect(outcome.notes).toEqual(["Go in server/ didn't open port 8080, the one Pyrovue gave it: it may use a port of its own, or have stopped. Its output is in the logs."]);
  });

  it("still skips a port a service's own command sets, when the plan gives it none", async () => {
    const { launch, launches } = scriptedLaunch([[/npm run dev/, up(5173)]]);
    const api = { name: "`PORT=4000 node api.js` in api/", cwd: "/workspace/api", command: "PORT=4000 node api.js", port: null };
    await runPlan(context(new ScriptedBox([])).ctx, plan({ port: 5173, services: [api], start: "(cd /workspace/api && PORT=4000 node api.js) & npm run dev" }), "detected plan", { launch });
    expect(launches[0]?.ignorePorts).toEqual([4000]);
  });

  it("leaves the launch spec as it was for a plan without services", async () => {
    const { launch, launches } = scriptedLaunch([[/./, up(3000)]]);
    await runPlan(context(new ScriptedBox([])).ctx, plan({}), "detected plan", { launch });
    expect(launches[0]).not.toHaveProperty("ignorePorts");
  });
});

describe("runPlan when plans disagree", () => {
  it("reports a confident server's failure instead of a guess that served nothing", async () => {
    const box = new ScriptedBox([]);
    const { launch } = scriptedLaunch([[/npm run dev/, { reason: "Port 5173 is open but never answered HTTP." }]]);
    const { ctx } = context(box);
    const guess = plan({ confidence: "low", start: "node index.js", strategy: "readme", prior: 0.3, setup: [] });
    const outcome = await runPlan(ctx, plan({ setup: [], alternatives: [guess] }), "detected plan", { launch });
    // Not a "cli": that would end the run and record a setup that never starts the app.
    expect(outcome.status).toBe("failed");
    expect(outcome.error).toMatch(/None of them started a server[\s\S]*never answered HTTP/);
  });

  it("still treats a guess as a library when nothing more likely failed to serve", async () => {
    const box = new ScriptedBox([]);
    const { launch } = scriptedLaunch([]);
    const { ctx } = context(box);
    const outcome = await runPlan(ctx, plan({ confidence: "low", start: "node index.js", setup: [], alternatives: [plan({ confidence: "low", start: "node cli.js", setup: [], strategy: "readme", prior: 0.6 })] }), "detected plan", { launch });
    expect(outcome.status).toBe("cli");
  });

  it("stops without learning from a command that returned after the setup was cancelled", async () => {
    const controller = new AbortController();
    const box = new ScriptedBox([]);
    box.sh = async () => {
      // The box was stopped under the install, which then exits 137.
      controller.abort(new Error("cancelled"));
      return { exitCode: 137, output: "Killed", stdout: Buffer.from("Killed"), timedOut: false };
    };
    const { launch, launches } = scriptedLaunch([[/./, up(3000)]]);
    const { ctx, recorded } = context(box);
    ctx.signal = controller.signal;
    await expect(runPlan(ctx, plan({}), "detected plan", { launch })).rejects.toThrow("cancelled");
    expect(recorded).toEqual([]);
    expect(launches).toEqual([]);
  });
});
