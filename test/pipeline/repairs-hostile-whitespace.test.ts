import { describe, expect, it } from "vitest";
import { devcontainerEvidence } from "../../src/pipeline/evidence/devcontainer";
import type { Plan } from "../../src/pipeline/plan";
import { matchRepairs, nodeMajorFor } from "../../src/pipeline/repairs";

const plan: Plan = { stack: ["Node.js"], kind: "web", summary: "", setup: [], start: "npm run dev", port: 3000, env: {}, cwd: "/workspace", previewPath: null, confidence: "high" };
const time = (f: () => unknown) => {
  const t = performance.now();
  f();
  return performance.now() - t;
};
const RUN = " ".repeat(200_000);

describe("a long run of whitespace in a file or a log costs only its length", () => {
  it("devcontainer start command: a trailing & is dropped, and a long run of spaces is read fast", () => {
    const read = (cmd: string) => devcontainerEvidence(JSON.stringify({ postStartCommand: cmd }), { files: new Set(["package.json"]), file: ".devcontainer/devcontainer.json" });
    expect(read("npm run dev &")?.start).toBe("npm run dev");
    expect(read("npm run dev   &")?.start).toBe("npm run dev");
    expect(time(() => read(`npm run dev${RUN}x`))).toBeLessThan(300);
    expect(time(() => read(`npm run dev ${RUN}b &`))).toBeLessThan(300);
  });

  it("an npm range written with a hyphen is read with or without spaces, and a long run of spaces is read fast", () => {
    expect(nodeMajorFor("18-20")).toBe(nodeMajorFor("18 - 20"));
    expect(nodeMajorFor("18   -   20")).toBe(nodeMajorFor("18 - 20"));
    expect(time(() => nodeMajorFor(`18${RUN}x`))).toBeLessThan(300);
  });

  it("a Node version error that says 'or higher' gives the version, and a long run of spaces in the log is read fast", () => {
    const fix = (out: string) => matchRepairs("install", "npm ci", out, plan).find((m) => m.rule.id === "node-engine")?.fix;
    expect(fix("npm ERR! requires Node.js version 24 or higher")).toBeDefined();
    expect(time(() => fix(`requires node ${RUN}x`))).toBeLessThan(300);
    expect(time(() => fix(`requires node >=${RUN}x`))).toBeLessThan(300);
  });

  it("the npm peer-dependency retry adds --legacy-peer-deps once, and a long run of spaces in the command is read fast", () => {
    const retry = (cmd: string) => matchRepairs("install", cmd, "npm ERR! ERESOLVE unable to resolve dependency tree", plan).find((m) => m.rule.id === "npm-peer-deps")?.fix.retry;
    expect(retry("npm install --no-audit")).toBe("npm install --no-audit --legacy-peer-deps");
    expect(time(() => retry(`npm install${RUN}x`))).toBeLessThan(300);
  });
});
