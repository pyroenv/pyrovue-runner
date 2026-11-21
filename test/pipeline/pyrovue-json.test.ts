import { describe, expect, it } from "vitest";
import { detect } from "../../src/pipeline/detect";
import { Box } from "../../src/sandbox/box";

const snap = (contents: Record<string, string>) => ({ files: Object.keys(contents), contents });
const vite = JSON.stringify({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } });

describe("pyrovue.json with values of the wrong type", () => {
  it("coerces scalar env values to strings and drops the rest, so the start script can quote them", async () => {
    const plan = detect(
      snap({
        "pyrovue.json": JSON.stringify({ start: "npm run dev", port: 3000, env: { PORT: 3000, DEBUG: true, SKIP: null, BAD: { x: 1 }, LIST: [1] } }),
        "package.json": vite,
      }),
    );
    expect(plan.strategy).toBe("pyrovue-json");
    expect(plan.env).toEqual({ PORT: "3000", DEBUG: "true" });
    expect(plan.alternatives?.length).toBeGreaterThan(0);

    // The real start script builder quotes every value; a number used to throw "s.replace is not a function".
    let script = "";
    const box = Object.create(Box.prototype) as Box;
    Object.assign(box, {
      stopApp: async () => {},
      writeFile: async (_path: string, content: string) => {
        script = content;
      },
      sh: async () => ({ exitCode: 0, output: "", stdout: Buffer.from(""), timedOut: false }),
    });
    await box.startApp("npm run dev", { env: plan.env });
    expect(script).toContain("export PORT='3000'");
    expect(script).toContain("export DEBUG='true'");
  });

  it("ignores an env that isn't an object", () => {
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", env: ["PORT=3000"] }) })).env).toEqual({});
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", env: "PORT=3000" }) })).env).toEqual({});
  });

  it("keeps only the strings of stack, so the dashboard's stack chips get an array", () => {
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", stack: "Node.js" }) })).stack).toEqual([]);
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", stack: ["Node.js", { a: 1 }, 3] }) })).stack).toEqual(["Node.js"]);
  });

  it("falls back to /workspace for a cwd that isn't a string instead of throwing", () => {
    expect(() => detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", cwd: 1 }) }))).not.toThrow();
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", cwd: 1 }) })).cwd).toBe("/workspace");
    expect(detect(snap({ "pyrovue.json": JSON.stringify({ start: "make dev", cwd: "web" }) })).cwd).toBe("/workspace/web");
  });

  it("keeps a previewPath only when it is a path on the app's own origin", () => {
    const preview = (previewPath: unknown) => detect(snap({ "pyrovue.json": JSON.stringify({ start: "npm start", previewPath }) })).previewPath;
    expect(preview(5)).toBeNull();
    expect(preview("@evil.example/")).toBeNull();
    expect(preview("//evil.example/")).toBeNull();
    expect(preview("docs")).toBeNull();
    expect(preview("/docs")).toBe("/docs");
    expect(preview("?tab=1")).toBe("?tab=1");
    expect(preview("#intro")).toBe("#intro");
  });

  it("turns a start that isn't a string into text, so it still fails as a launch and the alternatives run", () => {
    const plan = detect(snap({ "pyrovue.json": JSON.stringify({ start: ["npm", "run", "dev"] }), "package.json": vite }));
    expect(plan.strategy).toBe("pyrovue-json");
    expect(typeof plan.start).toBe("string");
    expect(plan.kind).toBe("web");
    expect(plan.alternatives?.length).toBeGreaterThan(0);
  });

  it("ignores a pyrovue.json that isn't an object", () => {
    expect(detect(snap({ "pyrovue.json": "42", "package.json": vite })).strategy).not.toBe("pyrovue-json");
    expect(detect(snap({ "pyrovue.json": "[]", "package.json": vite })).strategy).not.toBe("pyrovue-json");
  });

  it("leaves a valid pyrovue.json exactly as written", () => {
    const plan = detect(
      snap({
        "pyrovue.json": JSON.stringify({ setup: ["make deps"], start: "make dev", port: 4000, cwd: "web", env: { NODE_ENV: "production" }, stack: ["Go"], previewPath: "/app" }),
      }),
    );
    expect(plan).toMatchObject({
      strategy: "pyrovue-json",
      setup: ["make deps"],
      start: "make dev",
      port: 4000,
      cwd: "/workspace/web",
      env: { NODE_ENV: "production" },
      stack: ["Go"],
      previewPath: "/app",
      kind: "web",
    });
  });
});
