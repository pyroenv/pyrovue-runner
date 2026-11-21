import { describe, expect, it } from "vitest";
import { parseCompose } from "../../../src/pipeline/evidence/compose";
import { devcontainerEvidence } from "../../../src/pipeline/evidence/devcontainer";
import { dockerEvidence, parseDockerfile } from "../../../src/pipeline/evidence/dockerfile";
import { envFileEvidence, readEnvTemplate } from "../../../src/pipeline/evidence/envfile";
import { appJsonEvidence, flyEvidence, netlifyEvidence } from "../../../src/pipeline/evidence/platform";
import { choosePort, codePorts, commandPort } from "../../../src/pipeline/evidence/ports";
import { procfileEvidence } from "../../../src/pipeline/evidence/procfile";
import { taskRunnerEvidence } from "../../../src/pipeline/evidence/tasks";
import { combineShims, serviceKind, shimFor } from "../../../src/pipeline/services";

const files = (...list: string[]) => new Set(list);

const NEXT_DOCKERFILE = `# syntax=docker/dockerfile:1
FROM node:20-alpine AS deps
RUN apk add --no-cache libc6-compat
WORKDIR /app
COPY package.json pnpm-lock.yaml ./
RUN corepack enable && pnpm install --frozen-lockfile

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
ENV NEXT_TELEMETRY_DISABLED=1
RUN pnpm build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3000 HOSTNAME="0.0.0.0"
RUN addgroup --system --gid 1001 nodejs && adduser --system --uid 1001 nextjs
COPY --from=builder /app/.next/standalone ./
USER nextjs
EXPOSE 3000
CMD ["node", "server.js"]
`;

const DJANGO_DOCKERFILE = `FROM python:3.12-slim
ENV PYTHONUNBUFFERED=1 \\
    DJANGO_SETTINGS_MODULE=config.settings
WORKDIR /code
COPY requirements.txt /code/
RUN pip install --no-cache-dir -r /code/requirements.txt
COPY . /code/
RUN python /code/manage.py collectstatic --noinput
EXPOSE 8000
ENTRYPOINT ["/code/docker-entrypoint.sh"]
CMD ["gunicorn", "config.wsgi:application", "--bind", "0.0.0.0:8000"]
`;

describe("Dockerfile", () => {
  it("follows the final stage back through the stages it copies from", () => {
    const info = parseDockerfile(NEXT_DOCKERFILE)!;
    expect(info.stages.map((s) => s.name)).toEqual(["deps", "builder", "runner"]);
    expect(info.final.expose).toEqual([3000]);

    const ev = dockerEvidence(NEXT_DOCKERFILE, { files: files("package.json", "pnpm-lock.yaml"), dir: ".", name: "Dockerfile" })!;
    expect(ev.setup).toEqual(["corepack enable", "pnpm install --frozen-lockfile", "pnpm build"]);
    expect(ev.start).toBe("node server.js");
    expect(ev.ports).toEqual([3000]);
    expect(ev.runtime).toEqual({ tool: "node", version: "20" });
    // Production mode and container users don't carry over.
    expect(ev.env).toEqual({ PORT: "3000", HOSTNAME: "0.0.0.0" });
    expect(ev.skipped.map((s) => s.reason)).toContain("destructive or system-level");
  });

  it("replays a build stage's output copied to a named file, so the start command finds it", () => {
    const java = `FROM maven:3.9-eclipse-temurin-17 AS build
WORKDIR /app
COPY pom.xml .
RUN mvn -q -e -B dependency:go-offline
COPY src ./src
RUN mvn -q -B clean package -DskipTests

FROM eclipse-temurin:17-jre
WORKDIR /app
COPY --from=build /app/target/*.jar app.jar
EXPOSE 8080
ENTRYPOINT ["java", "-jar", "app.jar"]
`;
    const ev = dockerEvidence(java, { files: files("pom.xml", "src/main/java/App.java"), dir: ".", name: "Dockerfile" })!;
    expect(ev.setup.at(-1)).toBe("mkdir -p /workspace && cp -r /workspace/target/*.jar /workspace/app.jar");
    expect(ev.setup.indexOf("mkdir -p /workspace && cp -r /workspace/target/*.jar /workspace/app.jar")).toBeGreaterThan(
      ev.setup.findIndex((c) => c.includes("clean package")),
    );
    expect(ev.start).toBe("java -jar app.jar");
    expect(ev.ports).toEqual([8080]);
  });

  it("doesn't replay copies into a directory, from other images, or onto themselves", () => {
    const df = `FROM golang:1.22 AS build
WORKDIR /src
COPY . .
RUN go build -o /out/server ./cmd/server

FROM gcr.io/distroless/base
COPY --from=build /out/server /server
COPY --from=build /src/static ./
COPY --from=busybox:1.36 /bin/sh /bin/sh
COPY --from=build /src/config.yml /src/config.yml
CMD ["/server"]
`;
    const ev = dockerEvidence(df, { files: files("go.mod", "cmd/server/main.go", "config.yml"), dir: ".", name: "Dockerfile" })!;
    expect(ev.setup.some((c) => c.startsWith("mkdir -p"))).toBe(false);
  });

  it("maps image paths to the checkout and skips entrypoint wrappers", () => {
    const ev = dockerEvidence(DJANGO_DOCKERFILE, { files: files("manage.py", "requirements.txt", "docker-entrypoint.sh"), dir: ".", name: "Dockerfile" })!;
    expect(ev.setup).toEqual(["pip install --no-cache-dir -r /workspace/requirements.txt", "python /workspace/manage.py collectstatic --noinput"]);
    expect(ev.start).toBe("gunicorn config.wsgi:application --bind 0.0.0.0:8000");
    expect(ev.env).toEqual({ PYTHONUNBUFFERED: "1", DJANGO_SETTINGS_MODULE: "config.settings" });
    expect(ev.runtime).toEqual({ tool: "python", version: "3.12" });
  });
});

