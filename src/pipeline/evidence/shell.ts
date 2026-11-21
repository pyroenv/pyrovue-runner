import path from "node:path/posix";

/**
 * Turning commands found in a repo (README blocks, Dockerfile RUN lines, devcontainer hooks, Makefile targets) into
 * commands that are sane to run in a box: drop what doesn't belong (clones, Docker, host package managers, piped
 * installers, remote access, editors, scaffolders, anything with a secret), strip what doesn't apply (sudo, prompts),
 * and classify the rest.
 */

export type CommandKind = "install" | "env" | "db" | "build" | "start" | "other";
export type Tool = "node" | "python" | "ruby" | "go";

export const MAX_COMMAND = 500;

export interface Sanitized {
  command?: string;
  /** Why it was dropped, when that's worth telling someone. Silent drops leave this empty. */
  skip?: string;
  cd?: string;
  env?: [string, string];
  version?: { tool: Tool; version: string };
  docker?: boolean;
}

export interface SanitizeOptions {
  /** Every file in the repo, to check `cd` targets and scripts. */
  files: Set<string>;
  /** The directory the command runs in, relative to the repo root. */
  dir?: string;
  /** Dockerfiles and deploy configs build for production; Pyrovue wants the dev dependencies too. */
  stripProductionFlags?: boolean;
}

const KNOWN = new Set(
  (
    "npm npx yarn pnpm pnpx bun bunx node deno python python3 py pip pip3 uv uvx poetry pipenv pdm hatch flask django-admin " +
    "uvicorn gunicorn hypercorn daphne waitress-serve streamlit gradio jupyter celery alembic make just task go cargo bundle " +
    "gem rails rake ruby rackup puma jekyll middleman php composer mix elixir java mvn gradle dotnet hugo mkdocs sphinx-build " +
    "zola cp mv export mkdir touch echo apt apt-get corepack nodemon ts-node tsx vite next nuxt nuxi ng vue-cli-service " +
    "react-scripts astro gatsby remix svelte-kit wrangler prisma sequelize knex typeorm drizzle-kit chmod ln tar unzip " +
    "air reflex mesop panel bokeh voila shiny dx trunk wasm-pack sbt lein clojure julia Rscript swift tox nox pytest " +
    "http-server serve live-server parcel webpack webpack-dev-server rollup esbuild turbo nx lerna concurrently foreman " +
    "overmind honcho sh bash"
  ).split(" "),
);

