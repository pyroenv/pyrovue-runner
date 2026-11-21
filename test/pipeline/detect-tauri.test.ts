import { describe, expect, it } from "vitest";
import { detect, type Plan } from "../../src/pipeline/detect";
import { selectKeyFiles } from "../../src/pipeline/snapshot";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const json = (v: object) => JSON.stringify(v);

/** The project in the report: a Tauri 2 app whose "start" script is `tauri dev`. */
const mathterm = (over: Record<string, unknown> = {}) =>
  json({
    name: "mathterm",
    version: "0.1.2",
    scripts: { dev: "vite", build: "tsc && vite build", start: "tauri dev", tauri: "tauri" },
    dependencies: { "@tauri-apps/api": "^2" },
    devDependencies: { "@tauri-apps/cli": "^2", vite: "^6", typescript: "^5" },
    ...over,
  });
const conf2 = (build: object) => json({ productName: "mathterm", version: "0.1.2", build });
const REPORT_CONF = conf2({ beforeDevCommand: "npm run dev", devUrl: "http://localhost:1420", beforeBuildCommand: "npm run build", frontendDist: "../dist" });

/** Every start the plan and its fallbacks would try. */
const starts = (plan: Plan) => [plan, ...(plan.alternatives ?? [])].map((p) => p.start).filter((s): s is string => s !== null);
const runsTauri = (command: string) => /\btauri\b/.test(command);
const NOTE = /Tauri desktop app/;

