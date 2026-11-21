import { describe, expect, it } from "vitest";
import { parseToml } from "../../src/pipeline/evidence/toml";
import { parseYaml } from "../../src/pipeline/evidence/yaml";

/**
 * Third pass T-07: every level of a nested flow collection ([[[...]]], {a: {a: ...}}) re-reads the whole rest of the
 * line, so a 48 KB line of brackets took seconds on the event loop (and a stack overflow, caught only afterwards).
 * Nesting deeper than any real file is read as plain text instead; ordinary documents parse as before.
 */
const timed = (fn: () => unknown) => {
  const t0 = performance.now();
  fn();
  return performance.now() - t0;
};

describe("YAML flow collections nested very deeply", () => {
  it("reads a 48 KB line of nested brackets or braces quickly", () => {
    const seq = `services:\n  web:\n    build: .\n    environment: ${"[".repeat(24_000)}${"]".repeat(24_000)}\n`;
    const map = `services:\n  web:\n    environment: ${"{a: ".repeat(9_600)}${"}".repeat(9_600)}\n`;
    expect(timed(() => parseYaml(seq))).toBeLessThan(200);
    expect(timed(() => parseYaml(map))).toBeLessThan(200);
    // What was around it is still read.
    expect(parseYaml(seq)).toMatchObject({ services: { web: { build: "." } } });
  });

  it("reads ordinary nesting exactly as before", () => {
    expect(parseYaml("a: [1, [2, [3, {b: c}]], \"x, y\"]\nd: {e: [f, g], h: {i: j}}\n")).toEqual({
      a: [1, [2, [3, { b: "c" }]], "x, y"],
      d: { e: ["f", "g"], h: { i: "j" } },
    });
    // Sixteen levels is still a structure.
    const sixteen = `k: ${"[".repeat(16)}1${"]".repeat(16)}`;
    let v = (parseYaml(sixteen) as { k: unknown }).k;
    let depth = 0;
    while (Array.isArray(v)) (v = v[0]), depth++;
    expect(depth).toBe(16);
    expect(v).toBe(1);
  });
});

describe("TOML arrays and inline tables nested very deeply (the same reader shape)", () => {
  it("reads a 48 KB line of nested brackets or braces quickly, and the lines around it", () => {
    const arr = `name = "x"\na = ${"[".repeat(24_000)}${"]".repeat(24_000)}\nb = 2\n`;
    const tbl = `name = "x"\na = ${"{a=".repeat(9_600)}1${"}".repeat(9_600)}\nb = 2\n`;
    expect(timed(() => parseToml(arr))).toBeLessThan(200);
    expect(timed(() => parseToml(tbl))).toBeLessThan(200);
    expect(parseToml(arr)).toMatchObject({ name: "x", b: 2 });
  });

  it("reads ordinary nesting as before", () => {
    expect(parseToml('a = [1, [2, {b = "c"}], "x, y"]\nd = {e = [1, 2], f = {g = true}}\n')).toEqual({
      a: [1, [2, { b: "c" }], "x, y"],
      d: { e: [1, 2], f: { g: true } },
    });
  });
});