const COMPOSE = `version: "3.9"
services:
  web:
    build: .
    command: python manage.py runserver 0.0.0.0:8000
    volumes:
      - .:/code
    ports:
      - "8000:8000"
    environment:
      - DATABASE_URL=postgres://app:secret@db:5432/app
      - REDIS_URL=redis://redis:6379/0
    depends_on:
      - db
      - redis
  worker:
    build: .
    command: celery -A proj worker -l info
    depends_on: [db]
  db:
    image: postgres:16-alpine
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: secret
      POSTGRES_DB: app
  redis:
    image: "redis:7-alpine"
  search:
    image: docker.elastic.co/elasticsearch/elasticsearch:8.13.0
`;

describe("docker-compose", () => {
  it("finds the app service, its command and ports, and the services next to it", () => {
    const info = parseCompose(COMPOSE)!;
    expect(info.app?.name).toBe("web");
    expect(info.app?.command).toBe("python manage.py runserver 0.0.0.0:8000");
    expect(info.app?.ports).toEqual([8000]);
    expect(info.app?.mount).toBe("/code");
    // Service hostnames become localhost: everything runs in one box.
    expect(info.app?.env.DATABASE_URL).toBe("postgres://app:secret@localhost:5432/app");
    expect(info.app?.env.REDIS_URL).toBe("redis://localhost:6379/0");
    expect(info.companions.map((c) => [c.name, c.kind])).toEqual([
      ["db", "postgres"],
      ["redis", "redis"],
      ["search", "elasticsearch"],
    ]);
  });

  it("interpolates variables with defaults", () => {
    const info = parseCompose(`services:\n  app:\n    build: ./api\n    ports: ["\${API_PORT:-4000}:4000"]\n    environment:\n      PORT: \${API_PORT:-4000}\n`)!;
    expect(info.app?.context).toBe("api");
    expect(info.app?.env.PORT).toBe("4000");
  });

  it("shims databases with the settings the project expects", () => {
    expect(serviceKind("bitnami/postgresql:16")).toBe("postgres");
    expect(serviceKind("library/mariadb:11")).toBe("mysql");
    expect(serviceKind("nginx:alpine")).toBeNull();
    const pg = shimFor("postgres", { user: "app", password: "secret", database: "app" })!;
    expect(pg.env.DATABASE_URL).toBe("postgresql://app:secret@localhost:5432/app");
    expect(shimFor("mongo")).toBeNull();
    // Unsafe settings never reach a shell command.
    const odd = shimFor("postgres", { user: "x'; DROP", password: "$(reboot)" })!;
    expect(odd.init.join(" ")).not.toMatch(/DROP|reboot/);
    const set = combineShims([pg, shimFor("redis")!]);
    expect(set.setup[0]).toBe("apt-get update -qq && apt-get install -y --no-install-recommends postgresql redis-server");
    expect(set.prelude).toContain("service postgresql start");
    expect(set.env.REDIS_URL).toBe("redis://localhost:6379");
  });
});

