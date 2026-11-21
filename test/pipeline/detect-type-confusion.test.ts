import { describe, expect, it } from "vitest";
import { detect } from "../../src/pipeline/detect";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const pkg = (extra: object) => JSON.stringify({ name: "app", scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" }, ...extra });

/** Each case is a repo with one odd value in one manifest; detect() must still hand back a plan. */
const cases: Record<string, Record<string, string>> = {
  "engines.node as a number": { "package.json": pkg({ engines: { node: 18 } }) },
  "engines as a string": { "package.json": pkg({ engines: "node" }) },
  "engines.node as an object": { "package.json": pkg({ engines: { node: { a: 1 } } }) },
  "packageManager as a number": { "package.json": pkg({ packageManager: 5 }) },
  "name as an object": { "package.json": pkg({ name: { a: 1 } }) },
  "scripts with a non-string value": { "package.json": pkg({ scripts: { dev: 5, start: ["a"] } }) },
  "dependencies as an array": { "package.json": pkg({ dependencies: ["vite"] }) },
  "vercel devCommand as a number": { "package.json": pkg({}), "vercel.json": JSON.stringify({ devCommand: 5, buildCommand: 6, installCommand: {} }) },
  "netlify base as a number": { "package.json": pkg({}), "netlify.toml": "[build]\nbase = 5\ncommand = 6\npublish = 7\n" },
  "app.json description as a number": { "package.json": pkg({}), "app.json": JSON.stringify({ description: 5, name: 6, scripts: 7, env: 8 }) },
  "app.json env description as a number": { "package.json": pkg({}), "app.json": JSON.stringify({ env: { KEY: { description: 5, required: true } } }) },
  "Dockerfile COPY with a non-string": { Dockerfile: 'FROM node:20\nCOPY [".", 5]\nWORKDIR /app\nCMD ["node", 5]\n', "package.json": pkg({}) },
  "deeply nested shell chain": { "package.json": pkg({ scripts: { dev: `${"(".repeat(5000)}vite${")".repeat(5000)}` } }) },
  "render.yaml with scalars": { "render.yaml": "services: 5\n", "package.json": pkg({}) },
  "devcontainer with wrong types": { ".devcontainer/devcontainer.json": JSON.stringify({ postCreateCommand: 5, forwardPorts: "x", dockerComposeFile: 3, image: 4 }), "package.json": pkg({}) },
  "railway with wrong types": { "railway.json": JSON.stringify({ deploy: { startCommand: 5 }, build: 7 }), "package.json": pkg({}) },
  "fly with a numeric command": { "fly.toml": "[processes]\napp = 5\n[experimental]\ncmd = 6\n", "package.json": pkg({}) },
};

describe("detect: type-confused manifests", () => {
  for (const [name, contents] of Object.entries(cases)) {
    it(`still returns a plan for ${name}`, () => {
      const plan = detect(snap(contents));
      expect(plan).toBeTruthy();
      expect(plan.strategy).toBeTruthy();
    });
  }

  it("keeps reading an ordinary repo as before", () => {
    const plan = detect(snap({ "package.json": pkg({ engines: { node: ">=18" } }) }));
    expect(plan.start).toMatch(/vite|dev/);
  });
});
