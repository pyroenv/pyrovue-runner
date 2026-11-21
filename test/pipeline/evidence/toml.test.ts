import { describe, expect, it } from "vitest";
import { detect } from "../../../src/pipeline/detect";
import { parseToml, tomlGet } from "../../../src/pipeline/evidence/toml";

const proto = Object.prototype as Record<string, unknown>;
const cleanup = (keys: string[]) => {
  for (const k of keys) delete proto[k];
};

describe("parseToml and __proto__", () => {
  it("never writes repo keys onto Object.prototype", () => {
    const keys = ["p1", "p2", "p3", "p4", "p5", "p6", "p7"];
    try {
      parseToml('[__proto__]\np1 = "x"\n');
      parseToml('__proto__.p2 = "x"\n');
      parseToml('a = { __proto__.p3 = "x" }\n');
      parseToml('[tool.__proto__]\np4 = "x"\n');
      parseToml('"__proto__".p5 = "x"\n');
      parseToml('[[__proto__]]\np6 = "x"\n');
      parseToml('[ "__proto__" ]\np7 = "x"\n');
      for (const k of keys) expect(k in {}, k).toBe(false);
    } finally {
      cleanup(keys);
    }
  });

  it("drops the keys under a __proto__ table without merging them into the previous table", () => {
    try {
      expect(parseToml("[a]\nx = 1\n[__proto__]\ny = 2\n[b]\nz = 3\n")).toEqual({ a: { x: 1 }, b: { z: 3 } });
      expect(parseToml("[tool]\nx = 1\n[tool.__proto__]\ny = 2\n")).toEqual({ tool: { x: 1 } });
    } finally {
      cleanup(["y"]);
    }
  });

  it("still parses ordinary tables, arrays of tables, dotted and inline keys", () => {
    const t = parseToml('app = "demo"\n[build]\nbuilder = "x"\n[[services]]\ninternal_port = 8080\nports = [{ port = 80 }]\n[env]\nA.b = "c"\n');
    expect(t).toEqual({ app: "demo", build: { builder: "x" }, services: [{ internal_port: 8080, ports: [{ port: 80 }] }], env: { A: { b: "c" } } });
    expect(tomlGet(t, "env.A.b")).toBe("c");
  });

  it("a polluting fly.toml does not change how the next repo is detected", () => {
    try {
      detect({ files: ["fly.toml", "package.json"], contents: { "fly.toml": '[__proto__]\nnext = "15"\n', "package.json": "{}" } });
      const plan = detect({
        files: ["package.json"],
        contents: { "package.json": JSON.stringify({ scripts: { start: "node server.js" }, dependencies: { express: "4" } }) },
      });
      expect(plan.summary).toBe("Express app using npm.");
    } finally {
      cleanup(["next"]);
    }
  });
});
