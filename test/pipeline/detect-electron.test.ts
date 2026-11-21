import { describe, expect, it } from "vitest";
import { detect, type Plan } from "../../src/pipeline/detect";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const json = (v: object) => JSON.stringify(v);
const starts = (plan: Plan) => [plan, ...(plan.alternatives ?? [])].map((p) => p.start).filter((s): s is string => s !== null);
const opensWindow = (command: string) => /\belectron\b|electron-(forge|vite|webpack)/.test(command);
const NOTE = /Electron desktop app/;

describe("detect: Electron", () => {
  it("starts the renderer's dev server rather than `electron .`", () => {
    const plan = detect(
      snap({
        "package.json": json({
          main: "dist-electron/main.js",
          scripts: { dev: "vite", start: "electron .", "electron:dev": 'concurrently "vite" "wait-on tcp:5173 && electron ."' },
          devDependencies: { electron: "^33", vite: "^6", concurrently: "^9" },
        }),
      }),
    );
    expect(plan).toMatchObject({ kind: "web", start: "npm run dev", port: 5173 });
    expect(plan.stack).toEqual(expect.arrayContaining(["Electron", "Vite"]));
    expect(starts(plan).filter(opensWindow)).toEqual([]);
    const notes = (plan.notes ?? []).join(" ");
    expect(notes).toMatch(NOTE);
    expect(notes).toMatch(/Pyrovue runs its web page/);
    expect(plan.summary).toMatch(NOTE);
    expect(`${plan.summary} ${notes}`).not.toMatch(/[–—]/);
  });

  it.each([
    ["electron .", { start: "electron ." }],
    ["electron-forge start", { start: "electron-forge start" }],
    ["electron-vite dev", { dev: "electron-vite dev", preview: "electron-vite preview" }],
    ["a script that only calls the one that opens the window", { start: "npm run desktop", desktop: "electron ." }],
  ])("says there is nothing to run when the only way to start is %s", (_name, scripts) => {
    const plan = detect(snap({ "package.json": json({ name: "app", main: "main.js", scripts, devDependencies: { electron: "^33" } }) }));
    expect(plan).toMatchObject({ start: null, port: null, kind: "cli" });
    expect(starts(plan)).toEqual([]);
    expect((plan.notes ?? []).join(" ")).toMatch(/Electron desktop app.*nothing to run/);
  });

  it("serves the renderer's page of an app that has an index.html and no dev server", () => {
    const plan = detect(snap({ "package.json": json({ main: "main.js", scripts: { start: "electron ." }, devDependencies: { electron: "^33" } }) }, ["index.html", "main.js"]));
    expect(starts(plan).filter(opensWindow)).toEqual([]);
    expect(plan.stack).toContain("Static site");
    expect((plan.notes ?? []).join(" ")).toMatch(NOTE);
  });

  it("keeps a start script that runs a server, and still says what is missing", () => {
    const plan = detect(snap({ "package.json": json({ scripts: { start: "node server.js" }, dependencies: { electron: "^33", express: "^4" } }) }));
    expect(plan.start).toBe("npm run start");
    expect((plan.notes ?? []).join(" ")).toMatch(NOTE);
  });

  it("follows pnpm and picks the dev script in the usual order", () => {
    const plan = detect(snap({ "package.json": json({ scripts: { start: "electron .", serve: "vite --port 4000", dev: "vite" }, devDependencies: { electron: "^33", vite: "^6" } }) }, ["pnpm-lock.yaml"]));
    expect(plan.start).toBe("pnpm run dev");
  });
});