describe("detect: Tauri", () => {
  it("starts the web page of the project in the report, never `tauri dev`", () => {
    const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": REPORT_CONF, "src-tauri/Cargo.toml": '[package]\nname = "mathterm"\n' }));
    expect(plan).toMatchObject({ kind: "web", start: "npm run dev", port: 1420, cwd: "/workspace" });
    expect(plan.stack).toEqual(expect.arrayContaining(["Node.js", "Vite", "Tauri", "npm"]));
    expect(starts(plan).filter(runsTauri)).toEqual([]);
    expect(plan.setup).toEqual(["npm install --no-audit --no-fund"]);
  });

  it("says what runs and what does not, in the plan's summary and notes", () => {
    const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": REPORT_CONF }));
    expect(plan.summary).toMatch(NOTE);
    const notes = (plan.notes ?? []).join(" ");
    expect(notes).toMatch(NOTE);
    expect(notes).toMatch(/Pyrovue runs its web page/);
    expect(notes).toMatch(/Rust/);
    expect(`${plan.summary} ${notes}`).not.toMatch(/[–—]/);
  });

  it("reads Tauri 1: devPath and beforeDevCommand", () => {
    const plan = detect(
      snap({
        "package.json": json({ scripts: { dev: "vite", start: "tauri dev" }, devDependencies: { "@tauri-apps/cli": "^1.5", vite: "^5" } }),
        "src-tauri/tauri.conf.json": json({ build: { beforeDevCommand: "npm run dev", devPath: "http://localhost:3000", distDir: "../dist" } }),
      }),
    );
    expect(plan).toMatchObject({ start: "npm run dev", port: 3000 });
    expect(plan.env.PORT).toBe("3000");
  });

  it("ignores a devPath that is a folder, and keeps the dev server's own port", () => {
    const plan = detect(
      snap({
        "package.json": json({ scripts: { dev: "vite" }, devDependencies: { "@tauri-apps/cli": "^1.5", vite: "^5" } }),
        "src-tauri/tauri.conf.json": json({ build: { beforeDevCommand: "npm run dev", devPath: "../dist" } }),
      }),
    );
    expect(plan).toMatchObject({ start: "npm run dev", port: 5173 });
  });

  it("takes a beforeDevCommand written as an object (script and cwd)", () => {
    const plan = detect(
      snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": conf2({ beforeDevCommand: { script: "npm run dev", cwd: ".." }, devUrl: "http://127.0.0.1:1420/" }) }),
    );
    expect(plan).toMatchObject({ start: "npm run dev", port: 1420, cwd: "/workspace" });
  });

  it.each([
    ["pnpm", "pnpm dev", ["pnpm-lock.yaml"], "pnpm run dev"],
    ["yarn", "yarn dev", ["yarn.lock"], "yarn run dev"],
    ["bun", "bun run dev", ["bun.lock"], "bun run dev"],
    ["pnpm project, npm in the config", "npm run dev", ["pnpm-lock.yaml"], "pnpm run dev"],
  ])("%s projects: %s", (_name, before, lock, expected) => {
    const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": conf2({ beforeDevCommand: before, devUrl: "http://localhost:1420" }) }, lock));
    expect(plan.start).toBe(expected);
    expect(plan.port).toBe(1420);
  });

  it("without a beforeDevCommand, picks the frontend script in the usual order and never one that runs tauri", () => {
    const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": conf2({ devUrl: "http://localhost:1420" }) }));
    expect(plan.start).toBe("npm run dev");
    const serveOnly = detect(
      snap({
        "package.json": json({ scripts: { start: "tauri dev", serve: "vite --port 1420" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } }),
        "src-tauri/tauri.conf.json": conf2({}),
      }),
    );
    expect(serveOnly.start).toBe("npm run serve");
  });

  it("follows one level of indirection when a script only calls another that runs tauri", () => {
    const plan = detect(
      snap({
        "package.json": json({ scripts: { dev: "npm run tauri dev", start: "pnpm run desktop", desktop: "cargo tauri dev", serve: "vite" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } }),
        "src-tauri/tauri.conf.json": conf2({}),
      }),
    );
    expect(plan.start).toBe("npm run serve");
    expect(starts(plan).filter(runsTauri)).toEqual([]);
  });

  it("does not take a beforeDevCommand that itself runs tauri", () => {
    const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": conf2({ beforeDevCommand: "npm run tauri dev" }) }));
    expect(plan.start).toBe("npm run dev");
  });

  it("says there is nothing to run when `tauri dev` is the only way to start", () => {
    const plan = detect(
      snap({
        "package.json": json({ name: "shell", scripts: { start: "tauri dev", tauri: "tauri" }, devDependencies: { "@tauri-apps/cli": "^2" } }),
        "src-tauri/tauri.conf.json": conf2({ devUrl: "http://localhost:1420" }),
      }),
    );
    expect(plan).toMatchObject({ start: null, port: null, kind: "cli", confidence: "low" });
    expect(plan.stack).toContain("Tauri");
    expect((plan.notes ?? []).join(" ")).toMatch(/Tauri desktop app.*nothing to run/);
    expect(starts(plan)).toEqual([]);
  });

  it("does not throw on a config that is not valid JSON, and falls back to the scripts", () => {
    for (const text of ["{ not json", "", "[1, 2]", "null", '{"build": "oops"}', '{"build": {"beforeDevCommand": 7, "devUrl": {"a": 1}}}']) {
      const plan = detect(snap({ "package.json": mathterm(), "src-tauri/tauri.conf.json": text }));
      expect(plan.start).toBe("npm run dev");
      expect(plan.stack).toContain("Tauri");
    }
  });

  it("reads comments and trailing commas in tauri.conf.json5, and Tauri.toml", () => {
    const json5 = detect(
      snap({
        "package.json": mathterm({ scripts: { serve: "vite --port 4000", start: "tauri dev" } }),
        "src-tauri/tauri.conf.json5": '{\n  // the web page\n  "build": { "beforeDevCommand": "npm run serve", "devUrl": "http://localhost:4000", },\n}',
      }),
    );
    expect(json5).toMatchObject({ start: "npm run serve", port: 4000 });
    const toml = detect(
      snap({
        "package.json": json({ scripts: { serve: "vite", start: "tauri dev" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } }),
        "src-tauri/Tauri.toml": '[build]\nbefore-dev-command = "npm run serve"\ndev-url = "http://localhost:4000"\n',
      }),
    );
    expect(toml).toMatchObject({ start: "npm run serve", port: 4000 });
  });

  it("recognises a project by its config alone, with no Tauri package", () => {
    const plan = detect(snap({ "package.json": json({ scripts: { dev: "vite", start: "tauri dev" }, devDependencies: { vite: "^6" } }), "src-tauri/tauri.conf.json": REPORT_CONF }));
    expect(plan.stack).toContain("Tauri");
    expect(plan.start).toBe("npm run dev");
  });

  it("recognises a project by its package alone, with no config in the snapshot", () => {
    const plan = detect(snap({ "package.json": mathterm() }));
    expect(plan.stack).toContain("Tauri");
    expect(plan.start).toBe("npm run dev");
    expect(plan.port).toBe(5173);
  });

  it("finds the project when its package.json sits in a subfolder", () => {
    const plan = detect(
      snap({
        "frontend/package.json": mathterm(),
        "frontend/src-tauri/tauri.conf.json": conf2({ beforeDevCommand: "pnpm dev", devUrl: "http://localhost:1420" }),
        "frontend/pnpm-lock.yaml": "",
      }),
    );
    expect(plan).toMatchObject({ cwd: "/workspace/frontend", start: "pnpm run dev", port: 1420 });
    expect(plan.stack).toContain("Tauri");
    expect(plan.summary).toMatch(NOTE);
  });

  it("finds it when the Tauri folder is at the root and the web app is in a subfolder", () => {
    const plan = detect(
      snap({
        "src-tauri/tauri.conf.json": conf2({ beforeDevCommand: "npm run dev", devUrl: "http://localhost:1420" }),
        "src-tauri/Cargo.toml": '[package]\nname = "app"\n',
        "ui/package.json": json({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }),
      }),
    );
    expect(plan).toMatchObject({ cwd: "/workspace/ui", start: "npm run dev", port: 1420 });
    expect(plan.stack).toContain("Tauri");
  });

  it("leaves other Node projects as they were", () => {
    const plan = detect(snap({ "package.json": json({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }) }));
    expect(plan.stack).not.toContain("Tauri");
    expect(plan.notes ?? []).toEqual([]);
    expect(plan).toMatchObject({ start: "npm run dev", port: 5173 });
  });

  it("reads the Tauri config files when the snapshot is taken", () => {
    const files = ["package.json", "src-tauri/tauri.conf.json", "src-tauri/tauri.conf.json5", "src-tauri/Tauri.toml", "frontend/src-tauri/tauri.conf.json", "src-tauri/target/debug/tauri.conf.json", "src-tauri/gen/schemas/desktop-schema.json"];
    expect(selectKeyFiles(files)).toEqual(expect.arrayContaining(["src-tauri/tauri.conf.json", "src-tauri/tauri.conf.json5", "src-tauri/Tauri.toml", "frontend/src-tauri/tauri.conf.json"]));
    expect(selectKeyFiles(files)).not.toContain("src-tauri/target/debug/tauri.conf.json");
  });
});

