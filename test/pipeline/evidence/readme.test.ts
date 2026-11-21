import { describe, expect, it } from "vitest";
import { repoNameFrom } from "../../../src/pipeline/evidence";
import { blockCommands, localhostPorts, mineReadme, sectionWeight } from "../../../src/pipeline/evidence/readme";
import { classifyCommand, looksSecret, sanitizeCommand, splitChain } from "../../../src/pipeline/evidence/shell";

const fence = "```";
const files = (...list: string[]) => new Set(list);

const NODE_README = `# Acme Dashboard

A dashboard for widgets.

## Getting started

${fence}bash
git clone https://github.com/acme/dashboard.git
cd dashboard
nvm use 18
cp .env.example .env
pnpm install
pnpm dev
${fence}

Then open http://localhost:3000 in your browser.

## Docker

${fence}bash
docker compose up --build
${fence}

## Deployment

${fence}bash
vercel deploy --prod
${fence}

## Running tests

${fence}bash
pnpm test
${fence}
`;

const PYTHON_README = `Widgets
=======

Installation
------------

${fence}console
$ sudo apt-get install -y libpq-dev
$ curl -sSL https://install.python-poetry.org | python3 -
$ python -m venv .venv
$ source .venv/bin/activate
$ pip install -r requirements.txt \\
    --no-cache-dir
$ export FLASK_DEBUG=1
$ python manage.py migrate   # creates the tables
${fence}

Usage
-----

Start the development server with \`python manage.py runserver 0.0.0.0:8000\`, then visit http://127.0.0.1:8000/admin.
`;

const RST_README = `Project
=======

Quick start
-----------

Install the dependencies::

    pip install -e .
    make serve

License
-------

MIT
`;

const MONOREPO_README = `# Fullstack app

## Local development

### Backend

${fence}sh
cd backend
pip install -r requirements.txt
uvicorn main:app --reload --port 8001
${fence}

### Frontend

${fence}sh
cd frontend
npm install
npm run dev
${fence}
`;

