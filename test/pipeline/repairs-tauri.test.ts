import { describe, expect, it } from "vitest";
import { runPlan } from "../../src/pipeline/heuristic";
import type { PipelineContext } from "../../src/pipeline/context";
import type { LaunchResult, LaunchSpec } from "../../src/pipeline/launch";
import type { Plan } from "../../src/pipeline/plan";
import { rankRepairs } from "../../src/pipeline/ranking";
import { matchRepairs } from "../../src/pipeline/repairs";
import type { Box } from "../../src/sandbox/box";

/** The log from the report, as the launch hands it back. */
const REPORT_LOG = `> mathterm@0.1.2 start
> tauri dev

failed to run 'cargo metadata' command to get workspace directory: failed to run command cargo metadata --no-deps --format-version 1: No such file or directory (os error 2)
       Error failed to run 'cargo metadata' command to get workspace directory: failed to run command cargo metadata --no-deps --format-version 1: No such file or directory (os error 2)`;
const REASON = "The process exited before opening a port.";

const plan = (over: Partial<Plan> = {}): Plan => ({
  stack: ["Node.js", "Vite", "Tauri", "npm"],
  kind: "web",
  summary: "",
  setup: [],
  start: "npm run start",
  port: 5173,
  env: {},
  cwd: "/workspace",
  previewPath: null,
  confidence: "high",
  facts: { pm: "npm", scripts: ["dev", "build", "start", "tauri"], tauri: { start: "npm run dev", port: 1420 } },
  ...over,
});

const best = (command: string, output: string, p: Plan = plan()) => {
  const m = matchRepairs("launch", command, `${output}\n${REASON}`, p)[0];
  return m ? { id: m.rule.id, ...m.fix } : null;
};

describe("repair: a Tauri start that cannot find Rust", () => {
  it("switches the start to the web frontend, with its port, on the report's log", () => {
    expect(best("npm run start", REPORT_LOG)).toMatchObject({ id: "tauri-no-rust", retry: "npm run dev", port: 1420, env: { PORT: "1420" } });
  });

  it("says in the plan's notes what runs and what does not", () => {
    const fix = best("npm run start", REPORT_LOG);
    expect(fix?.planNote).toMatch(/Tauri desktop app\. Pyrovue runs its web page/);
    expect(fix?.planNote).toMatch(/Rust/);
    expect(`${fix?.note} ${fix?.planNote}`).not.toMatch(/[–—]/);
  });

  it.each([
    ["cargo not found", "> tauri dev\nsh: 1: cargo: not found"],
    ["cargo command not found", "> tauri dev\nbash: cargo: command not found"],
    ["cargo tauri", "$ cargo tauri dev\nerror: no such command: `tauri`\nbash: cargo: command not found"],
    ["rustc missing", "> tauri dev\nfailed to run command rustc --print sysroot: No such file or directory (os error 2)"],
    ["rustc not found", "> tauri dev\nsh: 1: rustc: not found"],
  ])("also recognises %s", (_name, log) => {
    expect(best("npm run start", log)).toMatchObject({ id: "tauri-no-rust", retry: "npm run dev" });
  });

  it("goes ahead of installing Rust for the missing cargo", () => {
    const ranked = rankRepairs(matchRepairs("launch", "npm run start", `> tauri dev\nsh: 1: cargo: not found\n${REASON}`, plan()), undefined);
    expect(ranked[0]?.rule.id).toBe("tauri-no-rust");
  });

  it("uses the package manager of the plan", () => {
    const p = plan({ facts: { pm: "pnpm", scripts: ["dev", "start"], tauri: { start: "pnpm run dev", port: null } } });
    expect(best("pnpm run start", REPORT_LOG, p)).toMatchObject({ retry: "pnpm run dev" });
    expect(best("pnpm run start", REPORT_LOG, p)?.port).toBeUndefined();
  });

  it("picks a listed script for a plan that did not come from the detector", () => {
    const known = plan({ facts: { pm: "npm", scripts: ["start", "serve", "tauri"] } });
    expect(best("npm start", REPORT_LOG, known)).toMatchObject({ retry: "npm run serve" });
  });

  it("does not guess a dev script when the plan does not list its scripts", () => {
    const aiPlan = plan({ facts: undefined, start: "yarn start" });
    expect(best("yarn start", REPORT_LOG, aiPlan)?.id).not.toBe("tauri-no-rust");
  });

  it("does not go back to a start that already failed", () => {
    const facts = { pm: "npm" as const, scripts: ["dev", "start", "tauri"] };
    const first = best("npm run start", REPORT_LOG, plan({ facts }));
    expect(first).toMatchObject({ id: "tauri-no-rust", retry: "npm run dev" });
    const second = best("npm run dev", REPORT_LOG, plan({ facts: { ...facts, tried: ["npm run start", "npm run dev"] } }));
    expect(second?.id).not.toBe("tauri-no-rust");
  });

  it("does nothing when the project has no frontend to run", () => {
    expect(best("npm run start", REPORT_LOG, plan({ facts: { pm: "npm", scripts: ["start"], tauri: { start: null, port: null } } }))?.id).not.toBe("tauri-no-rust");
  });

  it("leaves other failures, and a missing Rust that has nothing to do with Tauri, alone", () => {
    const ids = (command: string, log: string) => matchRepairs("launch", command, log, plan()).map((m) => m.rule.id);
    expect(ids("npm run dev", "Error: Cannot find module 'left-pad'")).not.toContain("tauri-no-rust");
    expect(ids("cargo run", "bash: cargo: command not found")).not.toContain("tauri-no-rust");
    expect(ids("npm run dev", "> vite\nVITE v6 ready")).not.toContain("tauri-no-rust");
  });

  it("does not offer to retry the command that already is the frontend", () => {
    expect(matchRepairs("launch", "npm run dev", REPORT_LOG, plan()).map((m) => m.rule.id)).not.toContain("tauri-no-rust");
  });
});

describe("runPlan: a plan that still starts the native shell", () => {
  const ctxFor = () => {
    const events: { kind: string; text: string }[] = [];
    const ctx = {
      envId: "e1",
      box: { sh: async () => ({ exitCode: 0, output: "", stdout: Buffer.from(""), timedOut: false }) } as unknown as Box,
      signal: new AbortController().signal,
      log: () => {},
      agent: (kind: string, text: string) => events.push({ kind, text }),
      step: () => {},
      learning: { stats: () => [], record: () => {} } as unknown as PipelineContext["learning"],
    } as unknown as PipelineContext;
    return { ctx, events };
  };

  it("relaunches the web page and keeps the note and the new start in the outcome", async () => {
    const launches: LaunchSpec[] = [];
    const launch = async (_box: Box, spec: LaunchSpec): Promise<LaunchResult> => {
      launches.push(structuredClone(spec));
      return /tauri/.test(`${spec.command}`) || spec.command === "npm run start"
        ? { ok: false, port: null, httpStatus: null, reason: REASON, logTail: REPORT_LOG, listeners: [] }
        : { ok: true, port: 1420, httpStatus: 200, reason: null, logTail: "", listeners: [] };
    };
    const { ctx } = ctxFor();
    const outcome = await runPlan(ctx, plan(), "detected plan", { launch });
    expect(launches.map((l) => l.command)).toEqual(["npm run start", "npm run dev"]);
    expect(launches[1]?.port).toBe(1420);
    expect(outcome).toMatchObject({ status: "running", port: 1420, start: { command: "npm run dev" } });
    expect(outcome.notes.join(" ")).toMatch(/Tauri desktop app\. Pyrovue runs its web page/);
  });
});
