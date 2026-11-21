import { beforeAll, describe, expect, it } from "vitest";
import { mineReadme } from "../../../src/pipeline/evidence/readme";
import { parseJustfile, parseMakefile, taskRunnerEvidence } from "../../../src/pipeline/evidence/tasks";
import { parseToml, tomlGet } from "../../../src/pipeline/evidence/toml";

// A synchronous regex can't be interrupted by vitest's timeout, so these inputs are sized to finish in a few seconds
// on a backtracking pattern and fail the elapsed-time check, rather than hang.
const SPACES = " ".repeat(1500);
const elapsed = (fn: () => void) => {
  const s = performance.now();
  fn();
  return performance.now() - s;
};

describe("parsers that read repo lines run in linear time", () => {
  // The first call compiles every pattern on the path; only the pathological input should be timed.
  beforeAll(() => {
    taskRunnerEvidence("dev: x\n\tnpm start\n", { files: new Set(), file: "Makefile" });
    parseJustfile("dev:\n  npm start\n");
    parseToml('[a]\nb = "c"\n');
    mineReadme("# a\n\n## Getting started\n\n```sh\nnpm run dev\n```\n", { files: new Set(["package.json"]) });
  });

  it("Makefile target lines", () => {
    expect(elapsed(() => taskRunnerEvidence(`dev:${SPACES}=\n`, { files: new Set(), file: "Makefile" }))).toBeLessThan(200);
  });

  it("justfile recipe lines", () => {
    expect(elapsed(() => parseJustfile(`dev${SPACES}x\n`))).toBeLessThan(200);
  });

  it("justfile recipe lines that end in a line separator", () => {
    // `\s*(.*)$` is quadratic here: `.` stops at the separator and `$` fails after every split of the spaces.
    const ls = String.fromCharCode(0x2028);
    expect(elapsed(() => parseJustfile(`dev:${" ".repeat(48_000)}a${ls}b\n`))).toBeLessThan(200);
  });

  it("TOML table headers", () => {
    let t = {};
    expect(elapsed(() => (t = parseToml(`[${SPACES}x\n[tool.poetry]\nname = "demo"\n`)))).toBeLessThan(200);
    expect(tomlGet(t, "tool.poetry.name")).toBe("demo");
  });

  it("README headings", () => {
    let ev: ReturnType<typeof mineReadme> | null = null;
    const text = `# a${SPACES}b\n\n## Getting started ##\n\n\`\`\`sh\nnpm run dev\n\`\`\`\n`;
    expect(elapsed(() => (ev = mineReadme(text, { files: new Set(["package.json"]) })))).toBeLessThan(200);
    expect(ev!.commands[0]).toMatchObject({ command: "npm run dev", section: "Getting started" });
  });

  it("README headings that end in a line separator", () => {
    // `\s+(.+)$` is quadratic here: `\s` takes the separator and `.` can't.
    const text = `#${" ".repeat(24_000)}${String.fromCharCode(0x2028)}\n`;
    expect(elapsed(() => mineReadme(text, { files: new Set() }))).toBeLessThan(200);
  });
});

describe("parsers keep their meaning", () => {
  it("Makefile targets, deps, inline recipes and comments", () => {
    expect(taskRunnerEvidence("dev: PORT = 3000\n\tx\n", { files: new Set(), file: "Makefile" })).toBeNull();
    expect(parseMakefile("dev: ; npm start # note\n")).toEqual([{ name: "dev", commands: ["npm start"], deps: [] }]);
    expect(parseMakefile("dev: ; FOO=1 npm start\n")).toEqual([{ name: "dev", commands: ["FOO=1 npm start"], deps: [] }]);
    expect(parseMakefile("dev: ;   \n")).toEqual([{ name: "dev", commands: [], deps: [] }]);
    expect(parseMakefile("build test: a $(X) .b c # d = e ; f\n\tmake x\n")).toEqual([
      { name: "build", commands: [], deps: ["a", "c"] },
      { name: "test", commands: ["make x"], deps: ["a", "c"] },
    ]);
    expect(parseMakefile("all:: one\n")).toEqual([{ name: "all", commands: [], deps: ["one"] }]);
    expect(parseMakefile("VAR := x\nVAR ?= y\nx ::= y\nA = b\nexport: x\n%.o: %.c\n")).toEqual([]);
    expect(parseMakefile("dev: x;y = 1;z\n")).toEqual([{ name: "dev", commands: ["y = 1;z"], deps: ["x"] }]);
    const ev = taskRunnerEvidence("dev: ; npm start # note\n", { files: new Set(), file: "Makefile" })!;
    expect(ev.start).toBe("make dev");
  });

  it("justfile recipes with parameters and dependencies", () => {
    expect(parseJustfile('dev port="3000": build lint\n  npm run dev\nx := "1"\n@quiet:\n  echo\n')).toEqual([
      { name: "dev", commands: ["npm run dev"], deps: ["build", "lint"] },
      { name: "quiet", commands: ["echo"], deps: [] },
    ]);
    expect(parseJustfile("dev:=1\n")).toEqual([]);
    const ls = String.fromCharCode(0x2028);
    expect(parseJustfile(`dev:${ls}b\n`)).toEqual([{ name: "dev", commands: [], deps: ["b"] }]);
    expect(parseJustfile(`dev: a${ls}b\n`)).toEqual([]);
    expect(parseJustfile("dev:   \n")).toEqual([{ name: "dev", commands: [], deps: [] }]);
    expect(parseJustfile("dev:\n  a\nx:= 1\n  b\n")).toEqual([{ name: "dev", commands: ["a"], deps: [] }]);
  });

  it("TOML headers with spaces and quotes", () => {
    expect(parseToml('[ a . "b.c" ]\nx = 1\n[[ arr ]]\ny = 2\n[[ arr ]]\ny = 3\n')).toEqual({ a: { "b.c": { x: 1 } }, arr: [{ y: 2 }, { y: 3 }] });
  });
});
