import { describe, expect, it } from "vitest";
import { describePlan, normalizeCommand, pinCommand } from "../../src/pipeline/candidates";
import { detect, detectorTrust, type Plan } from "../../src/pipeline/detect";
import { posteriorMean, rankPlans } from "../../src/pipeline/ranking";

const fence = "```";
const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const pkg = (p: object) => JSON.stringify(p);
const all = (plan: Plan) => [plan, ...(plan.alternatives ?? [])];
const byStrategy = (plan: Plan, strategy: string) => all(plan).find((p) => p.strategy === strategy);

describe("candidate plans", () => {
  it("tags plans with a strategy, prior and stack signature", () => {
    const plan = detect(snap({ "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "^6" } }) }, ["pnpm-lock.yaml"]));
    expect(plan).toMatchObject({ strategy: "framework", signature: "node:vite:pnpm", confidence: "high" });
    expect(plan.prior).toBeCloseTo(0.8);
    expect(plan.facts).toMatchObject({ pm: "pnpm", scripts: ["dev"] });
    expect(plan.alternatives).toBeUndefined();

    const django = detect(snap({ "manage.py": "", "requirements.txt": "Django==5.0\n" }));
    expect(django.signature).toBe("python:django:requirements");
    expect(django.facts?.migrate).toBe("python manage.py migrate --noinput");
  });

  it("merges a README that agrees with the framework, and keeps one that doesn't as an alternative", () => {
    const readme = `# App\n\n## Getting started\n\n${fence}sh\npnpm install\npnpm dev\n${fence}\n\n## Storybook\n\n${fence}sh\npnpm storybook\n${fence}\n`;
    const agree = detect(snap({ "README.md": readme, "package.json": pkg({ scripts: { dev: "vite", storybook: "storybook dev" }, devDependencies: { vite: "6" } }) }, ["pnpm-lock.yaml"]));
    expect(agree.strategy).toBe("framework");
    // Two sources saying the same thing make it more likely.
    expect(agree.prior).toBeGreaterThan(0.85);

    const differs = `# App\n\n## Development\n\n${fence}sh\nnpm install\nnpm run dev:all\n${fence}\n`;
    const plan = detect(snap({ "README.md": differs, "package.json": pkg({ scripts: { dev: "vite", "dev:all": "concurrently vite api" }, devDependencies: { vite: "6" } }) }));
    expect(plan.strategy).toBe("framework");
    expect(byStrategy(plan, "readme")).toMatchObject({ start: "npm run dev:all", setup: ["npm install --no-audit --no-fund"], rationale: "The README.md says `npm run dev:all`. Trying that." });
  });

  it("ignores README commands that reference scripts or files the repo doesn't have", () => {
    const readme = `## Quick start\n\n${fence}\nnpm install\nnpm run start:legacy\npython old_server.py\n${fence}\n`;
    const plan = detect(snap({ "README.md": readme, "package.json": pkg({ scripts: { dev: "next dev" }, dependencies: { next: "15" } }) }));
    expect(all(plan).map((p) => p.start)).not.toContain("npm run start:legacy");
    expect(all(plan).some((p) => /old_server/.test(p.start ?? ""))).toBe(false);
  });

  it("lets explicit evidence beat a weak framework guess", () => {
    const plan = detect(
      snap(
        {
          "requirements.txt": "gunicorn\nfalcon\n",
          Procfile: "web: gunicorn service.app:api --bind 0.0.0.0:$PORT\n",
          "service/app.py": "import falcon\napi = falcon.App()\n",
        },
        ["service/__init__.py"],
      ),
    );
    expect(plan).toMatchObject({ strategy: "procfile", start: "gunicorn service.app:api --bind 0.0.0.0:$PORT", setup: ["uv pip install -r requirements.txt"] });
    expect(plan.env.PORT).toBe("5000");
    expect(plan.rationale).toBe("The Procfile runs `gunicorn service.app:api --bind 0.0.0.0:$PORT`. Trying that.");
    expect(plan.facts?.localModules).toContain("service");
  });

  it("runs a Rails Procfile.dev with Postgres in the box and the pinned Ruby", () => {
    const plan = detect(
      snap(
        {
          Gemfile: "source 'https://rubygems.org'\ngem 'rails'\ngem 'pg'\n",
          ".ruby-version": "3.2.2\n",
          "Procfile.dev": "web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\n",
          "config/application.rb": "",
          "config/database.yml": "default: &default\n  adapter: postgresql\n  encoding: unicode\n",
        },
        ["bin/rails", "bin/dev"],
      ),
    );
    expect(plan.strategy).toBe("procfile");
    expect(plan.setup[0]).toBe("mise use -g ruby@3.2.2");
    expect(plan.setup).toEqual(expect.arrayContaining(["apt-get update -qq && apt-get install -y --no-install-recommends postgresql", "bundle install"]));
    expect(plan.start).toBe("service postgresql start >/dev/null 2>&1 || true; (bin/rails tailwindcss:watch) & bin/rails server -p 3000");
    expect(plan.env.DATABASE_URL).toBe("postgresql://postgres:postgres@localhost:5432/app");
    expect(plan.notes).toEqual(expect.arrayContaining([expect.stringMatching(/PostgreSQL runs inside the box/)]));
    expect(byStrategy(plan, "framework")?.setup[0]).toBe("mise use -g ruby@3.2.2");
  });

  const compose = (command: string) =>
    `services:\n  web:\n    build: .\n    command: ${command}\n    volumes:\n      - .:/code\n    ports:\n      - "8000:8000"\n    environment:\n      DATABASE_URL: postgres://app:secret@db:5432/app\n    depends_on: [db, mongo]\n  db:\n    image: postgres:16\n    environment:\n      POSTGRES_USER: app\n      POSTGRES_PASSWORD: secret\n      POSTGRES_DB: app\n  mongo:\n    image: mongo:7\n`;

  it("follows docker-compose: the app's command, its database, and notes for what can't run", () => {
    const plan = detect(snap({ "docker-compose.yml": compose("sh -c \"python manage.py migrate && gunicorn proj.wsgi -b 0.0.0.0:8000 --reload\""), "manage.py": "", "requirements.txt": "django\n" }));
    const c = byStrategy(plan, "compose")!;
    expect(c.start).toBe("service postgresql start >/dev/null 2>&1 || true; gunicorn proj.wsgi -b 0.0.0.0:8000 --reload");
    expect(c.setup.at(-1)).toBe("python manage.py migrate");
    expect(c.env.DATABASE_URL).toBe("postgres://app:secret@localhost:5432/app");
    expect(c.port).toBe(8000);
    expect(c.rationale).toMatch(/^docker-compose\.yml runs the web service with `gunicorn/);
    // Every plan gets the same database, created with the compose settings.
    expect(plan.setup.join("\n")).toContain('createdb -O "app" "app"');
    expect(plan.notes?.join(" ")).toMatch(/MongoDB \(mongo\) isn't packaged/);
  });

  it("merges a compose service that runs exactly what the framework would", () => {
    const plan = detect(snap({ "docker-compose.yml": compose("python manage.py runserver 0.0.0.0:8000"), "manage.py": "", "requirements.txt": "django\n" }));
    expect(byStrategy(plan, "compose")).toBeUndefined();
    expect(plan).toMatchObject({ strategy: "framework", start: "service postgresql start >/dev/null 2>&1 || true; python manage.py runserver 0.0.0.0:8000" });
    expect(plan.env.DATABASE_URL).toMatch(/^postgres(ql)?:\/\/app:secret@localhost:5432\/app$/);
    expect(plan.prior).toBeGreaterThan(0.85);
  });

  it("copies .env.example, fills app secrets, and asks for third-party keys", () => {
    const plan = detect(
      snap({
        "package.json": pkg({ scripts: { dev: "next dev" }, dependencies: { next: "15", "@prisma/client": "5" }, devDependencies: { prisma: "5" } }),
        ".env.example": "DATABASE_URL=postgresql://postgres:postgres@localhost:5432/shop\nNEXTAUTH_SECRET=\nNEXTAUTH_URL=http://localhost:3000\nOPENAI_API_KEY=sk-...\n",
        "prisma/schema.prisma": 'datasource db {\n  provider = "postgresql"\n  url      = env("DATABASE_URL")\n}\n',
      }),
    );
    expect(plan.setup).toContain("test -f /workspace/.env || cp /workspace/.env.example /workspace/.env");
    expect(plan.env.NEXTAUTH_SECRET).toMatch(/^[0-9a-f]{64}$/);
    // The template already points at a local database, so the shim is created to match it rather than overriding it.
    expect(plan.env.DATABASE_URL).toBeUndefined();
    expect(plan.setup.join("\n")).toContain('createdb -O "postgres" "shop"');
    expect(plan.notes?.join(" ")).toMatch(/Add your own OPENAI_API_KEY/);
    expect(plan.facts?.migrate).toContain("prisma migrate deploy");
    // The filled values reach .env through the command's environment; the secret itself never appears in a command.
    const fill = plan.setup.find((c) => c.startsWith("node -e "));
    expect(fill).toMatch(/\/workspace\/\.env\.example \/workspace\/\.env NEXTAUTH_SECRET/);
    expect(plan.setup.join("\n")).not.toContain(plan.env.NEXTAUTH_SECRET!);
  });

  it("runs Laravel against MariaDB with matching DB_* settings, and its Vite watcher alongside", () => {
    const readme = `## Installation\n\n${fence}bash\ncomposer install\ncp .env.example .env\nphp artisan key:generate\nphp artisan migrate\nnpm install && npm run dev\nphp artisan serve\n${fence}\n`;
    const plan = detect(
      snap({
        "composer.json": "{}",
        artisan: "",
        "package.json": pkg({ scripts: { dev: "vite", build: "vite build" }, devDependencies: { vite: "5" } }),
        ".env.example": "APP_KEY=\nDB_CONNECTION=mysql\nDB_HOST=127.0.0.1\nDB_DATABASE=laravel\nDB_USERNAME=root\nDB_PASSWORD=\n",
        "README.md": readme,
      }),
    );
    expect(plan.signature).toBe("php:laravel:composer");
    expect(plan.env).toMatchObject({ DB_HOST: "127.0.0.1", DB_DATABASE: "laravel", DB_USERNAME: "root", DB_PASSWORD: "root" });
    expect(plan.env.APP_KEY).toMatch(/^base64:/);
    expect(plan.setup.join("\n")).toContain("mariadb-server");
    const r = byStrategy(plan, "readme")!;
    expect(r.start).toBe("service mariadb start >/dev/null 2>&1 || true; (cd /workspace && npm run dev) & php artisan serve");
    // composer isn't in the box until something installs it.
    expect(r.setup.find((c) => c.startsWith("command -v composer"))).toMatch(/\|\| \(apt-get update -qq && apt-get install .*composer\)$/);
  });

  it("runs a backend and a frontend together when the README starts both", () => {
    const readme = `# Fullstack\n\n## Local development\n\n### Backend\n\n${fence}sh\ncd backend\npip install -r requirements.txt\nuvicorn main:app --reload --port 8001\n${fence}\n\n### Frontend\n\n${fence}sh\ncd frontend\nnpm install\nnpm run dev\n${fence}\n`;
    const plan = detect(
      snap({
        "README.md": readme,
        "frontend/package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }),
        "backend/requirements.txt": "fastapi\nuvicorn\n",
        "backend/main.py": "from fastapi import FastAPI\napp = FastAPI()\n",
      }),
    );
    const r = byStrategy(plan, "readme")!;
    expect(r.cwd).toBe("/workspace/frontend");
    // The backend gets its own PORT; the preview's port is the frontend's, never the backend's --port 8001.
    expect(r.start).toBe("(cd /workspace/backend && PORT=8001 uvicorn main:app --reload --port 8001) & npm run dev");
    expect(r.port).toBe(5173);
    expect(r.env.PORT).toBe("5173");
    expect(r.services?.[0]).toMatchObject({ cwd: "/workspace/backend", command: "uvicorn main:app --reload --port 8001", port: 8001 });
    expect(r.setup).toEqual(["cd /workspace/backend && uv pip install -r requirements.txt", "npm install --no-audit --no-fund"]);
    // The backend on its own is an alternative too.
    expect(all(plan).some((p) => p.cwd === "/workspace/backend" && /uvicorn main:app/.test(p.start ?? ""))).toBe(true);
  });

  it("uses a Makefile and a Dockerfile when there's no manifest Pyrovue knows", () => {
    const plan = detect(
      snap({
        Makefile: "deps:\n\tcabal update\n\ndev:\n\tcabal run server\n",
        Dockerfile: "FROM haskell:9.6\nWORKDIR /app\nCOPY . .\nRUN cabal update && cabal build\nEXPOSE 8080\nCMD [\"cabal\", \"run\", \"server\"]\n",
        "README.md": `## Running\n\n${fence}\nmake dev\n${fence}\n\nIt listens on http://localhost:8080.\n`,
      }),
    );
    // `cabal` isn't a known command, so nothing from these is run blindly.
    expect(all(plan).every((p) => !/cabal/.test(p.setup.join(" ")))).toBe(true);
    expect(all(plan).map((p) => p.strategy)).toEqual(expect.arrayContaining(["readme"]));
    expect(byStrategy(plan, "readme")?.start).toBe("make dev");
    expect(byStrategy(plan, "readme")?.port).toBe(8080);
  });

  it("pins runtimes from version files for every plan", () => {
    const plan = detect(
      snap({
        "requirements.txt": "flask\n",
        "app.py": "from flask import Flask\napp = Flask(__name__)\n",
        ".tool-versions": "python 3.10.13\nnodejs 18.17.0\n",
        Procfile: "web: python app.py\n",
      }),
    );
    for (const p of all(plan)) expect(p.setup[0]).toBe("mise use -g node@18");
    for (const p of all(plan)) expect(p.setup[1]).toBe("uv venv --seed --python 3.10 /opt/venv --allow-existing");
    expect(pinCommand("node", "22.3.0")).toBeNull();
    expect(pinCommand("python", "3.11.4")).toBeNull();
    expect(pinCommand("python", "3.12")).toContain("--python 3.12");
  });

  it("respects the repo's pyrovue.json first", () => {
    const plan = detect(snap({ "pyrovue.json": JSON.stringify({ setup: ["make deps"], start: "make dev", port: 4000 }), "package.json": pkg({ scripts: { dev: "vite" }, devDependencies: { vite: "6" } }) }));
    expect(plan).toMatchObject({ strategy: "pyrovue-json", start: "make dev", setup: ["make deps"] });
    expect(byStrategy(plan, "framework")?.start).toBe("npm run dev");
  });

  it("normalises equivalent commands so sources agree", () => {
    expect(normalizeCommand("npm i")).toBe("npm install --no-audit --no-fund");
    expect(normalizeCommand("yarn")).toBe("YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install");
    expect(normalizeCommand("pnpm dev")).toBe("pnpm run dev");
    expect(normalizeCommand("npm start")).toBe("npm run start");
    expect(normalizeCommand("yarn dev --host")).toBe("yarn run dev --host");
    expect(normalizeCommand("python -m pip install -r requirements.txt")).toBe("uv pip install -r requirements.txt");
    expect(normalizeCommand("npx vite")).toBe("npx vite");
  });

  it("summarises evidence for the agent", () => {
    const readme = `## Setup\n\n${fence}\ndocker compose up\nnpm install\nnpm run dev:all\n${fence}\n`;
    const plan = detect(snap({ "README.md": readme, "package.json": pkg({ scripts: { dev: "vite", "dev:all": "x" }, devDependencies: { vite: "6" } }) }));
    const text = describePlan(plan);
    expect(text).toContain("strategy: framework");
    expect(text).toContain("README.md: left out `docker compose up` (uses Docker)");
    expect(text).toMatch(/- readme: setup .*; start npm run dev:all/);
  });
});

describe("learning", () => {
  const plans: Plan[] = [
    { stack: [], kind: "web", summary: "", setup: [], start: "a", port: 3000, env: {}, cwd: "/workspace", previewPath: null, confidence: "high", strategy: "framework", prior: 0.8, signature: "node:vite:npm" },
    { stack: [], kind: "web", summary: "", setup: [], start: "b", port: 3000, env: {}, cwd: "/workspace", previewPath: null, confidence: "medium", strategy: "readme", prior: 0.65, signature: "node:vite:npm" },
  ];

  it("uses a Beta posterior over recorded outcomes", () => {
    expect(posteriorMean(0.8)).toBeCloseTo(0.8);
    expect(posteriorMean(0.8, 0, 4)).toBeCloseTo(0.4);
    expect(posteriorMean(0.5, 6, 0)).toBeCloseTo(0.8);
  });

  it("re-ranks strategies that keep failing for this kind of project, deterministically", () => {
    expect(rankPlans(plans).map((p) => p.strategy)).toEqual(["framework", "readme"]);
    const stats: Record<string, { key: string; successes: number; failures: number }[]> = {
      "strategy:node:vite:npm": [
        { key: "framework", successes: 1, failures: 6 },
        { key: "readme", successes: 5, failures: 0 },
      ],
    };
    const learning = { stats: (scope: string) => stats[scope] ?? [] };
    expect(rankPlans(plans, learning).map((p) => p.strategy)).toEqual(["readme", "framework"]);
    expect(rankPlans(plans, learning).map((p) => p.strategy)).toEqual(["readme", "framework"]);
    expect(detectorTrust(plans[0]!, learning)).toBeCloseTo((0.8 * 4 + 1) / (4 + 7));
    expect(detectorTrust(plans[0]!)).toBeCloseTo(0.8);
  });

  it("falls back to outcomes from the same language at half weight", () => {
    const learning = { stats: (scope: string) => (scope === "strategy:node" ? [{ key: "framework", successes: 0, failures: 10 }] : []) };
    // The detector-first gate reads only the exact stack's record; ordering alternatives still uses the language's.
    expect(detectorTrust(plans[0]!, learning)).toBeCloseTo(0.8);
    expect(rankPlans(plans, learning)[0]?.strategy).toBe("readme");
  });
});
