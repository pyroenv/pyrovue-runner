import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { detect, type Plan } from "../../src/pipeline/detect";
import { collectSnapshot, selectKeyFiles } from "../../src/pipeline/snapshot";
import type { Box } from "../../src/sandbox/box";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({
  files: [...Object.keys(contents), ...extra],
  contents,
});

const pkg = (p: object) => JSON.stringify(p);

describe("detect", () => {
  it("detects a Vite app and its package manager from the lockfile", () => {
    const plan = detect(
      snap({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "^6", react: "^19" } }) }, ["pnpm-lock.yaml"]),
    );
    expect(plan.stack).toEqual(expect.arrayContaining(["Node.js", "Vite", "React", "pnpm"]));
    expect(plan.setup).toEqual(["pnpm install --no-frozen-lockfile"]);
    expect(plan.start).toBe("pnpm run dev");
    expect(plan.port).toBe(5173);
    expect(plan.kind).toBe("web");
  });

  it("honours packageManager and .nvmrc", () => {
    const plan = detect(
      snap({
        "package.json": pkg({ packageManager: "yarn@4.1.0", scripts: { start: "next start", dev: "next dev" }, dependencies: { next: "15" } }),
        ".nvmrc": "18.19.0\n",
      }),
    );
    expect(plan.setup[0]).toBe("mise use -g node@18");
    expect(plan.setup).toContain("YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install");
    expect(plan.start).toBe("yarn run dev");
    expect(plan.env.PORT).toBe("3000");
  });

  it("treats a package without dev/start scripts as a library", () => {
    const plan = detect(snap({ "package.json": pkg({ scripts: { test: "vitest" }, main: "index.js" }) }));
    expect(plan.kind).toBe("cli");
    expect(plan.start).toBeNull();
  });

  it("finds an app in a frontend/ subfolder", () => {
    const plan = detect(snap({ "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) }, ["README.md"]));
    expect(plan.cwd).toBe("/workspace/frontend");
    expect(plan.start).toBe("npm run dev");
  });

  it("keeps a second stack's plan apart from the first's in the learning data", () => {
    const plan = detect(
      snap({
        "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
        "backend/requirements.txt": "fastapi\nuvicorn\n",
        "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      }),
    );
    // Both folders run together first (see "starts a Python backend alongside a frontend/ app"); the frontend alone
    // is the next plan.
    expect(plan.strategy).toBe("framework:both");
    expect(plan.alternatives?.[0]).toMatchObject({ start: "npm run dev", strategy: "framework" });
    const backend = plan.alternatives?.find((p) => p.start?.startsWith("uvicorn"));
    // Same signature (ranked against the same stats), but its own key: FastAPI results mustn't move Vite's.
    expect(backend).toMatchObject({ strategy: "framework:secondary", signature: plan.signature, cwd: "/workspace/backend" });
  });

  it("treats a Python project with its own frontend/ as Python", () => {
    const plan = detect(
      snap(
        { "pyproject.toml": '[project]\nname = "streamlit"\n', "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) },
        ["uv.lock", "lib/streamlit/__init__.py"],
      ),
    );
    expect(plan.cwd).toBe("/workspace");
    expect(plan.stack.join(" ")).toMatch(/Python/);
    // A library's own UI isn't started next to it.
    expect([plan, ...(plan.alternatives ?? [])].some((p) => p.strategy === "framework:both" || p.services?.length)).toBe(false);
  });

  it("detects Django", () => {
    const plan = detect(snap({ "manage.py": "", "requirements.txt": "Django==5.0\n" }));
    expect(plan.stack).toContain("Django");
    expect(plan.setup).toEqual(["uv pip install -r requirements.txt", "python manage.py migrate --noinput"]);
    expect(plan.start).toContain("runserver 0.0.0.0:8000");
  });

  it("detects FastAPI and points the preview at /docs", () => {
    const plan = detect(snap({ "requirements.txt": "fastapi\nuvicorn\n", "main.py": "from fastapi import FastAPI\napi = FastAPI()\n" }));
    expect(plan.start).toBe("uvicorn main:api --host 0.0.0.0 --port 8000 --reload");
    expect(plan.previewPath).toBe("/docs");
  });

  it("finds a Flask app factory inside a package", () => {
    const plan = detect(snap({ "requirements.txt": "flask\nflask-sqlalchemy\n", "app/__init__.py": "def create_app(config=None):\n    app = Flask(__name__)\n" }));
    expect(plan.start).toBe("flask --app app run --host 0.0.0.0 --port 5000 --reload --no-debugger");
  });

  it("doesn't mistake a framework's own repo (a library) for an app", () => {
    const plan = detect(snap({ "pyproject.toml": '[project]\nname = "flask"\ndependencies = ["werkzeug"]\n' }, ["src/flask/app.py"]));
    expect(plan.kind).toBe("cli");
    expect(plan.start).toBeNull();
  });

  it("detects Streamlit", () => {
    const plan = detect(snap({ "requirements.txt": "streamlit\n", "streamlit_app.py": "import streamlit as st\n" }));
    expect(plan.start).toContain("streamlit run streamlit_app.py");
    expect(plan.port).toBe(8501);
  });

  it("serves a plain static site", () => {
    const plan = detect(snap({ "index.html": "<html></html>" }, ["styles/main.css"]));
    expect(plan.start).toContain("http.server 8080");
    expect(plan.confidence).toBe("high");
  });

  it("uses the go.mod version for Go", () => {
    const plan = detect(snap({ "go.mod": "module x\n\ngo 1.22\n", "main.go": "package main" }));
    expect(plan.setup[0]).toBe("mise use -g go@1.22");
    expect(plan.start).toBe("go run .");
  });

  it("downloads a Go library's modules without trying to run it", () => {
    // spf13/cobra, charmbracelet/bubbletea: no main.go and no cmd/, so `go run .` has nothing to run.
    const plan = detect(snap({ "go.mod": "module github.com/spf13/cobra\n\ngo 1.22\n" }, ["cobra.go", "command.go", "args.go"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, port: null, confidence: "low", signature: "go:none:gomod" });
    expect(plan.setup).toEqual(["mise use -g go@1.22", "go mod download"]);
  });

  it("runs a Go program from cmd/ when that is where main.go is", () => {
    expect(detect(snap({ "go.mod": "module x\n\ngo 1.22\n", "cmd/main.go": "package main\n" }, ["internal/app/app.go"])).start).toBe("go run ./cmd");
    expect(detect(snap({ "go.mod": "module x\n\ngo 1.22\n", "cmd/dive/main.go": "package main\n" }, ["dive/image.go"])).start).toBe("go run ./cmd/dive");
  });

  it("prefers a repo's own pyrovue.json", () => {
    const plan = detect(
      snap({
        "pyrovue.json": JSON.stringify({ setup: ["make deps"], start: "make dev", port: 4000, cwd: "web" }),
        "package.json": pkg({ scripts: { dev: "vite" } }),
      }),
    );
    expect(plan).toMatchObject({ setup: ["make deps"], start: "make dev", port: 4000, cwd: "/workspace/web", confidence: "high" });
  });

  it("still honours a pyroenv.json from before the rename, and prefers pyrovue.json when both exist", () => {
    const legacy = detect(snap({ "pyroenv.json": JSON.stringify({ setup: ["make old"], start: "make serve", port: 4100 }) }));
    expect(legacy).toMatchObject({ setup: ["make old"], start: "make serve", port: 4100, confidence: "high" });
    const both = detect(
      snap({
        "pyrovue.json": JSON.stringify({ start: "make new", port: 4200 }),
        "pyroenv.json": JSON.stringify({ start: "make old", port: 4100 }),
      }),
    );
    expect(both).toMatchObject({ start: "make new", port: 4200 });
  });

  it("reads either config file name into the snapshot", () => {
    expect(selectKeyFiles(["src/index.ts", "pyroenv.json", "pyrovue.json", "nested/pyrovue.json"])).toEqual(
      expect.arrayContaining(["pyroenv.json", "pyrovue.json"]),
    );
    expect(selectKeyFiles(["nested/pyrovue.json"])).toEqual([]);
  });
});

describe("detect: server-rendered apps and nested projects", () => {
  it("treats a Laravel app with a package.json as PHP, and builds its assets", () => {
    const plan = detect(snap({ "composer.json": "{}", artisan: "", "package.json": pkg({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "5" } }) }));
    expect(plan.stack).toEqual(expect.arrayContaining(["PHP", "Laravel", "npm"]));
    expect(plan.start).toBe("php artisan serve --host=0.0.0.0 --port=8000");
    const npm = plan.setup.indexOf("npm install --no-audit --no-fund");
    expect(npm).toBeGreaterThan(-1);
    expect(plan.setup.indexOf("npm run build || true")).toBe(npm + 1);
    expect(plan.setup.indexOf("php artisan key:generate || true")).toBeGreaterThan(npm);
  });

  it("treats a Rails app with a package.json as Ruby and uses its pinned Ruby", () => {
    const plan = detect(
      snap({ Gemfile: "source 'https://rubygems.org'\nruby '3.2.2'\ngem 'rails'\n", "config/application.rb": "", "package.json": pkg({ scripts: { "build:css": "tailwindcss -o out.css" } }) }, ["yarn.lock"]),
    );
    expect(plan.signature).toBe("ruby:rails:bundler");
    expect(plan.setup).toEqual(["mise use -g ruby@3.2.2", "bundle install", "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install", "yarn run build:css || true", "bin/rails db:prepare || true"]);
  });

  it("finds a Python backend in a subfolder", () => {
    const plan = detect(snap({ "backend/manage.py": "", "backend/requirements.txt": "django\n" }, ["README.md"]));
    expect(plan).toMatchObject({ cwd: "/workspace/backend", start: "python manage.py runserver 0.0.0.0:8000", summary: "Django project in backend/." });
  });

  it("pins Node from package.json engines and Python from requires-python", () => {
    const node = detect(snap({ "package.json": pkg({ engines: { node: "^18" }, scripts: { dev: "vite" }, devDependencies: { vite: "5" } }) }));
    expect(node.setup[0]).toBe("mise use -g node@18");
    const py = detect(snap({ "pyproject.toml": '[project]\nname = "x"\nrequires-python = ">=3.12"\n' }));
    expect(py.setup[0]).toBe("uv venv --seed --python 3.12 /opt/venv --allow-existing");
  });
});

describe("selectKeyFiles", () => {
  it("reads container, process, task-runner and hosting configs, and dev guides under docs/", () => {
    const picked = selectKeyFiles([
      "Dockerfile",
      "Dockerfile.dev",
      "backend/Dockerfile",
      "docker-compose.yml",
      "compose.dev.yaml",
      "Procfile",
      "Procfile.dev",
      "justfile",
      "fly.toml",
      "render.yaml",
      "app.json",
      ".devcontainer/devcontainer.json",
      ".devcontainer/docker-compose.yml",
      ".ruby-version",
      "runtime.txt",
      "CONTRIBUTING.md",
      "docs/development.md",
      "docs/api.md",
      "backend/manage.py",
      "server/requirements.txt",
      "backend/.env.example",
      "prisma/schema.prisma",
      "config/database.yml",
      "myproj/settings.py",
      "server/index.ts",
      "tests/Dockerfile",
    ]);
    expect(picked).not.toContain("docs/api.md");
    expect(picked).not.toContain("tests/Dockerfile");
    expect(picked).toHaveLength(24);
  });

  it("reads a backend folder's go.mod, so a Go backend next to a frontend gets its own Go version", () => {
    expect(selectKeyFiles(["frontend/package.json", "backend/go.mod", "server/go.mod", "tools/go.mod", "backend/internal/go.mod"])).toEqual([
      "backend/go.mod",
      "frontend/package.json",
      "server/go.mod",
    ]);
  });
});

describe("collectSnapshot", () => {
  it("reads only the first lines of source files", async () => {
    const source = Array.from({ length: 500 }, (_, i) => `// line ${i}`).join("\n");
    const box = {
      listFiles: async () => ["server.js", "README.md", "image.png"],
      readText: async (path: string) => (path.endsWith("server.js") ? source : path.endsWith("README.md") ? "# Hi" : null),
    };
    const snapshot = await collectSnapshot(box as unknown as Box);
    expect(snapshot.contents["server.js"]?.split("\n")).toHaveLength(200);
    expect(snapshot.contents["README.md"]).toBe("# Hi");
  });
});

describe("selectKeyFiles (manifests)", () => {
  it("keeps manifests and entry points near the root and skips vendored code", () => {
    const picked = selectKeyFiles([
      "README.md",
      "package.json",
      "packages/web/package.json",
      "node_modules/react/package.json",
      "examples/demo/package.json",
      "src/index.ts",
      "src/components/Button.tsx",
      ".env.example",
    ]);
    expect([...picked.slice(0, 3)].sort()).toEqual([".env.example", "README.md", "package.json"].sort());
    // Shallow files come before nested ones.
    expect(picked.slice(3)).toEqual(["src/index.ts", "packages/web/package.json"]);
  });
});

describe("detect: Rust workspaces", () => {
  // pollen-robotics/microduck: robot firmware, a Cargo workspace of daemons with no web server.
  const tree = readFileSync(new URL("../fixtures/microduck-tree.txt", import.meta.url), "utf8").split("\n").filter(Boolean);
  const members = ["btd", "configd", "duck-ble", "duck-control", "duck-detect", "duck-ether", "duck-ipc-proto", "duckctl", "kinematics", "mediad", "netpadd", "nfc", "odometry", "pad-imu", "pad-map", "padd", "pet-detect", "sounds", "tof", "updater", "robotctl", "robotd", "robotd-params", "test-support", "uyvy", "xtask"];
  const cargo = `# Workspace root.\n[workspace]\nresolver = "3"\nmembers = [${members.map((m) => `"${m}"`).join(", ")}]\n\n[workspace.package]\nversion = "0.17.8"\nedition = "2024"\n`;
  const contributing = `# Contributing\n\n## Building and testing\n\n${"```"}sh\nsudo apt-get install -y libudev-dev libgstreamer1.0-dev\ncargo test --workspace\n${"```"}\n\n## The layout\n\n${"```"}\nrobotd/         control daemon\nhooks/          preinstall and postinstall, what runs inside an update:\n                install.sh does to a board belongs here too (design.md 9.1)\nscripts/        provision.sh · setup-board.sh ·\n                migrate-network.sh · install.sh (on the board) ·\n                bake-duck-mesh.py (the monitor's 3D model, run by hand)\n${"```"}\n`;
  const microduck = { files: tree, contents: { "Cargo.toml": cargo, "CONTRIBUTING.md": contributing, "README.md": "# Microduck\n\nThe duck's brain.\n" } };

  it("reads only the root manifests of the microduck tree", () => {
    expect(tree).toHaveLength(469);
    expect(selectKeyFiles(tree)).toEqual(["Cargo.toml", "CONTRIBUTING.md", "README.md"]);
  });

  it("treats a multi-binary Cargo workspace as a CLI project and downloads instead of building", () => {
    expect(tree.filter((f) => /^[\w-]+\/src\/main\.rs$/.test(f))).toHaveLength(14);
    const plan = detect(microduck);
    expect(plan).toMatchObject({ kind: "cli", start: null, setup: ["mise use -g rust@stable", "cargo fetch"], signature: "rust:workspace:cargo", confidence: "low" });
    expect(plan.summary).toMatch(/Rust workspace with 14 programs/);
    expect(plan.summary).toMatch(/no web server/);
    expect(plan.summary).toBe("Rust workspace with 14 programs (btd, configd, duck-ether and more) and no web server.");
    // By its manifest, not `-p <folder>`: cargo's -p takes the package name, which needn't be the folder's.
    expect(plan.notes?.[0]).toBe(
      "This is a Rust workspace with 14 programs and no web server, so there is nothing to preview. Dependencies are downloaded; build one with `cargo build --manifest-path btd/Cargo.toml` in the terminal.",
    );
    expect(plan.alternatives).toBeUndefined();
    // The layout block's bare script names are not commands, so nothing bogus reaches the evidence.
    expect(plan.evidence?.join(" ") ?? "").not.toMatch(/install\.sh|bake-duck-mesh/);
  });

  it("expands glob members and names two programs plainly", () => {
    const plan = detect(
      snap({ "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' }, ["crates/api/Cargo.toml", "crates/api/src/main.rs", "crates/cli/src/main.rs", "crates/core/src/lib.rs"]),
    );
    expect(plan).toMatchObject({ kind: "cli", start: null, signature: "rust:workspace:cargo" });
    expect(plan.summary).toBe("Rust workspace with 2 programs (api and cli) and no web server.");
  });

  it("runs the one binary of a workspace", () => {
    const plan = detect(snap({ "Cargo.toml": '[workspace]\nmembers = [\n  "server",\n  "core",\n]\n', "server/src/main.rs": "fn main() {}\n" }, ["server/Cargo.toml", "core/Cargo.toml", "core/src/lib.rs"]));
    expect(plan).toMatchObject({ start: "cargo run --manifest-path server/Cargo.toml", port: 8080, kind: "unknown", confidence: "low", summary: "Rust workspace; runs the server binary." });
    expect(plan.env.PORT).toBe("8080");
  });

  it("runs a workspace's one binary by its manifest, whatever its package is called", () => {
    const plan = detect(
      snap({ "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n' }, ["crates/cli/Cargo.toml", "crates/cli/src/main.rs", "crates/core/src/lib.rs"]),
    );
    // crates/cli's package may be acme-cli, which `cargo run -p cli` wouldn't find.
    expect(plan).toMatchObject({ start: "cargo run --manifest-path crates/cli/Cargo.toml", summary: "Rust workspace; runs the cli binary." });
  });

  it("keeps a single crate with src/main.rs on cargo run", () => {
    const plan = detect(snap({ "Cargo.toml": '[package]\nname = "x"\n', "src/main.rs": "fn main() {}\n" }));
    expect(plan).toMatchObject({ start: "cargo run", setup: ["mise use -g rust@stable", "cargo build"], summary: "Rust crate.", signature: "rust:none:cargo" });
  });

  it("keeps a workspace whose root is itself a program on cargo run", () => {
    const plan = detect(snap({ "Cargo.toml": '[package]\nname = "x"\n\n[workspace]\nmembers = ["a", "b"]\n', "src/main.rs": "fn main() {}\n" }, ["a/src/main.rs", "b/src/main.rs"]));
    expect(plan).toMatchObject({ start: "cargo run", setup: ["mise use -g rust@stable", "cargo build"], summary: "Rust crate." });
  });

  it("falls back to today's plan when the workspace lists no members it can read", () => {
    const plan = detect(snap({ "Cargo.toml": "[workspace]\nmembers = 3\n" }, ["a/src/main.rs", "b/src/main.rs"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, setup: ["mise use -g rust@stable", "cargo build"], summary: "Rust crate.", signature: "rust:none:cargo" });
  });
});

describe("detect: a frontend and a backend", () => {
  const vite = pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } });
  const fastapi = { "requirements.txt": "fastapi\nuvicorn\n", "main.py": "from fastapi import FastAPI\napp = FastAPI()\n" };
  const inDir = (dir: string, files: Record<string, string>) => Object.fromEntries(Object.entries(files).map(([f, v]) => [`${dir}/${f}`, v]));
  const all = (plan: Plan) => [plan, ...(plan.alternatives ?? [])];

  it("starts a Python backend alongside a frontend/ app", () => {
    const plan = detect(snap({ "frontend/package.json": vite, ...inDir("backend", fastapi) }));
    expect(plan).toMatchObject({
      strategy: "framework:both",
      cwd: "/workspace/frontend",
      port: 5173,
      start: "(cd /workspace/backend && PORT=8000 uvicorn main:app --host 0.0.0.0 --port 8000 --reload) & npm run dev",
      kind: "web",
    });
    expect(plan.env.PORT).toBe("5173");
    expect(plan.env).toMatchObject({ BACKEND_PORT: "8000", API_PORT: "8000" });
    expect(plan.services).toEqual([{ name: "FastAPI in backend/", cwd: "/workspace/backend", command: "uvicorn main:app --host 0.0.0.0 --port 8000 --reload", port: 8000 }]);
    expect(plan.setup).toEqual([
      "cd /workspace/backend && uv pip install -r requirements.txt",
      "cd /workspace/backend && pip show uvicorn >/dev/null 2>&1 || uv pip install 'uvicorn[standard]'",
      "npm install --no-audit --no-fund",
    ]);
    expect(plan.summary).toMatch(/Vite app .* with a FastAPI backend in backend\//);
    expect(plan.previewPath).toBeNull();
    expect(plan.stack).toEqual(expect.arrayContaining(["Vite", "FastAPI"]));
    const frontOnly = plan.alternatives?.find((p) => p.strategy === "framework");
    expect(frontOnly).toMatchObject({ cwd: "/workspace/frontend", start: "npm run dev" });
    expect(frontOnly?.services).toBeUndefined();
    expect(plan.alternatives?.[0]).toBe(frontOnly);
    expect(plan.alternatives?.find((p) => p.strategy === "framework:secondary")).toMatchObject({ cwd: "/workspace/backend" });
    // Ranked and learned with the frontend's stats.
    expect(plan.signature).toBe("node:vite:npm");
    expect(plan.signature).toBe(frontOnly?.signature);
  });

  it("finds a backend/ next to a root package.json", () => {
    const plan = detect(snap({ "package.json": vite, ...inDir("backend", fastapi) }));
    expect(plan).toMatchObject({ strategy: "framework:both", cwd: "/workspace", port: 5173 });
    expect(plan.services?.[0]).toMatchObject({ cwd: "/workspace/backend", port: 8000 });
    expect(plan.start).toBe("(cd /workspace/backend && PORT=8000 uvicorn main:app --host 0.0.0.0 --port 8000 --reload) & npm run dev");
  });

  it("runs the frontend/ of a FastAPI repo in front of it", () => {
    const plan = detect(snap({ ...fastapi, "frontend/package.json": vite }));
    expect(plan).toMatchObject({ strategy: "framework:both", cwd: "/workspace/frontend", port: 5173 });
    expect(plan.start?.startsWith("(cd /workspace && PORT=8000 uvicorn")).toBe(true);
    expect(plan.services?.[0]).toMatchObject({ name: "FastAPI in the repo root", cwd: "/workspace", port: 8000 });
    expect(plan.summary).toBe("Vite app using npm in frontend/ with a FastAPI backend in the repo root.");
    // Each part on its own is a fallback: the repo's own framework plan, and the frontend.
    expect(plan.alternatives?.map((p) => [p.strategy, p.cwd]).sort()).toEqual([
      ["framework", "/workspace"],
      ["framework:secondary", "/workspace/frontend"],
    ]);
  });

  it("keeps Django in front of its frontend/ watcher", () => {
    const plan = detect(snap({ "manage.py": "", "requirements.txt": "django\n", "frontend/package.json": vite }));
    expect(plan).toMatchObject({
      strategy: "framework:both",
      cwd: "/workspace",
      start: "(cd /workspace/frontend && PORT=5173 npm run dev) & python manage.py runserver 0.0.0.0:8000",
      port: 8000,
    });
    expect(plan.services).toEqual([{ name: "Vite in frontend/", cwd: "/workspace/frontend", command: "npm run dev", port: 5173 }]);
    expect(plan.env.PORT).toBe("8000");
    expect(plan.env.BACKEND_PORT).toBeUndefined();
    expect(plan.summary).toBe("Django project with a Vite frontend in frontend/.");
    expect(plan.setup.at(-1)).toBe("python manage.py migrate --noinput");
  });

  it("runs a Go backend next to a root Node app", () => {
    const plan = detect(snap({ "package.json": vite, "api/go.mod": "module example.com/api\n\ngo 1.23\n", "api/main.go": "package main\n" }));
    expect(plan).toMatchObject({ strategy: "framework:both", cwd: "/workspace", port: 5173 });
    // 8080 is only what Pyrovue tells it through PORT; the repo never said so, so the launch doesn't skip that port.
    expect(plan.services).toEqual([{ name: "Go in api/", cwd: "/workspace/api", command: "go run .", port: 8080, portGuessed: true }]);
    expect(plan.start).toBe("(cd /workspace/api && PORT=8080 go run .) & npm run dev");
    expect(plan.setup).toEqual(expect.arrayContaining(["cd /workspace/api && mise use -g go@1.23", "cd /workspace/api && go mod download"]));
  });

  it("doesn't run a backend on the port its frontend listens on", () => {
    // Vue CLI and webpack-dev-server listen on 8080, the port a Go server is told to use: both would bind it.
    const vue = pkg({ scripts: { serve: "vue-cli-service serve" }, devDependencies: { "@vue/cli-service": "5" } });
    const plan = detect(snap({ "package.json": vue, "server/go.mod": "module example.com/server\n\ngo 1.23\n", "server/main.go": "package main\n" }));
    expect(plan.port).toBe(8080);
    expect(all(plan).some((p) => p.strategy === "framework:both" || p.services?.length)).toBe(false);
    expect(plan).toMatchObject({ strategy: "framework", start: "npm run serve" });
  });

  it("doesn't start a backend that is only a script", () => {
    const plan = detect(snap({ "frontend/package.json": vite, "backend/requirements.txt": "requests\n", "backend/main.py": "print('hi')\n" }));
    expect(all(plan).some((p) => p.strategy === "framework:both")).toBe(false);
    expect(plan).toMatchObject({ strategy: "framework", start: "npm run dev" });
  });

  it("doesn't start the backend twice when the root dev script already starts it", () => {
    for (const dev of ['concurrently "vite" "cd backend && uvicorn main:app"', "turbo run dev", "vite & (cd backend && python -m uvicorn main:app)"]) {
      const plan = detect(snap({ "package.json": pkg({ scripts: { dev }, devDependencies: { vite: "6" } }), ...inDir("backend", fastapi) }));
      expect(all(plan).some((p) => p.strategy === "framework:both"), dev).toBe(false);
      expect(plan).toMatchObject({ strategy: "framework", start: "npm run dev" });
    }
  });

  it("reads services from pyrovue.json", () => {
    const plan = detect(
      snap({
        "package.json": vite,
        "pyrovue.json": JSON.stringify({
          start: "npm run dev",
          port: 5173,
          services: [{ cwd: "api", start: "go run .", port: 8080 }, { start: "node worker.js" }, { cwd: "a b", start: "node x.js" }, { cwd: "api", port: 1 }, "nope"],
        }),
      }),
    );
    expect(plan.strategy).toBe("pyrovue-json");
    expect(plan.services).toEqual([
      { name: "`go run .` in api/", cwd: "/workspace/api", command: "go run .", port: 8080 },
      { name: "`node worker.js` in the repo root", cwd: "/workspace", command: "node worker.js", port: null },
    ]);
    expect(plan.start).toBe("(cd /workspace/api && PORT=8080 go run .) & (cd /workspace && node worker.js) & npm run dev");
  });
});

describe("detect: what every plan carries", () => {
  it("lists the keys the user must add, in the env file they belong in", () => {
    const readme = `# Shop\n\n## Getting started\n\n${"```"}sh\nnpm install\nnpm run start\n${"```"}\n`;
    const plan = detect(
      snap({
        "package.json": pkg({ scripts: { dev: "vite", start: "vite --port 4000" }, devDependencies: { vite: "6" } }),
        ".env.example": "OPENAI_API_KEY=sk-...\nSESSION_SECRET=\n",
        "app.json": JSON.stringify({ env: { STRIPE_SECRET_KEY: { required: true }, OPENAI_API_KEY: { required: true } } }),
        "README.md": readme,
      }),
    );
    const plans = [plan, ...(plan.alternatives ?? [])];
    expect(plans.length).toBeGreaterThan(1);
    for (const p of plans) expect(p.needs).toEqual([{ file: ".env", keys: ["OPENAI_API_KEY", "STRIPE_SECRET_KEY"] }]);
    // The note says the same.
    expect(plan.notes?.join(" ")).toMatch(/Add your own OPENAI_API_KEY, STRIPE_SECRET_KEY to \.env/);
  });

  it("files each template's keys under its own env file, and app.json's under .env without a template", () => {
    const next = pkg({ scripts: { dev: "next dev" }, dependencies: { next: "15" } });
    expect(detect(snap({ "package.json": next, ".env.local.example": "OPENAI_API_KEY=sk-...\n" })).needs).toEqual([{ file: ".env.local", keys: ["OPENAI_API_KEY"] }]);
    const bare = detect(snap({ "package.json": next, "app.json": JSON.stringify({ env: { STRIPE_SECRET_KEY: { required: true } } }) }));
    expect(bare.needs).toEqual([{ file: ".env", keys: ["STRIPE_SECRET_KEY"] }]);
    expect(detect(snap({ "package.json": next })).needs).toBeUndefined();
  });

  it("keeps the keys on a repo's own pyrovue.json plan, which ranks first", () => {
    const plan = detect(snap({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }), "pyrovue.json": JSON.stringify({ start: "npm run dev", port: 5173 }), ".env.example": "OPENAI_API_KEY=sk-...\n" }));
    expect(plan.strategy).toBe("pyrovue-json");
    expect(plan.needs).toEqual([{ file: ".env", keys: ["OPENAI_API_KEY"] }]);
  });

  it("keeps a database shim's prelude before the background services and the server", () => {
    const compose = `services:\n  web:\n    build: ./frontend\n    command: npm run dev\n    ports:\n      - "5173:5173"\n    depends_on: [api]\n  api:\n    build: ./api\n    command: uvicorn main:app --host 0.0.0.0 --port 8000\n    ports:\n      - "8000:8000"\n    environment:\n      DATABASE_URL: postgres://app:secret@db:5432/app\n    depends_on: [db]\n  db:\n    image: postgres:16\n`;
    const plan = detect(
      snap({
        "docker-compose.yml": compose,
        "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
        "api/requirements.txt": "fastapi\nuvicorn\n",
        "api/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      }),
    );
    const c = [plan, ...(plan.alternatives ?? [])].find((p) => p.strategy === "compose")!;
    expect(c.start).toBe("service postgresql start >/dev/null 2>&1 || true; (cd /workspace/api && PORT=8000 uvicorn main:app --host 0.0.0.0 --port 8000) & npm run dev");
    expect(c.services).toEqual([{ name: "`uvicorn main:app --host 0.0.0.0 --port 8000` in api/", cwd: "/workspace/api", command: "uvicorn main:app --host 0.0.0.0 --port 8000", port: 8000 }]);
    // The port is the app's own, never the API's.
    expect(c.port).toBe(5173);
  });
});

describe("detect: a root package.json that holds only tooling", () => {
  // django/django: a Python package whose package.json runs the JavaScript tests and a linter.
  const djangoPkg = pkg({ name: "Django", private: true, scripts: { test: "grunt test --verbose", biome: "biome check" }, devDependencies: { "@biomejs/biome": "2.4.10", grunt: "^1.6.1", "grunt-cli": "^1.5.0", "grunt-contrib-qunit": "^10.1.1", qunit: "^2.25.0" } });
  const djangoToml = '[build-system]\nrequires = ["setuptools>=77.0.3"]\nbuild-backend = "setuptools.build_meta"\n\n[project]\nname = "Django"\nrequires-python = ">= 3.12"\ndependencies = ["asgiref>=3.9.1", "sqlparse>=0.5.0"]\n';

  it("reads a Python package with a test-and-lint package.json as Python", () => {
    const plan = detect(snap({ "pyproject.toml": djangoToml, "package.json": djangoPkg }, ["Gruntfile.js", "django/__init__.py", "django/shortcuts.py", "django/db/models/base.py", "js_tests/admin/core.test.js"]));
    expect(plan.signature).toBe("python:library:pyproject");
    expect(plan.stack).toEqual(["Python"]);
    expect(plan.start).toBeNull();
    // The package.json is tooling: nothing in it is installed or built.
    expect(plan.setup.join("\n")).not.toMatch(/\bnpm\b/);
    expect(plan.setup).toContain("uv pip install -e . || pip install -e .");
  });

  it("reads a gem with a workspaces-only package.json as Ruby", () => {
    // rails/rails: the gems are Ruby; package.json only lists the three JavaScript packages published from them.
    const plan = detect(
      snap(
        { Gemfile: 'source "https://rubygems.org"\ngemspec\ngem "minitest"\n', "package.json": pkg({ private: true, workspaces: ["actioncable", "actiontext", "activestorage"] }), "actioncable/package.json": pkg({ name: "@rails/actioncable", main: "app/assets/javascripts/actioncable.js", scripts: { build: "rollup --config rollup.config.js" } }) },
        ["rails.gemspec", "yarn.lock", "Rakefile", "railties/lib/rails.rb", "activerecord/lib/active_record.rb", "activesupport/lib/active_support.rb", "actioncable/app/javascript/action_cable/index.js"],
      ),
    );
    expect(plan.signature).toBe("ruby:library:bundler");
    expect(plan.stack).toEqual(["Ruby"]);
    expect(plan.setup).toContain("bundle install");
    expect(plan.setup.join("\n")).not.toMatch(/\byarn\b/);
  });

  it("reads a PHP library with a test-and-lint package.json as PHP", () => {
    // yiisoft/yii2: `main` is npm init's default and names no file; the scripts run mocha and eslint over the framework's assets.
    const plan = detect(
      snap(
        {
          "composer.json": JSON.stringify({ name: "yiisoft/yii2-dev", type: "yii2-extension", require: { php: ">=7.4" }, autoload: { "psr-4": { "yii\\": "framework/" } } }),
          "package.json": pkg({ name: "yii2", main: "index.js", scripts: { test: "mocha tests/js/tests/*.test.js", lint: "eslint ./framework/assets" }, dependencies: {}, devDependencies: { chai: "^3.5.0", eslint: "^9.0.0", mocha: "^5.2.0" } }),
        },
        ["framework/Yii.php", "framework/BaseYii.php", "framework/base/Component.php", "framework/assets/yii.js", "tests/js/tests/yii.test.js"],
      ),
    );
    expect(plan.signature).toBe("php:library:composer");
    expect(plan.stack).toEqual(["PHP"]);
    expect(plan.setup).toContain("composer install --no-interaction");
    expect(plan.setup.join("\n")).not.toMatch(/\bnpm\b/);
  });

  it("reads a Go program with an empty package.json as Go", () => {
    // gogs/gogs: a private package.json with no scripts and no dependencies, kept for editor tooling.
    const plan = detect(snap({ "go.mod": "module gogs.io/gogs\n\ngo 1.25\n", "package.json": pkg({ private: true }) }, ["gogs.go", "internal/route/home.go", "internal/db/users.go", "public/js/gogs.js"]));
    expect(plan.signature).toBe("go:none:gomod");
    expect(plan.stack).toEqual(["Go"]);
    expect(plan.setup).toEqual(["mise use -g go@1.25", "go mod download"]);
  });

  it("reads a Rust workspace whose package.json is only a list of lint tools as Rust", () => {
    // rust-lang/rust: no scripts, no name, no entry point; `dependencies` holds eslint and the docs UI test runner.
    const plan = detect(
      snap(
        { "Cargo.toml": '[workspace]\nresolver = "2"\nmembers = ["compiler/rustc", "library/std"]\n', "package.json": pkg({ dependencies: { "browser-ui-test": "^0.23.5", "es-check": "^9.4.4", eslint: "^8.57.1", typescript: "^5.8.3" } }) },
        ["compiler/rustc/src/main.rs", "compiler/rustc_ast/src/lib.rs", "library/std/src/lib.rs", "library/core/src/lib.rs", "src/librustdoc/html/static/js/main.js"],
      ),
    );
    expect(plan.signature).toBe("rust:none:cargo");
    expect(plan.stack).toEqual(["Rust"]);
    expect(plan.setup.join("\n")).not.toMatch(/\bnpm\b/);
  });

  it("keeps a JavaScript library that also publishes to Packagist as Node.js", () => {
    // uikit/uikit: composer.json is a publishing stub; the code is JavaScript.
    const plan = detect(
      snap(
        { "composer.json": JSON.stringify({ name: "uikit/uikit", type: "component" }), "package.json": pkg({ name: "uikit", version: "3.21.0", main: "dist/js/uikit.js", files: ["dist", "src"], scripts: { compile: "node build/build.js", test: "eslint src" }, devDependencies: { rollup: "^4", less: "^4" } }) },
        ["pnpm-lock.yaml", "src/js/uikit.js", "src/js/core/index.js", "src/js/components/slider.js", "build/build.js"],
      ),
    );
    expect(plan.signature).toBe("node:library:pnpm");
    expect(plan.stack[0]).toBe("Node.js");
  });

  it("keeps a JavaScript library with a Gemfile for its docs site as Node.js", () => {
    // harvesthq/chosen: CoffeeScript sources, one Ruby file (compass's config.rb).
    const plan = detect(
      snap({ Gemfile: 'source "https://rubygems.org"\ngem "compass"\n', "package.json": pkg({ name: "chosen", devDependencies: { grunt: "~0.4.5", "grunt-contrib-coffee": "~0.12.0" } }) }, ["Gruntfile.coffee", "config.rb", "coffee/chosen.jquery.coffee", "coffee/chosen.proto.coffee", "coffee/lib/abstract-chosen.coffee"]),
    );
    expect(plan.signature).toBe("node:none:npm");
  });

  it("reads a PHP app as PHP when its package.json starts nothing, even with an index.html beside index.php", () => {
    // FreshRSS: the page Node.js could serve statically is not the app.
    const plan = detect(
      snap(
        { "composer.json": JSON.stringify({ type: "project", require: { php: ">=8.1" } }), "package.json": pkg({ scripts: { eslint: "eslint .", stylelint: "stylelint '**/*.css'" }, devDependencies: { eslint: "^9", stylelint: "^16" } }), "index.html": "<html></html>" },
        ["index.php", "app/FreshRSS.php", "app/Controllers/indexController.php", "lib/Minz/Request.php", "p/scripts/main.js"],
      ),
    );
    expect(plan.signature).toBe("php:none:composer");
    expect(plan.stack).toEqual(["PHP"]);
  });

  it("keeps a Tauri app on its Node.js dev script, however much Rust it holds", () => {
    const plan = detect(
      snap(
        { "Cargo.toml": '[workspace]\nmembers = ["src-tauri"]\n', "package.json": pkg({ scripts: { dev: "vite", tauri: "tauri", build: "vite build" }, dependencies: { "@tauri-apps/api": "^2", react: "^19" }, devDependencies: { "@tauri-apps/cli": "^2", vite: "^6" } }) },
        ["pnpm-lock.yaml", "src/main.tsx", "src-tauri/Cargo.toml", "src-tauri/src/main.rs", "src-tauri/src/lib.rs", "src-tauri/src/commands.rs", "src-tauri/src/state.rs", "src-tauri/build.rs"],
      ),
    );
    expect(plan).toMatchObject({ signature: "node:vite:pnpm", start: "pnpm run dev", port: 5173, strategy: "framework" });
  });

  it("keeps a Go service whose front end is started from the root package.json as Node.js", () => {
    const plan = detect(
      snap(
        { "go.mod": "module example.com/app\n\ngo 1.23\n", "main.go": "package main\n", "package.json": pkg({ scripts: { dev: "vite" }, dependencies: { vue: "^3" }, devDependencies: { vite: "^6" } }) },
        ["internal/server/server.go", "internal/store/store.go", "internal/api/api.go", "web_src/main.ts"],
      ),
    );
    expect(plan).toMatchObject({ signature: "node:vite:npm", start: "npm run dev" });
  });

  it("builds the assets of a PHP app whose package.json has a build script and nothing to start", () => {
    // A Symfony app: PHP serves the pages, webpack builds what they load.
    const plan = detect(
      snap(
        { "composer.json": JSON.stringify({ type: "project", require: { php: ">=8.2", "symfony/framework-bundle": "^7" } }), "package.json": pkg({ private: true, scripts: { build: "encore production", watch: "encore dev --watch" }, dependencies: { jquery: "^3" }, devDependencies: { "@symfony/webpack-encore": "^5" } }) },
        ["yarn.lock", "public/index.php", "src/Kernel.php", "src/Controller/HomeController.php", "assets/app.js"],
      ),
    );
    expect(plan.signature).toBe("php:none:composer");
    expect(plan.stack).toEqual(["PHP", "yarn"]);
    const composer = plan.setup.indexOf("composer install --no-interaction");
    expect(composer).toBeGreaterThan(-1);
    expect(plan.setup.slice(composer + 1)).toEqual(["YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install", "yarn run build || true"]);
  });
});

describe("detect: which language owns the root", () => {
  const vite = pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } });

  it("reads a PHP tool with a website/ folder as PHP", () => {
    // phpstan/phpstan: composer.json at the root; website/ is its documentation site and has no dev script.
    const plan = detect(
      snap(
        { "composer.json": JSON.stringify({ name: "phpstan/phpstan", require: { php: "^7.4|^8.0" }, bin: ["phpstan"], autoload: { files: ["bootstrap.php"] } }), "website/package.json": pkg({ scripts: { build: "vite build" }, devDependencies: { vite: "^6" } }) },
        ["bootstrap.php", "phpstan", "website/src/app.ts"],
      ),
    );
    expect(plan.signature).toBe("php:library:composer");
    expect(plan.cwd).toBe("/workspace");
    expect(plan.stack[0]).toBe("PHP");
  });

  it("runs a Go server at the root with its web/ dev server in front", () => {
    // usememos/memos, schollz/croc: go.mod and main.go at the root, the UI in web/.
    const plan = detect(snap({ "go.mod": "module example.com/memos\n\ngo 1.24\n", "main.go": "package main\n", "web/package.json": vite }, ["internal/server/server.go", "store/store.go", "web/src/main.tsx"]));
    expect(plan).toMatchObject({ strategy: "framework:both", signature: "go:none:gomod", cwd: "/workspace/web", port: 5173 });
    expect(plan.start).toBe("(cd /workspace && PORT=8080 go run .) & npm run dev");
    expect(plan.services).toEqual([{ name: "Go in the repo root", cwd: "/workspace", command: "go run .", port: 8080, portGuessed: true }]);
    expect(plan.setup).toEqual(["cd /workspace && mise use -g go@1.24", "cd /workspace && go mod download", "npm install --no-audit --no-fund"]);
    // Each half on its own stays a fallback.
    expect(plan.alternatives?.map((p) => [p.strategy, p.cwd]).sort()).toEqual([
      ["framework", "/workspace"],
      ["framework:secondary", "/workspace/web"],
    ]);
  });

  it("doesn't start a frontend folder next to a root project that has nothing to serve", () => {
    // rust-lang/rustlings: a Rust CLI whose website/ would otherwise be the whole plan.
    const plan = detect(snap({ "Cargo.toml": '[package]\nname = "rustlings"\n', "src/main.rs": "fn main() {}\n", "website/package.json": pkg({ dependencies: { "@tailwindcss/cli": "^4" } }) }, ["src/app_state.rs", "website/input.css"]));
    expect(plan).toMatchObject({ signature: "rust:none:cargo", cwd: "/workspace", start: "cargo run", strategy: "framework" });
    expect([plan, ...(plan.alternatives ?? [])].some((p) => p.cwd === "/workspace/website")).toBe(false);
  });

  it("reads a gem that keeps a requirements.txt for its docs as Ruby", () => {
    // jordansissel/fpm: Sphinx builds the docs; everything else is Ruby.
    const plan = detect(snap({ Gemfile: 'source "https://rubygems.org"\ngemspec\n', "requirements.txt": "Sphinx==8.2.3\nsphinx_rtd_theme\n" }, ["fpm.gemspec", "lib/fpm.rb", "lib/fpm/package.rb", "lib/fpm/command.rb", "docs/conf.py"]));
    expect(plan.signature).toBe("ruby:library:bundler");
    expect(plan.setup.join("\n")).not.toMatch(/requirements\.txt/);
  });

  it("reads a Rust tool that ships through PyPI as Rust", () => {
    // astral-sh/uv: pyproject.toml packages the binary with maturin; the code is a Cargo workspace.
    const plan = detect(
      snap(
        { "Cargo.toml": '[workspace]\nmembers = ["crates/*"]\n', "pyproject.toml": '[project]\nname = "uv"\nrequires-python = ">=3.8"\n\n[build-system]\nrequires = ["maturin>=1.0,<2.0"]\nbuild-backend = "maturin"\n' },
        ["uv.lock", "crates/uv/Cargo.toml", "crates/uv/src/main.rs", "crates/uv/src/lib.rs", "crates/uv-resolver/src/lib.rs", "crates/uv-cache/src/lib.rs", "python/uv/__init__.py", "python/uv/__main__.py"],
      ),
    );
    expect(plan.signature).toBe("rust:none:cargo");
    expect(plan.stack).toEqual(["Rust"]);
  });

  it("keeps a Python package with a Rust extension as Python", () => {
    const plan = detect(
      snap({ "Cargo.toml": '[package]\nname = "fastjson"\n\n[lib]\ncrate-type = ["cdylib"]\n', "pyproject.toml": '[project]\nname = "fastjson"\n\n[build-system]\nrequires = ["maturin>=1.0"]\nbuild-backend = "maturin"\n' }, ["src/lib.rs", "python/fastjson/__init__.py", "python/fastjson/encoder.py", "python/fastjson/decoder.py", "tests/test_roundtrip.py"]),
    );
    expect(plan.signature).toBe("python:library:pyproject");
  });

  it("still prefers Python when the root says both and neither has more code", () => {
    // The order the detector has always used, kept for a tie.
    const plan = detect(snap({ "requirements.txt": "flask\n", "go.mod": "module x\n\ngo 1.22\n" }));
    expect(plan.signature).toBe("python:none:requirements");
  });

  it("keeps a web app in a subfolder in front of a small Rust crate at the root", () => {
    // OpenCut-app/OpenCut: a TypeScript monorepo whose root Cargo.toml builds a desktop shell.
    const plan = detect(
      snap(
        { "Cargo.toml": '[workspace]\nmembers = ["apps/desktop"]\n', "apps/web/package.json": vite },
        ["apps/desktop/Cargo.toml", "apps/desktop/src/main.rs", "apps/web/src/main.tsx", "apps/web/src/editor.tsx", "apps/web/src/timeline.tsx", "apps/web/src/store.ts"],
      ),
    );
    expect(plan).toMatchObject({ signature: "node:vite:npm", cwd: "/workspace/apps/web", start: "npm run dev" });
  });

  it("keeps a subfolder's dev server when the root's owner has nothing to start", () => {
    // kestra-io/kestra: a Gradle build Pyrovue can only compile, and a ui/ it can run. Running something wins.
    const plan = detect(snap({ "build.gradle": "plugins {\n  id 'java-library'\n}\n", "ui/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) }, ["gradlew", "settings.gradle", "core/src/main/java/io/kestra/core/Flow.java", "webserver/src/main/java/io/kestra/webserver/Controller.java", "ui/src/main.ts"]));
    expect(plan).toMatchObject({ signature: "node:vite:npm", cwd: "/workspace/ui", start: "npm run dev" });
  });

  it("keeps a Rust server's frontend folder in front when the two can't be started together", () => {
    // Only a web server or a Go program runs behind a dev server; `cargo run` is not paired, so the dev server stays.
    const plan = detect(snap({ "Cargo.toml": '[package]\nname = "api"\n', "src/main.rs": "fn main() {}\n", "frontend/package.json": vite }, ["src/routes.rs", "src/db.rs", "frontend/src/main.ts"]));
    expect(plan).toMatchObject({ signature: "node:vite:npm", cwd: "/workspace/frontend", start: "npm run dev" });
  });

  it("reads a gem with a gemspec and no Gemfile as Ruby, and installs it from the gemspec", () => {
    const plan = detect(snap({ "package.json": pkg({ private: true, devDependencies: { prettier: "^3" } }) }, ["foo.gemspec", "lib/foo.rb", "lib/foo/version.rb"]));
    expect(plan.signature).toBe("ruby:library:rubygems");
    expect(plan.setup).toEqual(["mise use -g ruby@3.3", "gem build foo.gemspec -o /tmp/pyrovue-gem.gem && gem install /tmp/pyrovue-gem.gem"]);
    expect(plan.start).toBeNull();
  });

  it("doesn't count the JavaScript a server-side app serves from public/ or static/ as the project's code", () => {
    // gollum/gollum: a gem whose editor scripts live under lib/gollum/public/.
    const plan = detect(
      snap({ Gemfile: 'source "https://rubygems.org"\ngemspec\n', "package.json": pkg({ dependencies: { mermaid: "^10" } }) }, ["gollum.gemspec", "config.ru", "lib/gollum.rb", "lib/gollum/app.rb", "lib/gollum/public/gollum/javascript/editor.js", "lib/gollum/public/gollum/javascript/gollum.js", "lib/gollum/public/gollum/javascript/mousetrap.js", "lib/gollum/public/gollum/javascript/editor/langs/markdown.js", "lib/gollum/public/gollum/javascript/editor/langs/asciidoc.js"]),
    );
    expect(plan.signature).toBe("ruby:none:bundler");
  });
});

describe("detect: PHP", () => {
  const composer = (extra: object = {}) => JSON.stringify({ require: { php: ">=8.1" }, ...extra });

  it("installs a Composer library without starting a web server for it", () => {
    // guzzle/guzzle, Seldaek/monolog: nothing in the repository answers an HTTP request.
    const plan = detect(snap({ "composer.json": composer({ name: "guzzlehttp/guzzle", type: "library", autoload: { "psr-4": { "GuzzleHttp\\": "src/" } } }) }, ["src/Client.php", "src/HandlerStack.php", "tests/ClientTest.php"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, port: null, summary: "PHP package.", confidence: "low", signature: "php:library:composer" });
    expect(plan.setup).toContain("composer install --no-interaction");
  });

  it("serves a site whose index.php is at the root", () => {
    const plan = detect(snap({ "composer.json": composer({ type: "project" }) }, ["index.php", "core/bootstrap.php"]));
    expect(plan).toMatchObject({ kind: "web", start: "php -S 0.0.0.0:8000", port: 8000, summary: "PHP site.", confidence: "medium" });
  });

  it("serves a front controller from public/ or web/", () => {
    // Symfony, Slim and Flarum keep index.php in public/; older Symfony apps in web/.
    const inPublic = detect(snap({ "composer.json": composer({ type: "project" }) }, ["public/index.php", "src/Kernel.php"]));
    expect(inPublic).toMatchObject({ kind: "web", start: "php -S 0.0.0.0:8000 -t public", port: 8000 });
    const inWeb = detect(snap({ "composer.json": composer({ type: "project" }) }, ["web/index.php", "src/AppKernel.php"]));
    expect(inWeb).toMatchObject({ kind: "web", start: "php -S 0.0.0.0:8000 -t web", port: 8000 });
  });

  it("still serves a bare index.php with no composer.json", () => {
    const plan = detect(snap({}, ["index.php", "wp-config-sample.php"]));
    expect(plan).toMatchObject({ kind: "web", start: "php -S 0.0.0.0:8000", signature: "php:none:none" });
  });
});

describe("detect: documentation sites", () => {
  const mkdocs = "site_name: CS Self Learning\ntheme:\n  name: material\nnav:\n  - Home: index.md\n";
  const serve = "mkdocs serve --dev-addr 0.0.0.0:8000";
  const ensure = "pip show mkdocs >/dev/null 2>&1 || uv pip install mkdocs mkdocs-material";

  it("serves a MkDocs site whose requirements.txt only installs MkDocs", () => {
    // PKUFlyingPig/cs-self-learning: Markdown, mkdocs.yml and a requirements.txt; there is no Python package.
    const plan = detect(snap({ "requirements.txt": "mkdocs-material\nmkdocs-minify-plugin\n" }, ["mkdocs.yml", "docs/index.md", "docs/CS61A.md"]));
    expect(plan).toMatchObject({ stack: ["Python", "MkDocs"], kind: "web", summary: "MkDocs documentation site.", start: serve, port: 8000, confidence: "low", signature: "python:mkdocs:requirements" });
    expect(plan.setup).toEqual(["uv pip install -r requirements.txt", ensure]);
  });

  it("serves a MkDocs site that has no other manifest", () => {
    // krahets/hello-algo: a book; mkdocs.yml is the only thing at the root that says how to run it.
    const plan = detect(snap({}, ["mkdocs.yml", "README.md", "docs/index.md", "docs/index.html", "codes/python/chapter_sorting/quick_sort.py"]));
    expect(plan).toMatchObject({ kind: "web", start: serve, port: 8000, signature: "python:mkdocs:none" });
    expect(plan.setup).toEqual([ensure]);
  });

  it("keeps a Python package that documents itself with MkDocs as a package", () => {
    const plan = detect(snap({ "pyproject.toml": '[project]\nname = "paddleocr"\n', "requirements.txt": "numpy\n" }, ["mkdocs.yml", "paddleocr/__init__.py", "docs/index.md"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, summary: "Python package." });
  });

  it("serves an index.html kept in docs/ when nothing else in the repository runs", () => {
    // CyC2018/CS-Notes, datawhalechina/hello-agents: a docsify site in docs/ and a README.
    const plan = detect(snap({ "README.md": "# Notes\n" }, ["docs/index.html", "docs/README.md", "notes/os.md"]));
    expect(plan).toMatchObject({ stack: ["HTML", "Static site"], kind: "web", summary: "Static website in docs/.", start: "python3 -m http.server 8080 --bind 0.0.0.0", port: 8080, cwd: "/workspace/docs", confidence: "medium", signature: "static:none:none" });
    // Not the detector's call alone: a page in a subfolder may not be what the repository is for.
    expect(plan.prior).toBeLessThan(0.75);
  });

  it("serves the same from html/, and prefers docs/ when both exist", () => {
    // fengdu78/Coursera-ML-AndrewNg-Notes keeps its pages in html/.
    expect(detect(snap({}, ["README.md", "html/index.html", "html/week1.html"]))).toMatchObject({ cwd: "/workspace/html", summary: "Static website in html/." });
    expect(detect(snap({}, ["html/index.html", "docs/index.html"])).cwd).toBe("/workspace/docs");
  });

  it("keeps a Python project that also has MkDocs docs as a Python project", () => {
    // Training scripts with a docs site: more Python than Markdown, so the code is the project.
    const plan = detect(snap({ "requirements.txt": "torch\nnumpy\n" }, ["mkdocs.yml", "train.py", "model.py", "data.py", "docs/index.md"]));
    expect(plan).toMatchObject({ kind: "cli", start: null, summary: "Python package." });
  });

  it("doesn't turn a library's docs folder into the plan", () => {
    const plan = detect(snap({ "go.mod": "module example.com/lib\n\ngo 1.23\n" }, ["lib.go", "docs/index.html"]));
    expect(plan.signature).toBe("go:none:gomod");
    expect(plan.cwd).toBe("/workspace");
  });
});