describe("README mining", () => {
  it("keeps the run steps from Getting started and ignores Docker, deploy and test sections", () => {
    const ev = mineReadme(NODE_README, { files: files("package.json", ".env.example"), repoName: "dashboard" });
    expect(ev.commands.map((c) => [c.command, c.kind, c.dir])).toEqual([
      ["cp .env.example .env", "env", "."],
      ["pnpm install", "install", "."],
      ["pnpm dev", "start", "."],
    ]);
    expect(ev.versions).toEqual([{ tool: "node", version: "18" }]);
    expect(ev.ports).toEqual([3000]);
    expect(ev.usesDocker).toBe(true);
    expect(ev.commands.some((c) => /vercel|test/.test(c.command))).toBe(false);
  });

  it("strips prompts and sudo, joins continuations, drops venvs and piped installers", () => {
    const ev = mineReadme(PYTHON_README, { files: files("manage.py", "requirements.txt") });
    const commands = ev.commands.map((c) => c.command);
    expect(commands).toContain("apt-get update -qq && apt-get install -y --no-install-recommends libpq-dev");
    expect(commands).toContain("pip install -r requirements.txt --no-cache-dir");
    expect(commands).toContain("python manage.py migrate");
    expect(commands.some((c) => /curl|venv|activate/.test(c))).toBe(false);
    expect(ev.skipped.map((s) => s.reason)).toContain("pipes a download into a shell");
    expect(ev.env).toEqual({ FLASK_DEBUG: "1" });
    // The inline span under Usage is a start command.
    expect(ev.commands.find((c) => c.kind === "start")?.command).toBe("python manage.py runserver 0.0.0.0:8000");
    expect(ev.ports).toContain(8000);
  });

  it("reads reStructuredText literal blocks", () => {
    const ev = mineReadme(RST_README, { files: files("setup.py", "Makefile") });
    expect(ev.commands.map((c) => [c.command, c.kind])).toEqual([
      ["pip install -e .", "install"],
      ["make serve", "start"],
    ]);
  });

  it("tracks the folder each command runs in", () => {
    const ev = mineReadme(MONOREPO_README, { files: files("backend/main.py", "backend/requirements.txt", "frontend/package.json") });
    expect(ev.commands.map((c) => [c.dir, c.command])).toEqual([
      ["backend", "pip install -r requirements.txt"],
      ["backend", "uvicorn main:app --reload --port 8001"],
      ["frontend", "npm install"],
      ["frontend", "npm run dev"],
    ]);
  });

  it("never keeps commands with credentials or template placeholders", () => {
    const readme = `## Setup\n\n${fence}sh\nexport OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz123456\npython app.py --api-key <your-key>\nnpm run dev\n${fence}\n`;
    const ev = mineReadme(readme, { files: files("app.py", "package.json") });
    expect(ev.commands.map((c) => c.command)).toEqual(["npm run dev"]);
    expect(JSON.stringify(ev)).not.toContain("sk-abcdefghijklmnop");
    expect(ev.skipped.map((s) => s.reason)).toContain("is a template with placeholders");
  });

  it("notices a README that installs the published package (a library)", () => {
    const readme = `# requests\n\n## Installation\n\n${fence}\n$ python -m pip install requests\n${fence}\n`;
    const ev = mineReadme(readme, { files: files("pyproject.toml"), packageNames: ["requests"] });
    expect(ev.installsPublished).toBe(true);
    expect(ev.commands).toEqual([]);
  });

  it("weighs headings", () => {
    expect(sectionWeight("Getting Started")).toBe(1);
    expect(sectionWeight("Running locally")).toBe(1);
    expect(sectionWeight("Usage")).toBe(0.6);
    expect(sectionWeight("Deploying to Heroku")).toBe(0);
    expect(sectionWeight("Running with Docker")).toBe(0);
    expect(sectionWeight("Running tests")).toBe(0);
    expect(sectionWeight("Features")).toBeNull();
  });

  it("splits blocks into commands and finds localhost ports", () => {
    expect(blockCommands(["$ npm install", "added 120 packages", "$ npm start", "> app@1.0.0 start"])).toEqual(["npm install", "npm start"]);
    expect(localhostPorts("Open http://localhost:5173 or http://127.0.0.1:8000. Postgres on localhost:5432.")).toEqual([5173, 8000]);
    expect(repoNameFrom("git clone https://github.com/acme/widget-shop.git\ncd widget-shop")).toBe("widget-shop");
  });
});

