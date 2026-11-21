import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import type { PipelineContext } from "../../src/pipeline/context";
import { secretFor } from "../../src/pipeline/evidence/envfile";
import { runPlan } from "../../src/pipeline/heuristic";
import type { Plan } from "../../src/pipeline/plan";
import type { Box, ExecResult } from "../../src/sandbox/box";

const ok: ExecResult = { exitCode: 0, output: "", stdout: Buffer.from(""), timedOut: false };

/** The recorded setup of a library (no server): it replays its plan's env as exports in front of every command. */
async function recordedSetup(env: Record<string, string>): Promise<string[]> {
  const ctx: PipelineContext = {
    envId: "e1",
    box: { sh: async () => ok } as unknown as Box,
    signal: new AbortController().signal,
    log: () => {},
    agent: () => {},
    step: () => {},
  };
  const plan: Plan = {
    stack: ["Python"],
    kind: "cli",
    summary: "A Python library.",
    setup: ["pip install -e ."],
    start: null,
    port: null,
    env,
    cwd: "/workspace",
    previewPath: null,
    confidence: "high",
  };
  const outcome = await runPlan(ctx, plan, "detected plan");
  expect(outcome.status).toBe("cli");
  return outcome.setupCommands;
}

// Recipes are shared between accounts: a replay must not hand every account the first account's generated secrets.
describe("a library's recorded setup", () => {
  const generated = {
    SECRET_KEY: secretFor("SECRET_KEY"),
    APP_KEY: secretFor("APP_KEY"),
    APP_KEYS: secretFor("APP_KEYS"),
    SECRET_KEY_BASE: secretFor("SECRET_KEY_BASE"),
  };

  it("generates its app secrets afresh each time it runs instead of carrying the values", async () => {
    const [command] = await recordedSetup({ ...generated, NODE_ENV: "development" });
    for (const value of Object.values(generated)) expect(command).not.toContain(value);
    expect(command).toContain(`export SECRET_KEY="$(od -An -vtx1 -N32 /dev/urandom | tr -d ' \\n')"`);
    expect(command).toContain(`export SECRET_KEY_BASE="$(od -An -vtx1 -N64 /dev/urandom | tr -d ' \\n')"`);
    expect(command).toContain(`export APP_KEY="base64:$(head -c 32 /dev/urandom | base64 -w0)"`);
    expect(command).toContain(`export APP_KEYS="${Array(4).fill("$(head -c 16 /dev/urandom | base64 -w0)").join(",")}"`);
    expect(command).toContain("export NODE_ENV=development");
    expect(command).toMatch(/&& pip install -e \.$/);
  });

  it("keeps a value the repo chose itself", async () => {
    const [command] = await recordedSetup({ JWT_SECRET: "dev secret", SECRET_KEY: "insecure-dev-key" });
    expect(command).toContain("export JWT_SECRET='dev secret'");
    expect(command).toContain("export SECRET_KEY=insecure-dev-key");
  });

  it.runIf(process.platform !== "win32")("prints secrets of the shape the app was set up with", async () => {
    const [command] = await recordedSetup(generated);
    const script = `${command!.replace(/ && pip install -e \.$/, "")} && printf '%s\\n' "$SECRET_KEY" "$SECRET_KEY_BASE" "$APP_KEY" "$APP_KEYS"`;
    const [secretKey, keyBase, appKey, appKeys] = execFileSync("bash", ["-c", script], { encoding: "utf8" }).trim().split("\n");
    expect(secretKey).toMatch(/^[0-9a-f]{64}$/);
    expect(keyBase).toMatch(/^[0-9a-f]{128}$/);
    expect(appKey).toMatch(/^base64:[A-Za-z0-9+/]{43}=$/);
    expect(appKeys).toMatch(/^([A-Za-z0-9+/]{22}==,){3}[A-Za-z0-9+/]{22}==$/);
  });
});