/** Splits a shell line on `&&`, `;` and a lone `&`, outside quotes and `$(…)`. */
export function splitChain(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quote: string | null = null;
  let depth = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += line[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      cur += c;
      continue;
    }
    if (c === "$" && line[i + 1] === "(") depth++;
    if (c === ")" && depth > 0) depth--;
    if (depth === 0) {
      if (c === "&" && line[i + 1] === "&") {
        out.push(cur);
        cur = "";
        i++;
        continue;
      }
      if (c === ";" || (c === "&" && line[i - 1] !== ">" && line[i + 1] !== ">" && line[i - 1] !== "&")) {
        out.push(cur);
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  out.push(cur);
  // A segment that is only a shell wrapper (bash -c "sudo chown node node_modules && npm install", as dev containers
  // write them) is its own chain: unwrapped, each step is read and sanitised like any other.
  return out
    .map((s) => s.trim())
    .filter(Boolean)
    .flatMap((s) => {
      const inner = shellWrapped(s);
      return inner === null ? [s] : splitChain(inner);
    });
}

/** The command inside `bash -c "…"` / `sh -c '…'` when that is the whole segment, or null. */
function shellWrapped(segment: string): string | null {
  const m = /^(?:\/(?:usr\/)?bin\/)?(?:ba|z|da)?sh\s+-[a-z]*c\s+(["'])([\s\S]*)\1$/.exec(segment);
  if (!m) return null;
  // Inside double quotes a backslash only escapes ", \, $ and the backtick.
  return m[1] === '"' ? m[2]!.replace(/\\(["\\$`])/g, (_all, ch: string) => ch) : m[2]!;
}

/** Splits on whitespace, honouring simple quotes (enough to read flags and arguments). */
export function words(s: string): string[] {
  const out: string[] = [];
  const re = /"((?:[^"\\]|\\.)*)"|'([^']*)'|(\S+)/g;
  for (const m of s.matchAll(re)) out.push(m[1] ?? m[2] ?? m[3]!);
  return out;
}

export function shq(s: string): string {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

/** The command word, after any `VAR=value` prefixes. */
export function headWord(cmd: string): string {
  const ws = words(cmd);
  const i = ws.findIndex((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w));
  return i === -1 ? "" : ws[i]!;
}

const SECRET_VALUE = [
  /\bsk-[A-Za-z0-9_-]{16,}/,
  /\bsk_(live|test)_[A-Za-z0-9]{10,}/,
  /\bgh[pousr]_[A-Za-z0-9]{20,}/,
  /\bgithub_pat_\w{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bxox[abprs]-[\w-]{10,}/,
  /-----BEGIN [A-Z ]*PRIVATE KEY/,
  /\bAIza[0-9A-Za-z_-]{30,}/,
  /\bglpat-[\w-]{20,}/,
  /\bhf_[A-Za-z0-9]{30,}/,
  /\bnpm_[A-Za-z0-9]{30,}/,
];

export const SECRET_NAME = /(api[_-]?key|secret|token|passw(or)?d|pwd|private[_-]?key|credential|auth[_-]?key|access[_-]?key)/i;

const PLACEHOLDER_VALUE = /^(<.*>|.*\.\.\.|.*(x{4,}|X{4,}).*|\{\{.*\}\}|\$\{?\w+\}?|your[-_ ].*|.*[-_]here|x{3,}|\*+|\.\.\.|changeme|change[-_]?me|todo|replace[-_ ]?me|placeholder|example|none|null|undefined|secret|mysecret|supersecret|super[-_]secret.*|test|dummy|fake|abc123|1234\d*|password)$/i;

/** True when a value is obviously a placeholder ("<your key>", "changeme", empty). */
export function isPlaceholder(value: string): boolean {
  const v = value.trim().replace(/^["']|["']$/g, "");
  return v === "" || PLACEHOLDER_VALUE.test(v);
}

/** Commands that carry a real-looking credential are never kept or logged. */
export function looksSecret(cmd: string): boolean {
  if (SECRET_VALUE.some((re) => re.test(cmd))) return true;
  // A name starts only where a run of word characters and hyphens starts (`\b` would try every position in it,
  // which is quadratic), and holds at least one word character.
  for (const m of cmd.matchAll(/(?<![\w-])(-*\w[\w-]*)\s*[=:]\s*["']?([^\s"']{12,})/g)) {
    if (SECRET_NAME.test(m[1]!) && !isPlaceholder(m[2]!) && !/^\$/.test(m[2]!)) return true;
  }
  return false;
}

/** A command as it may be shown in logs and to the agent: credentials masked, length capped. */
export function redact(cmd: string, max = 200): string {
  let out = cmd.trim();
  for (const re of SECRET_VALUE) out = out.replace(new RegExp(re.source, "g"), "***");
  out = out.replace(/(?<![\w-])(-*\w[\w-]*)(\s*[=:]\s*["']?)([^\s"']{8,})/g, (whole, name: string, sep: string, value: string) =>
    SECRET_NAME.test(name) && !isPlaceholder(value) && !value.startsWith("$") ? `${name}${sep}***` : whole,
  );
  return out.length > max ? `${out.slice(0, max - 1)}…` : out;
}

const TEMPLATE = /<[^<>\s]+>|\{\{[^}]+\}\}|\byour[-_](?!own\b)|\bYOUR_|\[(options?|args?|flags?|command|file|path|name|port)\]|\s\.\.\.(\s|$)|\bpath\/to\b|\bxxxx/i;

function dirExists(files: Set<string>, dir: string): boolean {
  if (dir === ".") return true;
  const prefix = `${dir}/`;
  for (const f of files) if (f.startsWith(prefix)) return true;
  return false;
}

/** Where `cd target` from `dir` lands, or null when it leaves the repo or points nowhere we know. */
export function resolveCd(files: Set<string>, dir: string, target: string): string | null {
  const t = target.replace(/^["']|["']$/g, "");
  if (/^[~$]/.test(t) || t === "-") return null;
  const next = path.normalize(path.join(dir, t.replace(/^\/workspace\/?/, "")));
  if (next.startsWith("..")) return null;
  const norm = next === "" ? "." : next.replace(/\/$/, "");
  return dirExists(files, norm) ? norm : null;
}

function productionFlags(cmd: string): string {
  return cmd
    .replace(/^NODE_ENV=production\s+/, "")
    .replace(/\s--(production|prod)(=true)?\b/g, "")
    .replace(/\s--only[= ]prod(uction)?\b/g, "")
    .replace(/\s--omit[= ]dev\b/g, "")
    .replace(/\s--no-dev\b/g, "")
    .replace(/\s--without[= ](['"]?)(dev(elopment)?|test)([ :,](dev(elopment)?|test))*\1/g, "")
    .replace(/\s--only[= ]main\b/g, "")
    .replace(/\s--deployment\b/g, "")
    .replace(/\s--frozen\b(?!-)/g, "");
}

const APK_TO_APT: Record<string, string | null> = {
  "build-base": "build-essential",
  gcc: "build-essential",
  "g++": "build-essential",
  make: "build-essential",
  "musl-dev": null,
  "linux-headers": null,
  "postgresql-dev": "libpq-dev",
  "postgresql-client": "postgresql-client",
  "libpq-dev": "libpq-dev",
  "python3-dev": "python3-dev",
  "libffi-dev": "libffi-dev",
  "openssl-dev": "libssl-dev",
  "jpeg-dev": "libjpeg-dev",
  "libjpeg-turbo-dev": "libjpeg-dev",
  "zlib-dev": "zlib1g-dev",
  "libpng-dev": "libpng-dev",
  "mariadb-dev": "default-libmysqlclient-dev",
  "mariadb-connector-c-dev": "default-libmysqlclient-dev",
  "cairo-dev": "libcairo2-dev",
  "pango-dev": "libpango1.0-dev",
  "libxml2-dev": "libxml2-dev",
  "libxslt-dev": "libxslt1-dev",
  "vips-dev": "libvips-dev",
  "freetype-dev": "libfreetype-dev",
  "sqlite-dev": "libsqlite3-dev",
  "yaml-dev": "libyaml-dev",
  "gmp-dev": "libgmp-dev",
  ffmpeg: "ffmpeg",
  imagemagick: "imagemagick",
  graphviz: "graphviz",
  poppler: "poppler-utils",
  "poppler-utils": "poppler-utils",
  "tesseract-ocr": "tesseract-ocr",
  chromium: "chromium",
};

const PRESENT = new Set(["git", "curl", "wget", "bash", "ca-certificates", "tzdata", "nodejs", "npm", "python3", "py3-pip", "openssl", "tini", "dumb-init", "su-exec", "shadow", "coreutils"]);

function aptInstall(packages: string[]): string | null {
  const pkgs = [...new Set(packages.filter((p) => /^[a-z0-9][a-z0-9.+:-]*$/.test(p) && !PRESENT.has(p)))];
  return pkgs.length ? `apt-get update -qq && apt-get install -y --no-install-recommends ${pkgs.join(" ")}` : null;
}

/**
 * Cleans one command (one segment of a chain). Returns what to run, what it changes (cd / env / runtime
 * version), or nothing when it should be dropped.
 */
export function sanitizeCommand(segment: string, opts: SanitizeOptions): Sanitized {
  let s = segment.trim().replace(/\s&$/, "").trim();
  if (!s || s.startsWith("#") || s.startsWith("//")) return {};
  if (/^sudo\s+-u\b/.test(s)) return { skip: "runs as another user" };
  s = s.replace(/^sudo\s+(-[EHS]\s+)*/, "");
  if (s.length > MAX_COMMAND) return { skip: "too long to trust" };
  if (looksSecret(s)) return { skip: "contains a credential" };
  if (/[A-Za-z]:\\|\.exe\b|\.bat\b|\.cmd\b|\.ps1\b|^set\s+\w+=|^\$env:|^setx\b|^\.\\/i.test(s)) return {};
  if (opts.stripProductionFlags) s = productionFlags(s);

  // Plain variable assignments become env, unless they carry something secret or computed.
  const assign = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=("[^"]*"|'[^']*'|[^\s"'`$]*)$/.exec(s);
  if (assign) {
    const value = assign[2]!.replace(/^["']|["']$/g, "");
    if (SECRET_NAME.test(assign[1]!) || isPlaceholder(value)) return {};
    return { env: [assign[1]!, value] };
  }
  if (/^export\s/.test(s)) return {};

  const cd = /^(?:cd|pushd)\s+(\S+)$/.exec(s);
  if (cd) {
    const target = resolveCd(opts.files, opts.dir ?? ".", cd[1]!);
    return target === null ? {} : { cd: target };
  }
  if (/^(cd|popd)$/.test(s)) return { cd: "." };

  // Runtime version managers: keep the version, drop the command.
  let m: RegExpExecArray | null;
  if ((m = /^(?:nvm|fnm)\s+(?:install|use)\s+v?(\d+(?:\.\d+)*)/.exec(s))) return { version: { tool: "node", version: m[1]! } };
  if ((m = /^volta\s+(?:install|pin)\s+node@(\d[\w.]*)/.exec(s))) return { version: { tool: "node", version: m[1]! } };
  if ((m = /^pyenv\s+(?:install|local|global|shell)\s+(?:-\S+\s+)*(\d+\.\d+(?:\.\d+)?)/.exec(s))) return { version: { tool: "python", version: m[1]! } };
  if ((m = /^(?:rbenv|rvm)\s+(?:install|local|global|use)\s+(?:ruby-)?(\d+\.\d+(?:\.\d+)?)/.exec(s))) return { version: { tool: "ruby", version: m[1]! } };
  if ((m = /^(?:mise|asdf)\s+(?:use|install|local|global)\s+(?:-g\s+)?(node(?:js)?|python|ruby|go(?:lang)?)[@ ](\d[\w.]*)/.exec(s))) {
    const tool = m[1]!.startsWith("node") ? "node" : m[1]!.startsWith("go") ? "go" : (m[1] as Tool);
    return { version: { tool, version: m[2]! } };
  }
  if (/^(nvm|fnm|volta|pyenv|rbenv|rvm|asdf|mise|n|sdk)\b/.test(s)) return {};

  // The box already has an active virtualenv and one shell per command.
  if (
    /^(python3?|py)(\s+-\d(\.\d+)?)?\s+-m\s+venv\b|^virtualenv\b|^(source|\.)\s+\S*activate\b|\\Scripts\\activate|^deactivate$|^(conda|mamba|micromamba)\b|^(poetry|pipenv)\s+shell\b/.test(s)
  ) {
    return {};
  }
  if (/^(python3?\s+-m\s+)?pip3?\s+install\s+(-U\s+|--upgrade\s+)*(pip|setuptools|wheel|virtualenv)(\s+(pip|setuptools|wheel))*\s*$/.test(s)) return {};

  if (/^git\s+(clone|pull|fetch|checkout|switch|remote|push|commit|init|config|add|lfs\s+install)\b|^gh\s+repo\s+clone\b/.test(s)) return {};
  if (/^(docker|docker-compose|podman|podman-compose|nerdctl|kubectl|helm|minikube|kind|k3d|tilt|skaffold|vagrant|lando|ddev)\b|^(\.\/vendor\/bin\/)?sail\b/.test(s)) {
    return { skip: "uses Docker", docker: true };
  }
  if (/^(brew|choco|winget|scoop|port|pacman|yay|dnf|yum|zypper|snap|flatpak|nix(-env|-shell)?|emerge|pkg)\b/.test(s)) {
    return { skip: "uses a host package manager" };
  }
  if (/^apk\s+(add|update)\b/.test(s)) {
    const pkgs = words(s)
      .slice(2)
      .filter((w) => !w.startsWith("-"))
      .map((p) => p.replace(/[=~<>].*$/, ""));
    const apt = aptInstall(pkgs.map((p) => APK_TO_APT[p] ?? null).filter((p): p is string => p !== null));
    return apt ? { command: apt } : {};
  }
  if (
    /\b(curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^|]*\|\s*(sudo\s+)?(-?\w+=\S+\s+)*((ba|z|da|k)?sh|python3?|perl|ruby|node|iex)\b/.test(s) ||
    /\b(ba|z)?sh\s+(-c\s+)?["']?\$\(\s*(curl|wget)/.test(s) ||
    /\b(ba|z)?sh\s+<\(\s*(curl|wget)/.test(s)
  ) {
    return { skip: "pipes a download into a shell" };
  }
  if (/^(ssh|scp|sftp|rsync|telnet|ftp|mosh)\b/.test(s)) return { skip: "connects to another machine" };
  if (/^(open|xdg-open|start|explorer|code|subl|idea|vim?|nano|emacs|notepad|less|more|man|cat|tail|head|ls|pwd|which|whoami|clear)\b/.test(s)) return {};
  if (
    /^(heroku|vercel|netlify|fly|flyctl|gcloud|gsutil|aws|az|firebase|railway|render|doctl|terraform|pulumi|serverless|sls|cdk|amplify|eb|now|surge|ngrok|cloudflared|supabase|stripe)\b|^wrangler\s+(deploy|publish|login|secret)\b/.test(s)
  ) {
    return { skip: "needs a cloud account" };
  }
  if (/^(npm|yarn|pnpm|bun)\s+(login|logout|publish|adduser|version|link|unlink|audit|outdated|whoami)\b/.test(s)) return {};
  if (/^(rm|rmdir|del|mkfs|dd|shutdown|reboot|halt|poweroff|kill|killall|pkill|chown|chgrp|format|diskutil|useradd|adduser|groupadd|addgroup|usermod|passwd|su)\b|:\(\)\s*\{|^chmod\s+-R\b/.test(s)) {
    return { skip: "destructive or system-level" };
  }
  if (
    /^(npx|pnpx|bunx|pnpm\s+dlx|yarn\s+dlx)\s+(--yes\s+|-y\s+)?(create-|degit\b|giget\b|@[\w-]+\/create)|^(npm|yarn|pnpm|bun)\s+(init|create)\b|^(django-admin|rails)\s+(startproject|startapp|new)\b|^cargo\s+(new|init)\b|^composer\s+create-project\b|^(poetry|uv)\s+(new|init)\b/.test(s)
  ) {
    return { skip: "scaffolds a new project" };
  }
  if (
    /\bmanage\.py\s+(createsuperuser|shell|dbshell|shell_plus)\b|^(bin\/)?rails\s+(c|console|dbconsole)\b|^(python3?|node|irb|psql|mysql|mongo|mongosh|redis-cli|sqlite3|iex|bash|sh|zsh|bun|deno)\s*$/.test(s)
  ) {
    return {};
  }
  if (/^(psql|mysql|mongo|mongosh|redis-cli|createdb|dropdb|createuser|pg_ctl|pg_ctlcluster|initdb|mysqld|mongod|redis-server|memcached|elasticsearch|rabbitmq-server|rabbitmqctl)\b/.test(s)) {
    return { skip: "manages a database server (Pyrovue starts services itself)" };
  }
  if (/^(systemctl|service|launchctl|sc)\b/.test(s)) return { skip: "manages system services" };
  if (/^apt(-get)?\s+(update|upgrade|dist-upgrade|full-upgrade|autoremove|clean|purge|remove)\b/.test(s)) return {};
  if (/^(apt|apt-get|aptitude)\s+install\b/.test(s)) {
    const apt = aptInstall(
      words(s)
        .slice(2)
        .filter((w) => !w.startsWith("-"))
        .map((p) => p.replace(/=.*$/, "")),
    );
    return apt ? { command: apt } : {};
  }
  if (TEMPLATE.test(s)) return { skip: "is a template with placeholders" };

  s = s.replace(/\b(pip3?\s+install\b.*?)\s--user\b/, "$1").replace(/\s--break-system-packages\b/, "");

  const head = headWord(s);
  // A directory listing in a code block ("scripts/   build helpers") isn't a command.
  if (!head || head.endsWith("/") || /^[\w./-]+\s{2,}\S/.test(s)) return {};
  const pathLike = /^(\.\/|bin\/|script\/|scripts\/)|\.(sh|py)$/.test(head);
  if (pathLike) {
    const rel = path.normalize(path.join(opts.dir ?? ".", head.replace(/^\.\//, "")));
    if (!opts.files.has(rel) && !/^\/workspace\//.test(head)) {
      if (/^(\.\/|bin\/|script\/|scripts\/)/.test(head)) return { skip: "points at a script that isn't in the repo" };
      // A bare `install.sh` that isn't there is usually prose (a layout block's description), not an instruction.
      return {};
    }
  } else if (!KNOWN.has(head) && !/^(\.\/)?(gradlew|mvnw)$/.test(head)) {
    return {};
  }
  return { command: s };
}

const DB =
  /\bmanage\.py\s+(migrate|makemigrations|loaddata|collectstatic|createcachetable)\b|\bflask\s+(db\s+upgrade|init-db|init_db|seed)\b|\balembic\s+upgrade\b|\b(rails|rake)\s+db:|\bprisma\s+(migrate|db\s+(push|seed)|generate)\b|\b(npm|yarn|pnpm|bun)\s+(run\s+)?(db|migrate|migration|migrations|prisma|seed)([:\w-]*)\b|\bartisan\s+(migrate|key:generate|db:seed|storage:link)\b|\b(knex|sequelize(-cli)?|typeorm)\b.*\bmigrat|\bdrizzle-kit\s+(push|migrate|generate)\b|\binit[-_]?db\b|\bmix\s+ecto\.(setup|migrate|create)\b/i;
const BUILD =
  /^(npm|yarn|pnpm|bun)\s+(run\s+)?build([:\w-]*)\b|^cargo\s+build\b|^go\s+(build|generate)\b|^make(\s+(build|all|compile))?\s*$|^(npx\s+)?tsc\b|^(mvnw?|\.\/mvnw)\s+(package|install|compile)\b|^(\.\/)?gradlew?\s+(build|assemble)\b|^dotnet\s+build\b|^hugo(\s+--\S+)*\s*$|^mkdocs\s+build\b|^(bundle\s+exec\s+)?jekyll\s+build\b|^(npx\s+)?(vite|webpack|rollup|esbuild|parcel)\s+build\b|^(npm|yarn|pnpm)\s+(run\s+)?(compile|prepare|bundle)\b|^python3?\s+setup\.py\s+(build|develop)\b|^(just|task)\s+build\b/;
const START =
  /\b(npm|pnpm|bun)\s+(run\s+)?(dev|start|serve|develop|preview|start:dev|dev:\w+|server)\b|\bnpm\s+start\b|\byarn\s+(run\s+)?(dev|start|serve|develop|preview|start:dev|server)\b|manage\.py\s+runserver\b|\bflask\s+(--app\s+\S+\s+)?run\b|\b(uvicorn|gunicorn|hypercorn|daphne|waitress-serve)\b|\bstreamlit\s+run\b|\bgradio\s+\S+|\b(bin\/)?rails\s+(s|server)\b|^bin\/dev\b|\brackup\b|\bpuma\b|\bjekyll\s+serve\b|\bmiddleman(\s+server)?\s*$|\bartisan\s+serve\b|\bphp\s+-S\b|\bgo\s+run\b|^air\b|\bcargo\s+(run|watch)\b|\bdeno\s+(task\s+(dev|start|serve)|run)\b|^(make|just|task)\s+(dev|run|start|serve|server|develop|watch|up|run-dev|start-dev|local)\s*$|\bhugo\s+serve(r)?\b|\bmkdocs\s+serve\b|\bzola\s+serve\b|\b(npx|bunx|pnpx)\s+(--yes\s+)?(vite|serve|http-server|next|nuxt|nuxi|astro|live-server|parcel|webpack(-dev-server)?\s+serve|docusaurus)\b|^(vite|next\s+dev|nuxt\s+dev|nuxi\s+dev|astro\s+dev|ng\s+serve|parcel|webpack\s+serve|webpack-dev-server|http-server|live-server|serve)\b|\bnodemon\b|^(ts-node|tsx)\s+\S+|^node\s+\S+\.(m?js|cjs)\b|\bmix\s+phx\.server\b|\bgradlew?\s+bootRun\b|\bmvnw?\s+spring-boot:run\b|\bdotnet\s+(run|watch)\b|^java\s+-jar\b|\bjupyter\s+(lab|notebook)\b|\bwrangler\s+dev\b|\bbundle\s+exec\s+(rails\s+s|rails\s+server|jekyll\s+serve|puma|rackup|middleman)\b|^(reflex\s+run|mesop\s+\S+|panel\s+serve|bokeh\s+serve|voila\b|shiny\s+run|chainlit\s+run|solara\s+run)|^(foreman|overmind|honcho)\s+start\b|^concurrently\b|^trunk\s+serve\b|^dx\s+serve\b/;
const INSTALL =
  /^(npm\s+(i|install|ci)\b|yarn(\s+install\b|\s*$|\s+--\S+)|pnpm\s+(i|install)\b|bun\s+(i|install)\b|pip3?\s+install\b|python3?\s+-m\s+pip\s+install\b|uv\s+(sync|pip\s+install|venv|tool\s+install)\b|poetry\s+install\b|pipenv\s+(install|sync)\b|pdm\s+(install|sync)\b|hatch\s+env\b|bundle(\s+install)?\s*$|bundle\s+(install|config)\b|composer\s+install\b|go\s+(mod\s+(download|tidy)|get|install)\b|mix\s+deps\.get\b|apt-get\s+update\b|corepack\s+(enable|prepare|install)\b|gem\s+install\b|deno\s+(cache|install)\b|cargo\s+(fetch|install)\b|dotnet\s+restore\b|(make|just|task)\s+(install|deps|setup|bootstrap|init|dependencies|requirements)\s*$|(\.\/)?(scripts?\/)?(setup|install|bootstrap)(\.sh)?\b|(bin|script)\/(setup|bootstrap)\b|playwright\s+install\b|npx\s+playwright\s+install\b|rustup\b|(npm|yarn|pnpm|bun)\s+(add|global\s+add)\b|python3?\s+setup\.py\s+install\b)/;
const ENV_STEP = /^(cp|mv)\s+(-n\s+|-i\s+)?\S*\.env\S*\s+\S*\.env\S*$|^touch\s+\S*\.env\S*$|^echo\s+.*>>?\s*\S*\.env\S*$|^(cp|mv)\s+\S*(config|settings)\S*\.(example|sample|dist|template)\S*\s+\S+$/;

/** What a command does, by its shape: installs dependencies, prepares env or a database, builds, or starts. */
export function classifyCommand(cmd: string): CommandKind {
  const c = cmd.replace(/^cd\s+\S+\s*&&\s*/, "").replace(/^([A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
  if (ENV_STEP.test(c)) return "env";
  if (DB.test(c)) return "db";
  if (BUILD.test(c)) return "build";
  // `python something.py` (directly or through uv/poetry/pipenv) is as likely a one-off script as a server, and so
  // is `node`/`bun` on a file: only entry-point names or an explicit port count as a start.
  const script = /^(?:(?:uv|poetry|pipenv|pdm|hatch)\s+run\s+)?python3?\s+(?:-[A-Za-z]+\s+)*([\w/.-]+\.py)\b(.*)$/.exec(c);
  if (script) {
    if (/(^|\/)manage\.py$/.test(script[1]!)) return /^\s+runserver\b/.test(script[2]!) ? "start" : "other";
    return /(^|\/)(app|server|main|run|web|api|wsgi|asgi|serve|dashboard|webui|ui|demo|gui|bot|start|index)\.py$/.test(script[1]!) || /--(port|host)\b/.test(script[2]!) ? "start" : "other";
  }
  const file = /^(?:node|bun(?:\s+run)?)\s+(?:--?[\w-]+(?:=\S+)?\s+)*([\w/.-]+\.(?:m?js|cjs|ts|tsx))\b(.*)$/.exec(c);
  if (file) return /(^|\/)(server|index|app|main|start|serve|www)\.(m?js|cjs|ts|tsx)$/.test(file[1]!) || /--port\b/.test(file[2]!) ? "start" : "other";
  if (/^(?:(?:uv|poetry|pipenv|pdm)\s+run\s+)?python3?\s+-m\s+(flask\s+run|uvicorn|gunicorn|streamlit\s+run|http\.server|django\s+runserver|gradio|panel\s+serve|jupyter|hypercorn|daphne|chainlit|reflex)\b/.test(c)) return "start";
  // Monorepo forms: `pnpm --filter web dev`, `yarn workspace web dev`, `npm -w web run dev`, `turbo dev`, `nx serve web`.
  const ws = /^(?:pnpm\s+(?:--filter[= ]|-F\s*)\S+|yarn\s+workspace\s+\S+|npm\s+(?:--workspace[= ]|-w\s+)\S+|turbo|nx)\s+(?:run\s+)?([\w:.-]+)/.exec(c);
  if (ws) {
    if (/^(build|compile|bundle)\b/.test(ws[1]!)) return "build";
    if (/^(dev|start|serve|develop|preview)\b/.test(ws[1]!)) return "start";
  }
  if (START.test(c)) return "start";
  if (INSTALL.test(c)) return "install";
  return "other";
}

/** The JavaScript package manager a command uses, if any. */
export function jsTool(cmd: string): "npm" | "yarn" | "pnpm" | "bun" | null {
  const h = headWord(cmd.replace(/^cd\s+\S+\s*&&\s*/, ""));
  if (h === "npm" || h === "npx") return "npm";
  if (h === "yarn") return "yarn";
  if (h === "pnpm" || h === "pnpx") return "pnpm";
  if (h === "bun" || h === "bunx") return "bun";
  return null;
}

/** Dev servers reload and serve unbuilt sources; production servers usually need a build first. */
export function isDevStart(cmd: string): boolean {
  return /\b(dev|develop|serve|server|runserver|--reload|watch|preview|start:dev|streamlit|flask\s+(--app\s+\S+\s+)?run|bootRun|phx\.server|jupyter|gradio|nodemon|tsx|ts-node|go\s+run|cargo\s+run|rails\s+s)\b/.test(cmd);
}

/** The npm-style script a command runs (`npm run dev`, `yarn dev`, `pnpm start`), if any. */
export function scriptOf(cmd: string): string | null {
  const c = cmd.replace(/^cd\s+\S+\s*&&\s*/, "");
  const m = /^(?:npm|pnpm|bun)\s+(?:run\s+)?([\w:.-]+)/.exec(c) ?? /^yarn\s+(?:run\s+)?([\w:.-]+)/.exec(c);
  if (!m) return null;
  const s = m[1]!;
  if (/^(install|i|ci|add|remove|exec|dlx|x|create|init|test|t|why|ls|list|link|update|upgrade|publish|config|set|cache)$/.test(s)) return s === "test" || s === "t" ? "test" : null;
  return s;
}