describe("detect: what counts as a Tauri project", () => {
  it("does not call a web project a desktop app because it lists @tauri-apps/api", () => {
    const vite = detect(snap({ "package.json": json({ scripts: { dev: "vite" }, dependencies: { "@tauri-apps/api": "^2" }, devDependencies: { vite: "^6" } }) }));
    expect(vite.stack).not.toContain("Tauri");
    expect(`${vite.summary} ${(vite.notes ?? []).join(" ")}`).not.toMatch(/Tauri/);
    const express = detect(snap({ "package.json": json({ main: "server.js", scripts: { start: "node server.js" }, dependencies: { express: "^4", "@tauri-apps/api": "^2" } }), "server.js": "require('express')().listen(3000)" }));
    expect(express.stack).not.toContain("Tauri");
    expect(`${express.summary} ${(express.notes ?? []).join(" ")}`).not.toMatch(/Tauri/);
    const without = detect(snap({ "package.json": json({ main: "server.js", scripts: { start: "node server.js" }, dependencies: { express: "^4" } }), "server.js": "require('express')().listen(3000)" }));
    expect(starts(express)).toEqual(starts(without));
  });

  it("still takes a project whose script runs tauri, or that lists the cli", () => {
    const byScript = detect(snap({ "package.json": json({ scripts: { dev: "vite", start: "tauri dev" }, dependencies: { "@tauri-apps/api": "^2" }, devDependencies: { vite: "^6" } }) }));
    expect(byScript.stack).toContain("Tauri");
    const byCli = detect(snap({ "package.json": json({ scripts: { dev: "vite" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } }) }));
    expect(byCli.stack).toContain("Tauri");
  });
});
