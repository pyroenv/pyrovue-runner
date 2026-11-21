import { describe, expect, it } from "vitest";
import { detect } from "../../src/pipeline/detect";
import { devcontainerEvidence } from "../../src/pipeline/evidence/devcontainer";
import { parseEnvFile } from "../../src/pipeline/evidence/envfile";
import { parseProcfile } from "../../src/pipeline/evidence/procfile";
import { sanitizeCommand } from "../../src/pipeline/evidence/shell";
import { parseYaml } from "../../src/pipeline/evidence/yaml";
import { type Plan, withoutFlaskDebugger } from "../../src/pipeline/plan";
import { matchRepairs } from "../../src/pipeline/repairs";

const hostile = `a${" ".repeat(48_000)}b`;
const timed = (fn: () => unknown) => {
  const t0 = Date.now();
  fn();
  return Date.now() - t0;
};

describe("evidence readers: long whitespace runs", () => {
  it("parses YAML ordinary input as before", () => {
    expect(parseYaml("a: 1\nb:\n  - x: y\n  - z\nc: {d: e, f: 2}\n")).toEqual({ a: 1, b: [{ x: "y" }, "z"], c: { d: "e", f: 2 } });
  });

  it("reads a 48 KB whitespace line in YAML quickly", () => {
    expect(timed(() => parseYaml(hostile))).toBeLessThan(500);
    expect(timed(() => parseYaml(`k: ${hostile}`))).toBeLessThan(500);
    expect(timed(() => parseYaml(`- ${hostile}`))).toBeLessThan(500);
    expect(timed(() => parseYaml(`k: {${hostile}}`))).toBeLessThan(500);
  });

  it("reads Procfile lines as before", () => {
    expect(parseProcfile("web:   bundle exec puma  \n# x: y\nworker: sidekiq\n")).toEqual({ web: "bundle exec puma", worker: "sidekiq" });
  });

  it("reads a 48 KB whitespace line in a Procfile quickly", () => {
    expect(timed(() => parseProcfile(`web:${hostile}`))).toBeLessThan(500);
    expect(timed(() => parseProcfile(hostile))).toBeLessThan(500);
  });

  it("cleans shell commands as before", () => {
    expect(sanitizeCommand("  npm start   &  ", { files: new Set() })).toMatchObject({ command: "npm start" });
  });

  it("cleans a 48 KB whitespace shell line quickly", () => {
    expect(timed(() => sanitizeCommand(hostile, { files: new Set() }))).toBeLessThan(500);
    expect(timed(() => sanitizeCommand(`npm${hostile}`, { files: new Set() }))).toBeLessThan(500);
  });

  it("detects a Dockerfile with a 48 KB whitespace line quickly", () => {
    const dockerfile = `FROM node:20\nRUN ${hostile}\nCMD ["node", "x.js"]\n`;
    expect(timed(() => detect({ files: ["Dockerfile"], contents: { Dockerfile: dockerfile } }))).toBeLessThan(500);
  });

  it("reads .env templates as before", () => {
    expect(parseEnvFile('A=a  # note\nB="x # y"\nC=http://h/#frag\nD=d\t#t\n')).toEqual({ A: "a", B: "x # y", C: "http://h/#frag", D: "d" });
  });

  it("reads a 48 KB whitespace value in a .env template quickly", () => {
    expect(timed(() => parseEnvFile(`A=a${hostile.slice(1)}`))).toBeLessThan(500);
    const template = `A=a${hostile.slice(1)}\n`;
    expect(timed(() => detect({ files: [".env.example"], contents: { ".env.example": template } }))).toBeLessThan(500);
  });

  it("rewrites flask run commands as before", () => {
    expect(withoutFlaskDebugger("flask run --debug -p 5000")).toBe("flask run -p 5000 --reload --no-debugger");
  });

  it("rewrites a flask run command with a 48 KB whitespace run quickly", () => {
    expect(timed(() => withoutFlaskDebugger(`flask run -p 1 ${hostile}`))).toBeLessThan(500);
  });

  it("reads a Node engine message with a 48 KB whitespace run quickly", () => {
    const plan: Plan = { stack: ["Node.js"], kind: "web", summary: "", setup: [], start: "npm run dev", port: 3000, env: {}, cwd: "/workspace", previewPath: null, confidence: "high" };
    const output = `ERR_PNPM_UNSUPPORTED_ENGINE\nExpected version: >=18 <21${hostile}\nGot: v22`;
    expect(timed(() => matchRepairs("install", "pnpm install", output, plan))).toBeLessThan(500);
  });

  it("reads a devcontainer start command with a 48 KB whitespace run quickly", () => {
    const text = JSON.stringify({ postStartCommand: `npm run dev --x${hostile}` });
    expect(timed(() => devcontainerEvidence(text, { files: new Set(), file: ".devcontainer/devcontainer.json" }))).toBeLessThan(500);
  });

  it("keeps reading after a YAML key line of 2,000 characters or more", () => {
    const long = "x".repeat(3000);
    const compose = `services:\n  web:\n    environment:\n      A: 1\n      CREDS_JSON: '${long}'\n      PORT: 80\n    ports:\n      - "3000:3000"\n  db:\n    image: postgres\n`;
    expect(parseYaml(compose)).toEqual({
      services: { web: { environment: { A: 1, CREDS_JSON: long, PORT: 80 }, ports: ["3000:3000"] }, db: { image: "postgres" } },
    });
    expect(parseYaml(`k: {a: ${long}, b: 2}`)).toEqual({ k: { a: long, b: 2 } });
    expect(parseYaml(`${"k".repeat(3000)}: 1\nz: 2`)).toEqual({ ["k".repeat(3000)]: 1, z: 2 });
  });

  it("reads a Gemfile of 48,000 blank lines quickly, and still reads the Ruby version from an ordinary one", () => {
    for (const lines of ["\n", "\r", "\r\n"]) {
      const gemfile = lines.repeat(48_000);
      expect(timed(() => detect({ files: ["Gemfile"], contents: { Gemfile: gemfile } }))).toBeLessThan(500);
    }
    const plan = detect({ files: ["Gemfile"], contents: { Gemfile: "source 'https://rubygems.org'\n\n  ruby '3.2.4'\n" } });
    expect(JSON.stringify(plan)).toContain("3.2");
  });
});
