import { describe, expect, it } from "vitest";
import type { Plan } from "../../src/pipeline/plan";
import { rankRepairs } from "../../src/pipeline/ranking";
import { matchRepairs, nodeMajorFor, npmPackageOf, packageForHeader, pypiFor, pythonFor, REPAIR_RULES } from "../../src/pipeline/repairs";

const plan = (over: Partial<Plan> = {}): Plan => ({
  stack: ["Node.js"],
  kind: "web",
  summary: "",
  setup: [],
  start: "npm run dev",
  port: 3000,
  env: {},
  cwd: "/workspace",
  previewPath: null,
  confidence: "high",
  ...over,
});

/** The first matching rule's id and fix. */
const best = (phase: "install" | "launch", command: string, output: string, p: Plan = plan()) => {
  const m = matchRepairs(phase, command, output, p)[0];
  return m ? { id: m.rule.id, ...m.fix } : null;
};

describe("repair knowledge base", () => {
  it("has unique ids, descriptions and priors", () => {
    const ids = REPAIR_RULES.map((r) => r.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const r of REPAIR_RULES) {
      expect(r.description.length).toBeGreaterThan(20);
      expect(r.prior ?? 0.5).toBeGreaterThan(0);
    }
  });

  it("retries npm peer conflicts with --legacy-peer-deps", () => {
    const out = `npm error code ERESOLVE\nnpm error ERESOLVE unable to resolve dependency tree\nnpm error Could not resolve dependency:\nnpm error peer react@"^17.0.0" from react-beautiful-dnd@13.1.1`;
    expect(best("install", "npm install --no-audit --no-fund", out)).toMatchObject({ id: "npm-peer-deps", retry: "npm install --no-audit --no-fund --legacy-peer-deps" });
    expect(best("install", "npm ci", out)?.retry).toBe("npm install --legacy-peer-deps");
  });

  it("installs a newer PHP when Composer needs one (seen on laravel/laravel)", () => {
    const out = `Your requirements could not be resolved to an installable set of packages.\n\n  Problem 1\n    - Root composer.json requires php ^8.3 but your php version (8.2.34) does not satisfy that requirement.`;
    const fix = best("install", "composer install --no-interaction", out);
    expect(fix).toMatchObject({ id: "php-version" });
    expect(fix?.run?.[0]).toContain("packages.sury.org");
    expect(fix?.run?.[1]).toContain("php8.3-cli");
    expect(fix?.run?.[1]).toContain("update-alternatives --set php /usr/bin/php8.3");
    // A PHP-only constraint message without the version mismatch isn't this rule's business.
    expect(best("install", "composer install", "Root composer.json requires php ^8.3")?.id).not.toBe("php-version");
  });

  it("switches Node when the engines field excludes the box's version", () => {
    const yarn = `error next@14.0.0: The engine "node" is incompatible with this module. Expected version "^18.0.0". Got "22.11.0"`;
    expect(best("install", "yarn install", yarn)).toMatchObject({ id: "node-engine", run: ["mise use -g node@18"] });
    const pnpm = `ERR_PNPM_UNSUPPORTED_ENGINE  Unsupported environment (bad pnpm and/or Node.js version)\n\nYour Node version is incompatible with "/workspace".\n\nExpected version: >=18 <21\nGot: v22.11.0`;
    expect(best("install", "pnpm install --no-frozen-lockfile", pnpm)).toMatchObject({ id: "node-engine", run: ["mise use -g node@20"] });
    // A range that allows Node 22 is not a version problem.
    expect(matchRepairs("install", "yarn install", `The engine "node" is incompatible with this module. Expected version ">=16". Got "22.1.0"`, plan()).map((m) => m.rule.id)).not.toContain("node-engine");
    expect(nodeMajorFor("^16 || ^18")).toBe(18);
    expect(nodeMajorFor(">=18")).toBeNull();
    expect(nodeMajorFor("14.x")).toBe(14);
  });

  it("prepares the pinned Yarn with corepack", () => {
    const out = `error This project's package.json defines "packageManager": "yarn@4.1.0". However the current global version of Yarn is 1.22.22.`;
    expect(best("install", "YARN_ENABLE_IMMUTABLE_INSTALLS=false yarn install", out)).toMatchObject({
      id: "corepack-pm",
      run: ["corepack enable", "corepack prepare yarn@4.1.0 --activate"],
    });
  });

  it("installs build tools for node-gyp and -dev packages for missing headers", () => {
    expect(best("install", "npm install", "gyp ERR! build error\ngyp ERR! stack Error: `make` failed with exit code: 2")?.id).toBe("node-gyp");
    const ffi = best("install", "uv pip install -r requirements.txt", "c/_cffi_backend.c:15:10: fatal error: ffi.h: No such file or directory\n   15 | #include <ffi.h>");
    expect(ffi).toMatchObject({ id: "native-header" });
    expect(ffi?.run?.[0]).toMatch(/apt-get install -y --no-install-recommends libffi-dev$/);
    const xml = best("install", "pip install lxml", "src/lxml/includes/etree_defs.h:14:10: fatal error: libxml/xmlversion.h: No such file or directory");
    expect(xml?.run?.[0]).toContain("libxml2-dev");
    expect(best("install", "npm install", "Package cairo was not found in the pkg-config search path.")?.run?.[0]).toContain("libcairo2-dev");
    expect(best("install", "cargo build", "/usr/bin/ld: cannot find -lz: No such file or directory")?.run?.[0]).toContain("zlib1g-dev");
    for (const [header, pkg] of [
      ["openssl/ssl.h", "libssl-dev"],
      ["Python.h", "python3-dev"],
      ["jpeglib.h", "libjpeg-dev"],
      ["zlib.h", "zlib1g-dev"],
      ["sqlite3.h", "libsqlite3-dev"],
      ["bzlib.h", "libbz2-dev"],
      ["lzma.h", "liblzma-dev"],
      ["readline/readline.h", "libreadline-dev"],
      ["gmp.h", "libgmp-dev"],
      ["yaml.h", "libyaml-dev"],
      ["sasl/sasl.h", "libsasl2-dev"],
      ["ldap.h", "libldap2-dev"],
      ["krb5.h", "libkrb5-dev"],
      ["pcap.h", "libpcap-dev"],
      ["portaudio.h", "portaudio19-dev"],
      ["GL/gl.h", "libgl-dev"],
      ["X11/Xlib.h", "libx11-dev"],
      ["libpq-fe.h", "libpq-dev"],
      ["mysql.h", "default-libmysqlclient-dev"],
    ]) {
      expect(packageForHeader(header!)).toBe(pkg);
    }
  });

  it("fixes Postgres and MySQL driver builds", () => {
    const out = "Error: pg_config executable not found.\n\npg_config is required to build psycopg2 from source.";
    const matches = matchRepairs("install", "uv pip install -r requirements.txt", out, plan()).map((m) => m.rule.id);
    expect(matches).toEqual(expect.arrayContaining(["pg-config", "psycopg2-binary", "uv-to-pip"]));
    expect(rankRepairs(matchRepairs("install", "uv pip install -r requirements.txt", out, plan()))[0]?.rule.id).toBe("pg-config");
    expect(best("install", "pip install mysqlclient", "OSError: mysql_config not found")?.run?.[0]).toContain("default-libmysqlclient-dev");
  });

  it("installs missing Python modules under their PyPI names", () => {
    expect(best("launch", "python app.py", "Traceback (most recent call last):\n  File \"app.py\", line 1\nModuleNotFoundError: No module named 'cv2'")?.run).toEqual([
      "uv pip install opencv-python-headless || pip install opencv-python-headless",
    ]);
    expect(pypiFor("PIL")).toBe("Pillow");
    expect(pypiFor("yaml")).toBe("PyYAML");
    expect(pypiFor("sklearn.ensemble")).toBe("scikit-learn");
    expect(pypiFor("google.protobuf.message")).toBe("protobuf");
    expect(pypiFor("requests")).toBe("requests");
    expect(pypiFor("tkinter")).toBeNull();
    // The repo's own package goes on PYTHONPATH instead of being fetched.
    const local = best("launch", "python -m src.main", "ModuleNotFoundError: No module named 'app'", plan({ facts: { localModules: ["app"] } }));
    expect(local).toMatchObject({ env: { PYTHONPATH: "/workspace" } });
  });

  it("makes a venv with the Python a package requires", () => {
    const out = "ERROR: Package 'mytool' requires a different Python: 3.11.9 not in '>=3.12'";
    expect(best("install", "pip install -e .", out)).toMatchObject({ id: "python-version", run: ["uv venv --seed --python 3.12 /opt/venv --allow-existing"] });
    expect(pythonFor(">=3.8,<3.11")).toBe("3.10");
    expect(pythonFor(">=3.9")).toBeNull();
  });

  it("hoists packages a pnpm project imports without declaring them (Docusaurus 2's @mdx-js/react)", () => {
    const log = [
      "[SUCCESS] Docusaurus website is running at: http://localhost:3000/",
      "✔ Client: Compiled with some errors in 15.78s",
      "Module not found: Error: Can't resolve '@mdx-js/react' in '/workspace/apps/website/contents/algorithms'",
      "Module not found: Error: Can't resolve '@mdx-js/react' in '/workspace/apps/website/contents/_courses'",
      "Module not found: Error: Can't resolve './local-file' in '/workspace/apps/website/src'",
      "Module not found: Error: Can't resolve 'path' in '/workspace/apps/website/src'",
    ].join("\n");
    const m = best("launch", "pnpm run dev", log, plan({ facts: { pm: "pnpm" } }));
    expect(m).toMatchObject({ id: "pnpm-hoist-undeclared" });
    // Only the package, once: not a relative path or a Node built-in.
    expect(m!.run).toEqual([
      `[ -d "$(pnpm root -w 2>/dev/null || pnpm root)/.pnpm/node_modules"/@mdx-js/react ] && pnpm install --no-frozen-lockfile --config.confirm-modules-purge=false --public-hoist-pattern='@mdx-js/react'`,
    ]);
    expect(m!.note).toContain("`@mdx-js/react`");
    // Several at once, in one install.
    const two = best("launch", "pnpm dev", "Module not found: Can't resolve 'b-pkg'\nModule not found: Can't resolve '@a/pkg/sub'", plan({ facts: { pm: "pnpm" } }));
    expect(two!.run![0]).toContain("--public-hoist-pattern='@a/pkg' --public-hoist-pattern='b-pkg'");
    // npm and yarn hoist already: nothing to do there.
    expect(matchRepairs("launch", "npm run dev", log, plan({ facts: { pm: "npm" } })).some((x) => x.rule.id === "pnpm-hoist-undeclared")).toBe(false);
  });

  it("adds missing npm packages with the repo's package manager", () => {
    expect(best("launch", "node server.js", "Error: Cannot find module 'dotenv'\nRequire stack:\n- /workspace/server.js")?.run).toEqual(["npm install dotenv"]);
    const esm = best("launch", "pnpm run dev", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /workspace/server.js", plan({ facts: { pm: "pnpm" } }));
    // With pnpm, hoisting comes first (it runs only when another dependency already installed the package); adding is
    // next, at a workspace's root with -w when pnpm refuses it there.
    expect(esm).toMatchObject({ id: "pnpm-hoist-undeclared" });
    const all = matchRepairs("launch", "pnpm run dev", "Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'express' imported from /workspace/server.js", plan({ facts: { pm: "pnpm" } }));
    expect(all.find((m) => m.rule.id === "node-missing-module")?.fix.run).toEqual(["pnpm add express || pnpm add -w express"]);
    expect(npmPackageOf("@scope/pkg/sub")).toBe("@scope/pkg");
    expect(npmPackageOf("./local")).toBeNull();
    expect(npmPackageOf("node:fs")).toBeNull();
    expect(npmPackageOf("fs")).toBeNull();
  });

  it("generates the Prisma client and runs migrations when tables are missing", () => {
    expect(best("launch", "npm run dev", 'Error: @prisma/client did not initialize yet. Please run "prisma generate" and try to import it again.')?.run).toEqual(["npx prisma generate"]);
    expect(best("launch", "python manage.py runserver", "django.db.utils.OperationalError: no such table: auth_user")?.run).toEqual(["python manage.py migrate --noinput"]);
    expect(best("launch", "bin/rails server", "ActiveRecord::NoDatabaseError: We could not find your database: app_development")?.run).toEqual(["bin/rails db:prepare"]);
    const prisma = best("launch", "npm run dev", "Invalid `prisma.user.findMany()` invocation:\n\nThe table `public.User` does not exist in the current database.\n  code: 'P2021'");
    expect(prisma?.run?.[0]).toContain("prisma migrate deploy");
    // The repo's own migration command wins.
    expect(best("launch", "npm start", "code: 'P2021'", plan({ facts: { migrate: "npm run db:migrate" } }))?.run).toEqual(["npm run db:migrate"]);
  });

  it("sets placeholders for missing environment variables", () => {
    const key = best("launch", "python app.py", "Traceback (most recent call last):\n    os.environ['SECRET_KEY']\nKeyError: 'SECRET_KEY'");
    expect(key?.id).toBe("missing-env");
    expect(key?.env?.SECRET_KEY).toMatch(/^[0-9a-f]{64}$/);
    expect(best("launch", "npm run dev", "Error: Missing required environment variable DATABASE_URL")?.env).toEqual({ DATABASE_URL: "sqlite:///db.sqlite3" });
    expect(best("install", "npx prisma migrate deploy", "error: Environment variable not found: DATABASE_URL.")?.env).toHaveProperty("DATABASE_URL");
  });

  it("handles ports, watchers, missing scripts and host checks at launch", () => {
    expect(best("launch", "npm run dev", "Error: listen EADDRINUSE: address already in use :::3000")).toMatchObject({ id: "port-in-use", env: { PORT: "3001" }, port: 3001 });
    const flagged = best("launch", "uvicorn main:app --port 8000", "ERROR:    [Errno 98] error while attempting to bind on address ('0.0.0.0', 8000): address already in use", plan({ start: "uvicorn main:app --port 8000", port: 8000 }));
    expect(flagged?.retry).toBe("uvicorn main:app --port 8001");
    expect(best("launch", "npm run dev", "Error: ENOSPC: System limit for number of file watchers reached, watch '/workspace/src'")?.env).toMatchObject({ CHOKIDAR_USEPOLLING: "true", WATCHPACK_POLLING: "true" });
    expect(best("launch", "npm run dev", 'npm error Missing script: "dev"', plan({ facts: { scripts: ["build", "start"], pm: "npm" } }))?.retry).toBe("npm run start");
    expect(best("launch", "npm run dev", 'Blocked request. This host ("abc.preview.localhost") is not allowed.')?.env).toEqual({ __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: "abc.preview.localhost" });
    expect(best("launch", "npm start", "Error: error:0308010C:digital envelope routines::unsupported")?.env).toEqual({ NODE_OPTIONS: "--openssl-legacy-provider" });
    expect(best("launch", "npm run dev", "sh: 1: vite: not found")?.run).toEqual(["npm install --no-audit --no-fund"]);
  });

  it("pins Go and Ruby versions and installs missing gems and tools", () => {
    expect(best("install", "go mod download", "go: go.mod requires go >= 1.23 (running go 1.22.5; GOTOOLCHAIN=local)")?.run).toEqual(["mise use -g go@1.23"]);
    expect(best("install", "bundle install", "Your Ruby version is 3.3.0, but your Gemfile specified 3.2.2")?.run?.[0]).toBe("mise use -g ruby@3.2.2");
    expect(best("launch", "bin/rails server", "Could not find gem 'rails (~> 7.1)' in locally installed gems. (Bundler::GemNotFound)")?.run).toEqual(["bundle install"]);
    expect(best("install", "poetry install", "bash: poetry: command not found")?.run).toEqual(["pip install poetry"]);
    expect(best("install", "npm install", "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.")?.id).toBe("git-ssh-deps");
  });

  it("rewrites SSH dependencies on gitlab.com to HTTPS too", () => {
    const fix = best("install", "npm install", "ssh: connect to host gitlab.com port 22: Connection refused\nfatal: Could not read from remote repository.");
    expect(fix?.id).toBe("git-ssh-deps");
    expect(fix?.run).toEqual([
      'git config --global url."https://github.com/".insteadOf "git@github.com:"',
      'git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"',
      'git config --global url."https://gitlab.com/".insteadOf "git@gitlab.com:"',
      'git config --global --add url."https://gitlab.com/".insteadOf "ssh://git@gitlab.com/"',
    ]);
  });

  it("keeps the old fallbacks: uv to pip, npm ci to npm install, pnpm engine-strict off", () => {
    expect(best("install", "uv pip install -r requirements.txt", "error: Failed to build `legacy==0.1`")).toMatchObject({ id: "uv-to-pip", retry: "pip install -r requirements.txt" });
    expect(best("install", "npm ci", "npm ERR! The `npm ci` command can only install with an existing package-lock.json")).toMatchObject({ id: "npm-ci-lockfile", retry: "npm install" });
    const pnpm = matchRepairs("install", "pnpm install", "ERR_PNPM_UNSUPPORTED_ENGINE Unsupported engine for x@1.0.0", plan());
    expect(pnpm.find((m) => m.rule.id === "pnpm-engine-strict")?.fix.retry).toBe("pnpm install --config.engine-strict=false");
  });

  it("only applies a rule in its phase", () => {
    expect(matchRepairs("install", "npm install", "Error: listen EADDRINUSE: address already in use :::3000", plan())).toEqual([]);
    expect(matchRepairs("launch", "npm run dev", "npm error code ERESOLVE", plan())).toEqual([]);
  });

  it("ranks matching rules by what worked before", () => {
    const out = "Error: pg_config executable not found.\npsycopg2 build failed";
    const matches = matchRepairs("install", "uv pip install -r requirements.txt", out, plan());
    const learning = { stats: () => [{ key: "pg-config", successes: 0, failures: 12 }] };
    const ranked = rankRepairs(matches, learning).map((m) => m.rule.id);
    expect(ranked[0]).not.toBe("pg-config");
    expect(ranked).toContain("pg-config");
  });
});