describe("Procfile", () => {
  it("reads the web and release processes", () => {
    const ev = procfileEvidence("web: bundle exec puma -C config/puma.rb\nrelease: bundle exec rails db:migrate\nworker: bundle exec sidekiq\n", {
      files: files("Gemfile"),
      file: "Procfile",
    });
    expect(ev.web).toBe("bundle exec puma -C config/puma.rb");
    expect(ev.release).toEqual(["bundle exec rails db:migrate"]);
    expect(ev.watchers).toEqual([]);
  });

  it("runs Procfile.dev asset watchers next to the server", () => {
    const ev = procfileEvidence("web: bin/rails server -p 3000\ncss: bin/rails tailwindcss:watch\n", { files: files("bin/rails"), file: "Procfile.dev" });
    // The start string production builds from these is asserted through detect in pipeline/candidates.test.ts.
    expect(ev.web).toBe("bin/rails server -p 3000");
    expect(ev.watchers).toEqual(["bin/rails tailwindcss:watch"]);
  });
});

describe("devcontainer.json", () => {
  it("reads lifecycle commands, ports, env and runtimes, with comments and trailing commas", () => {
    const text = `{
      // A comment
      "name": "app",
      "image": "mcr.microsoft.com/devcontainers/typescript-node:1-20-bookworm",
      "features": { "ghcr.io/devcontainers/features/python:1": { "version": "3.12" } },
      "forwardPorts": [3000, 5432],
      "postCreateCommand": "npm install && npx prisma migrate deploy",
      "postStartCommand": "npm run dev &",
      "containerEnv": {
        "DATABASE_URL": "postgresql://postgres:postgres@localhost:5432/app",
        "GITHUB_TOKEN": "\${localEnv:GITHUB_TOKEN}",
      },
    }`;
    const ev = devcontainerEvidence(text, { files: files("package.json"), file: ".devcontainer/devcontainer.json" })!;
    expect(ev.setup).toEqual(["npm install", "npx prisma migrate deploy"]);
    expect(ev.start).toBe("npm run dev");
    expect(ev.ports).toEqual([3000]);
    expect(ev.env).toEqual({ DATABASE_URL: "postgresql://postgres:postgres@localhost:5432/app" });
    expect(ev.runtimes).toEqual(expect.arrayContaining([{ tool: "node", version: "20" }, { tool: "python", version: "3.12" }]));
  });
});

describe("devcontainer.json wrappers", () => {
  it("unwraps bash -c, dropping sudo and chown for container users", () => {
    const text = `{ "image": "mcr.microsoft.com/devcontainers/javascript-node:24", "postCreateCommand": "bash -c \\"sudo chown node node_modules && npm install\\"" }`;
    const ev = devcontainerEvidence(text, { files: files("package.json"), file: ".devcontainer/devcontainer.json" })!;
    expect(ev.setup).toEqual(["npm install"]);
  });
});

describe("task runners", () => {
  it("picks install and dev targets from a Makefile", () => {
    const make = ".PHONY: install dev docker\n\ninstall:\n\tpip install -r requirements.txt\n\ndev: install\n\tuvicorn app.main:app --reload\n\ndocker:\n\tdocker compose up --build\n";
    const ev = taskRunnerEvidence(make, { files: files("requirements.txt"), file: "Makefile" })!;
    expect(ev).toMatchObject({ runner: "make", install: "make install", start: "make dev", prefix: [] });
    expect(ev.targets).toEqual(["install", "dev", "docker"]);
  });

  it("skips targets that need Docker, even through another target", () => {
    const make = "up:\n\tdocker compose up\n\ndev: up\n\nrun:\n\tpython app.py\n";
    const ev = taskRunnerEvidence(make, { files: files("app.py"), file: "Makefile" })!;
    expect(ev.start).toBe("make run");
    expect(ev.skipped[0]?.reason).toMatch(/uses Docker/);
  });

  it("reads justfiles and Taskfiles, and installs the runner", () => {
    const just = taskRunnerEvidence("default:\n  just --list\n\nsetup:\n  npm ci\n\ndev:\n  npm run dev\n", { files: files(), file: "justfile" })!;
    expect(just).toMatchObject({ runner: "just", install: "just setup", start: "just dev" });
    expect(just.prefix[0]).toContain("mise use -g just@latest");
    const task = taskRunnerEvidence("version: '3'\ntasks:\n  install:\n    cmds:\n      - go mod download\n  serve:\n    cmds:\n      - go run ./cmd/server\n", { files: files(), file: "Taskfile.yml" })!;
    expect(task).toMatchObject({ runner: "task", install: "task install", start: "task serve" });
  });
});