describe("shell sanitising", () => {
  const opts = { files: files("package.json", "scripts/setup.sh") };

  it("drops what can't or shouldn't run in a box", () => {
    expect(sanitizeCommand("brew install postgresql", opts).skip).toBe("uses a host package manager");
    expect(sanitizeCommand("docker compose up -d", opts)).toMatchObject({ docker: true });
    expect(sanitizeCommand("ssh deploy@example.com", opts).skip).toBe("connects to another machine");
    expect(sanitizeCommand("rm -rf /", opts).skip).toBe("destructive or system-level");
    expect(sanitizeCommand("npx create-next-app my-app", opts).skip).toBe("scaffolds a new project");
    expect(sanitizeCommand("open http://localhost:3000", opts)).toEqual({});
    expect(sanitizeCommand("./scripts/missing.sh", opts).skip).toBe("points at a script that isn't in the repo");
    expect(sanitizeCommand(`npm run dev ${"x".repeat(600)}`, opts).skip).toBe("too long to trust");
  });

  it("rewrites what has a box equivalent", () => {
    expect(sanitizeCommand("sudo npm install -g pnpm", opts).command).toBe("npm install -g pnpm");
    expect(sanitizeCommand("apk add --no-cache build-base postgresql-dev", opts).command).toBe(
      "apt-get update -qq && apt-get install -y --no-install-recommends build-essential libpq-dev",
    );
    expect(sanitizeCommand("pyenv install 3.12.2", opts).version).toEqual({ tool: "python", version: "3.12.2" });
    expect(sanitizeCommand("./scripts/setup.sh", opts).command).toBe("./scripts/setup.sh");
  });

  it("drops a bare script name that isn't in the repo", () => {
    // A line of prose in a layout block (pollen-robotics/microduck's CONTRIBUTING.md) is not a command.
    expect(sanitizeCommand("install.sh does to a board belongs here too", opts)).toEqual({});
    expect(sanitizeCommand("bake-duck-mesh.py (the monitor's 3D model, run by hand)", opts)).toEqual({});
    expect(sanitizeCommand("setup.sh", { files: files("setup.sh") }).command).toBe("setup.sh");
    // Resolved from the folder the block has cd'ed into.
    expect(sanitizeCommand("setup.sh --dev", { files: files("tools/setup.sh"), dir: "tools" }).command).toBe("setup.sh --dev");
    expect(sanitizeCommand("/workspace/run.sh", opts).command).toBe("/workspace/run.sh");
  });

  it("finds no commands in a contributing guide's layout block", () => {
    const guide = `# Contributing\n\n## The layout\n\n${fence}\nrobotd/         control daemon\nhooks/          preinstall and postinstall, what runs inside an update:\n                install.sh does to a board belongs here too (design.md 9.1)\nscripts/        provision.sh · setup-board.sh ·\n                migrate-network.sh · install.sh (on the board) ·\n                bake-duck-mesh.py (the monitor's 3D model, run by hand)\n${fence}\n`;
    const ev = mineReadme(guide, { files: files("Cargo.toml", "scripts/install.sh", "scripts/provision.sh", "scripts/setup-board.sh", "scripts/migrate-network.sh") });
    expect(ev.commands).toEqual([]);
  });

  it("classifies commands", () => {
    expect(classifyCommand("yarn")).toBe("install");
    expect(classifyCommand("bundle exec rails db:setup")).toBe("db");
    expect(classifyCommand("npm run build")).toBe("build");
    expect(classifyCommand("python train.py")).toBe("other");
    expect(classifyCommand("python app.py")).toBe("start");
    expect(classifyCommand("make dev")).toBe("start");
    expect(classifyCommand("cp .env.example .env")).toBe("env");
    expect(classifyCommand("python3 -u server.py")).toBe("start");
    expect(classifyCommand("uv run python scripts/train.py")).toBe("other");
    expect(classifyCommand("python manage.py runserver 0.0.0.0:8000")).toBe("start");
    expect(classifyCommand("python manage.py migrate")).toBe("db");
    expect(classifyCommand("node --watch server.js")).toBe("start");
    expect(classifyCommand("node scripts/seed.js")).toBe("other");
    expect(classifyCommand("bun run src/index.ts")).toBe("start");
    expect(classifyCommand("PORT=4000 npm start")).toBe("start");
    expect(classifyCommand("pnpm --filter web dev")).toBe("start");
    expect(classifyCommand("yarn workspace @acme/app build")).toBe("build");
    expect(classifyCommand("turbo run dev")).toBe("start");
    expect(classifyCommand("cd frontend && npm ci")).toBe("install");
    expect(classifyCommand("npm test")).toBe("other");
  });

  it("splits chains outside quotes and spots secrets", () => {
    expect(splitChain(`npm install && echo "a && b"; npm start &`)).toEqual(["npm install", `echo "a && b"`, "npm start"]);
    // A whole bash -c / sh -c wrapper is unwrapped, so sudo and container-only steps inside it are sanitised too.
    expect(splitChain(`bash -c "sudo chown node node_modules && npm install"`)).toEqual(["sudo chown node node_modules", "npm install"]);
    expect(splitChain(`/bin/sh -ec 'npm ci; npm run build'`)).toEqual(["npm ci", "npm run build"]);
    expect(splitChain(`bash -c "echo \\"hi\\"" && npm test`)).toEqual([`echo "hi"`, "npm test"]);
    // Not the whole segment: left alone.
    expect(splitChain(`bash -c "make" extra`)).toEqual([`bash -c "make" extra`]);
    expect(looksSecret("curl -H 'Authorization: token ghp_abcdefghijklmnopqrstuvwxyz0123456789'")).toBe(true);
    expect(looksSecret("SECRET_KEY=changeme python app.py")).toBe(false);
  });
});