describe(".env templates", () => {
  it("copies the template, fills app secrets and the port, and lists third-party keys", () => {
    const template = readEnvTemplate(".env.example", "# App\nSECRET_KEY=changeme\nDATABASE_URL=postgresql://user:password@localhost:5432/mydb\nOPENAI_API_KEY=your-openai-key\nPORT=8000\nDEBUG=true\n");
    const ev = envFileEvidence(template, { port: 8000 });
    expect(ev.copy).toBe("test -f /workspace/.env || cp /workspace/.env.example /workspace/.env");
    expect(ev.fill.SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.fill.PORT).toBe("8000");
    expect(ev.fill.DATABASE_URL).toBeUndefined();
    expect(ev.needs).toEqual(["OPENAI_API_KEY"]);
    expect(ev.services).toEqual(["postgres"]);
  });

  it("points placeholder database URLs at a local database", () => {
    const template = readEnvTemplate("backend/.env.sample", "DATABASE_URL=<your database url>\nREDIS_URL=redis://cache.example.com:6379\nAPP_KEY=\n");
    const ev = envFileEvidence(template, { port: null, serviceEnv: { REDIS_URL: "redis://localhost:6379" }, sqliteUrl: "sqlite:///db.sqlite3" });
    expect(template.target).toBe("backend/.env");
    expect(ev.fill.DATABASE_URL).toBe("sqlite:///db.sqlite3");
    expect(ev.fill.REDIS_URL).toBe("redis://localhost:6379");
    expect(ev.fill.APP_KEY).toMatch(/^base64:/);
  });
});

describe("hosting configs", () => {
  it("reads fly.toml", () => {
    const ev = flyEvidence(
      `app = "x"\n\n[deploy]\n  release_command = "python manage.py migrate"\n\n[http_service]\n  internal_port = 8080\n\n[processes]\n  app = "gunicorn myproj.wsgi --bind :8080"\n\n[env]\n  DJANGO_SETTINGS_MODULE = "myproj.settings"\n`,
      files("manage.py"),
    )!;
    expect(ev).toMatchObject({ start: "gunicorn myproj.wsgi --bind :8080", port: 8080, setup: ["python manage.py migrate"], env: { DJANGO_SETTINGS_MODULE: "myproj.settings" } });
  });

  it("prefers netlify's dev command", () => {
    const ev = netlifyEvidence(`[build]\n  command = "npm run build"\n  publish = "dist"\n\n[dev]\n  command = "npm run start"\n  targetPort = 3000\n`, files("package.json"))!;
    expect(ev).toMatchObject({ start: "npm run start", port: 3000, publish: null });
  });

  it("reads app.json env, generated secrets and add-ons", () => {
    const ev = appJsonEvidence(
      JSON.stringify({
        env: { SECRET_KEY_BASE: { generator: "secret" }, LANG: "en_US.UTF-8", STRIPE_API_KEY: { required: true, description: "Stripe" } },
        addons: ["heroku-postgresql:mini", { plan: "heroku-redis:mini" }],
        scripts: { postdeploy: "bundle exec rake db:seed" },
      }),
      files("Gemfile"),
    )!;
    expect(ev.secrets).toEqual(["SECRET_KEY_BASE"]);
    expect(ev.env).toEqual({ LANG: "en_US.UTF-8" });
    expect(ev.required.map((r) => r.name)).toEqual(["STRIPE_API_KEY"]);
    expect(ev.addons).toEqual(["heroku-postgresql:mini", "heroku-redis:mini"]);
    expect(ev.setup).toEqual(["bundle exec rake db:seed"]);
  });
});

describe("port evidence", () => {
  it("reads ports from commands and code", () => {
    expect(commandPort("uvicorn main:app --port 8001")).toBe(8001);
    expect(commandPort("python manage.py runserver 0.0.0.0:8000")).toBe(8000);
    expect(commandPort("rails s -p 3001")).toBe(3001);
    expect(commandPort("npm run dev")).toBeNull();
    expect(codePorts("const port = process.env.PORT || 4000;\napp.listen(port)")).toEqual([4000]);
    expect(codePorts('app.run(host="0.0.0.0", port=5001, debug=True)')).toContain(5001);
    expect(codePorts('http.ListenAndServe(":8090", nil)')).toEqual([8090]);
  });

  it("ranks EXPOSE over env over README over code over the framework default", () => {
    const hints = [
      { port: 3000, source: "default" as const },
      { port: 4000, source: "code" as const },
      { port: 8080, source: "readme" as const },
    ];
    expect(choosePort(hints)).toBe(8080);
    expect(choosePort([...hints, { port: 5000, source: "env" as const }])).toBe(5000);
    expect(choosePort([...hints, { port: 5000, source: "env" as const }, { port: 9090, source: "expose" as const }])).toBe(9090);
    expect(choosePort([{ port: 5432, source: "expose" }])).toBeNull();
  });
});
