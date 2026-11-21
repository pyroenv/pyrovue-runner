import { randomBytes } from "node:crypto";
import { installCommand, type Plan } from "./plan";
import { START_SCRIPTS, TAURI_RUNS_NOTE } from "./stacks/desktop";

/**
 * What Pyrovue knows about fixing a failed setup without a model: an ordered list of rules, each recognising one
 * kind of failure from the command and its output, and proposing a fix (install something first, retry a different
 * command, set env). The runner tries matching rules best-first, bounded, and learns which ones work.
 */

export type RepairPhase = "install" | "launch";
export type Captures = Record<string, string>;

export interface RepairFix {
  /** Commands to run before retrying (install a header, pin a runtime). They become part of the recorded setup. */
  run?: string[];
  /** The command to retry instead of the one that failed. */
  retry?: string;
  env?: Record<string, string>;
  /** A different port to expect after relaunching. */
  port?: number;
  /** What Pyrovue says it's doing, in the product's voice. */
  note: string;
  /** A caveat that stays with the plan's notes, for what the fix leaves not working. */
  planNote?: string;
}

export interface RepairRule {
  id: string;
  /** Where the rule applies; "any" covers errors that show up both in setup (migrations) and at launch. */
  phase: RepairPhase | "any";
  /** One line for people: what failure it recognises and what it does. */
  description: string;
  /** Prior probability that the fix works, before any learning. */
  prior?: number;
  match(command: string, output: string): Captures | null;
  fix(captures: Captures, plan: Plan): RepairFix | null;
}

const apt = (...pkgs: string[]) => `apt-get update -qq && apt-get install -y --no-install-recommends ${[...new Set(pkgs)].join(" ")}`;
const pmOf = (plan: Plan, command = "") =>
  (plan.facts?.pm ?? (/\bpnpm\b/.test(command) ? "pnpm" : /\byarn\b/.test(command) ? "yarn" : /\bbun\b/.test(command) ? "bun" : "npm")) as "npm" | "pnpm" | "yarn" | "bun";
const addCommand = (pm: string, pkg: string) => (pm === "npm" ? `npm install ${pkg}` : `${pm} add ${pkg}`);
const runScript = (pm: string, script: string) => `${pm} run ${script}`;

/** How a missing JavaScript package shows up: Node, webpack (Next, Docusaurus, CRA) and Vite. */
const UNRESOLVED = [
  /Cannot find package '([^']+)' imported from/g,
  /Error: Cannot find module '([^']+)'/g,
  /Module not found: (?:Error: )?Can't resolve '([^']+)'/g,
  /Failed to resolve import "([^"]+)"/g,
];

function first(output: string, patterns: RegExp[]): RegExpExecArray | null {
  for (const re of patterns) {
    const m = re.exec(output);
    if (m) return m;
  }
  return null;
}

// ---------------------------------------------------------------- version ranges

/** The newest Node major a range allows when it doesn't allow the box's Node 22; null when 22 is fine. */
export function nodeMajorFor(range: string, current = 22): number | null {
  const alts = range.split("||").map((s) => s.trim()).filter(Boolean);
  if (!alts.length) return null;
  let best: number | null = null;
  for (const alt of alts) {
    const allowed = allowedMajors(alt);
    if (allowed.includes(current)) return null;
    const top = allowed.filter((m) => m <= 24).at(-1);
    if (top !== undefined && (best === null || top > best)) best = top;
  }
  return best;
}

/** An operator and the version it applies to, split by spaces (`>= 18`). */
const OPERATOR_GAP = /(>=|<=|~=|!=|[<>=~^])\s+/g;
const withoutPrerelease = (part: string) => part.replace(/-[A-Za-z][\w.-]*$/, "");

/** The first `-` with one space each side (`18-20` is `18 - 20`). Written without a whitespace regex, which is quadratic on a long run of spaces. */
function spaceFirstHyphen(s: string): string {
  const i = s.indexOf("-");
  return i < 0 ? s : `${s.slice(0, i).trimEnd()} - ${s.slice(i + 1).trimStart()}`;
}

/** `18 or higher` is `18`; the suffix needs a space before it, and no regex scans for whitespace here. */
function withoutOrHigher(s: string): string {
  const m = / or (?:higher|newer|later)$/.exec(s);
  return m ? s.slice(0, m.index).trimEnd() : s;
}

function allowedMajors(alt: string): number[] {
  let lo = 0;
  let hi = 99;
  const range = spaceFirstHyphen(alt).trim();
  const hyphen = /^v?(\d+)(?:\.[\dx*]+)*\s+-\s+v?(\d+)/.exec(range);
  if (hyphen) return span(Number(hyphen[1]), Number(hyphen[2]));
  // `>= 18` is `>=18`; a pre-release tag (18.0.0-rc.1) is its release.
  for (const part of range.replace(OPERATOR_GAP, "$1").split(/\s+/).map(withoutPrerelease)) {
    const m = /^(\^|~|>=|<=|>|<|=)?v?(\d+)(?:\.(\d+|x|\*))?(?:\.(\d+|x|\*))?$/.exec(part);
    if (!m) continue;
    const major = Number(m[2]);
    const minorZero = !m[3] || m[3] === "0" || m[3] === "x" || m[3] === "*";
    switch (m[1]) {
      case ">=":
        lo = Math.max(lo, major);
        break;
      case ">":
        lo = Math.max(lo, minorZero && !m[3] ? major + 1 : major);
        break;
      case "<":
        hi = Math.min(hi, minorZero && (m[4] === undefined || m[4] === "0") ? major - 1 : major);
        break;
      case "<=":
        hi = Math.min(hi, major);
        break;
      default:
        // ^18, ~18.2, 18, 18.x, =18
        lo = Math.max(lo, major);
        hi = Math.min(hi, major);
    }
  }
  return span(lo, hi);
}

function span(lo: number, hi: number): number[] {
  const out: number[] = [];
  for (let m = Math.max(lo, 0); m <= Math.min(hi, 30); m++) out.push(m);
  return out;
}

/** A Python minor version a requirement allows when it doesn't allow the box's 3.11; null when 3.11 is fine. */
export function pythonFor(range: string, current = 11): string | null {
  let lo = 0;
  let hi = 99;
  for (const part of range.replace(OPERATOR_GAP, "$1").split(/[,\s]+/).filter(Boolean).map(withoutPrerelease)) {
    const m = /^(>=|<=|>|<|==|~=|\^|!=)?\s*3\.(\d+)(?:\.(\d+|\*))?$/.exec(part);
    if (!m) continue;
    const minor = Number(m[2]);
    const patch = m[3];
    switch (m[1]) {
      case ">=":
      case "~=":
      case "^":
        lo = Math.max(lo, minor);
        break;
      case ">":
        lo = Math.max(lo, patch ? minor : minor + 1);
        break;
      case "<":
        hi = Math.min(hi, patch && patch !== "0" ? minor : minor - 1);
        break;
      case "<=":
        hi = Math.min(hi, minor);
        break;
      case "!=":
        break;
      default:
        lo = Math.max(lo, minor);
        hi = Math.min(hi, minor);
    }
  }
  if (current >= lo && current <= hi) return null;
  if (lo > hi) return null;
  // The oldest allowed when the box is too old, the newest allowed when it's too new.
  const minor = current < lo ? lo : Math.min(hi, 13);
  return minor >= 8 ? `3.${minor}` : null;
}

export const pythonVenv = (version: string) => `uv venv --seed --python ${version} /opt/venv --allow-existing`;

// ---------------------------------------------------------------- knowledge tables

/** C headers (and pkg-config names, and `-l` libraries) → the Debian package that provides them. */
export const HEADER_PACKAGES: [RegExp, string][] = [
  [/^ffi\.h$|^libffi$|^ffi$/, "libffi-dev"],
  [/^openssl\/|^openssl$|^libssl$|^ssl$|^crypto$|^libcrypto$/, "libssl-dev"],
  [/^libxml\/|^libxml-2\.0$|^xml2$/, "libxml2-dev"],
  [/^libxslt\/|^libexslt\/|^libxslt$|^xslt$/, "libxslt1-dev"],
  [/^Python\.h$|^python3(\.\d+)?$/, "python3-dev"],
  [/^jpeglib\.h$|^libjpeg$|^jpeg$|^turbojpeg\.h$/, "libjpeg-dev"],
  [/^png\.h$|^libpng\d*$|^png$/, "libpng-dev"],
  [/^zlib\.h$|^zlib$|^z$/, "zlib1g-dev"],
  [/^cairo\.h$|^cairo\/|^cairo(-\w+)?$/, "libcairo2-dev"],
  [/^pango\/|^pango(cairo)?(-1\.0)?$/, "libpango1.0-dev"],
  [/^pixman\.h$|^pixman-1$/, "libpixman-1-dev"],
  [/^gif_lib\.h$|^gif$/, "libgif-dev"],
  [/^librsvg\/|^librsvg-2\.0$/, "librsvg2-dev"],
  [/^sqlite3\.h$|^sqlite3$/, "libsqlite3-dev"],
  [/^bzlib\.h$|^bz2$/, "libbz2-dev"],
  [/^lzma\.h$|^liblzma$|^lzma$/, "liblzma-dev"],
  [/^readline\/|^readline$/, "libreadline-dev"],
  [/^gmp\.h$|^gmp$/, "libgmp-dev"],
  [/^mpfr\.h$|^mpfr$/, "libmpfr-dev"],
  [/^yaml\.h$|^yaml-0\.1$|^yaml$/, "libyaml-dev"],
  [/^sasl\/|^libsasl2$|^sasl2$/, "libsasl2-dev"],
  [/^ldap\.h$|^lber\.h$|^ldap$|^lber$/, "libldap2-dev"],
  [/^krb5\.h$|^krb5\/|^gssapi\/|^gssapi\.h$|^krb5(-gssapi)?$/, "libkrb5-dev"],
  [/^pcap\.h$|^pcap\/|^pcap$/, "libpcap-dev"],
  [/^portaudio\.h$|^portaudio(-2\.0)?$/, "portaudio19-dev"],
  [/^GL\/glu\.h$|^glu$|^GLU$/, "libglu1-mesa-dev"],
  [/^GL\/|^gl$|^GL$|^EGL\/|^egl$/, "libgl-dev"],
  [/^X11\/extensions\/Xrandr\.h$|^xrandr$/, "libxrandr-dev"],
  [/^X11\/extensions\/Xinerama\.h$|^xinerama$/, "libxinerama-dev"],
  [/^X11\/extensions\/XInput2?\.h$|^xi$/, "libxi-dev"],
  [/^X11\/Xcursor\/|^xcursor$/, "libxcursor-dev"],
  [/^X11\/|^x11$|^X11$/, "libx11-dev"],
  [/^libpq-fe\.h$|^libpq$|^pq$|^postgresql\/|^pg_config\.h$/, "libpq-dev"],
  [/^mysql\.h$|^mysql\/|^mysqlclient$|^mariadb$|^mariadb\/|^libmariadb$/, "default-libmysqlclient-dev"],
  [/^curl\/|^libcurl$|^curl$/, "libcurl4-openssl-dev"],
  [/^uuid\/|^uuid$/, "uuid-dev"],
  [/^n?curses\.h$|^ncurses(w)?$/, "libncurses-dev"],
  [/^magic\.h$|^magic$|^libmagic$/, "libmagic-dev"],
  [/^libusb-1\.0\/|^libusb-1\.0$|^usb-1\.0$/, "libusb-1.0-0-dev"],
  [/^alsa\/|^alsa$|^asound$/, "libasound2-dev"],
  [/^gdbm\.h$|^gdbm$/, "libgdbm-dev"],
  [/^expat\.h$|^expat$/, "libexpat1-dev"],
  [/^ft2build\.h$|^freetype\/|^freetype2$|^freetype$/, "libfreetype-dev"],
  [/^tiffio\.h$|^libtiff-4$|^tiff$/, "libtiff-dev"],
  [/^webp\/|^libwebp$|^webp$/, "libwebp-dev"],
  [/^vips\/|^vips(-cpp)?$/, "libvips-dev"],
  [/^hdf5\.h$|^hdf5$/, "libhdf5-dev"],
  [/^cblas\.h$|^lapacke\.h$|^openblas$|^lapack$|^blas$/, "libopenblas-dev"],
  [/^fftw3\.h$|^fftw3$/, "libfftw3-dev"],
  [/^geos_c\.h$|^geos(_c)?$/, "libgeos-dev"],
  [/^gdal\.h$|^gdal$/, "libgdal-dev"],
  [/^proj\.h$|^proj_api\.h$|^proj$/, "libproj-dev"],
  [/^libudev\.h$|^libudev$|^udev$/, "libudev-dev"],
  [/^dbus\/|^dbus-1$/, "libdbus-1-dev"],
  [/^glib\.h$|^glib-object\.h$|^glib-2\.0$|^gobject-2\.0$|^gio-2\.0$/, "libglib2.0-dev"],
  [/^girepository\.h$|^gobject-introspection-1\.0$/, "libgirepository1.0-dev"],
  [/^gtk\/|^gtk\+-3\.0$/, "libgtk-3-dev"],
  [/^security\/pam_appl\.h$|^pam$/, "libpam0g-dev"],
  [/^zstd\.h$|^libzstd$|^zstd$/, "libzstd-dev"],
  [/^lz4\.h$|^liblz4$|^lz4$/, "liblz4-dev"],
  [/^snappy-c\.h$|^snappy$/, "libsnappy-dev"],
  [/^gpgme\.h$|^gpgme$/, "libgpgme-dev"],
  [/^systemd\/|^libsystemd$/, "libsystemd-dev"],
  [/^libmemcached\/|^libmemcached$|^memcached$/, "libmemcached-dev"],
  [/^argon2\.h$|^libargon2$|^argon2$/, "libargon2-dev"],
  [/^sodium\.h$|^libsodium$|^sodium$/, "libsodium-dev"],
  [/^libsecret\/|^libsecret-1$/, "libsecret-1-dev"],
  [/^libavcodec\/|^libavformat\/|^libavutil\/|^libswscale\/|^libav\w+$/, "libavformat-dev libavcodec-dev libavutil-dev libswscale-dev"],
  [/^opus\/|^opus$/, "libopus-dev"],
  [/^sndfile\.h$|^sndfile$/, "libsndfile1-dev"],
  [/^tesseract\/|^tesseract$|^lept$|^leptonica\//, "libtesseract-dev libleptonica-dev"],
  [/^poppler\/|^poppler(-cpp|-glib)?$/, "libpoppler-cpp-dev"],
  [/^libheif\/|^libheif$/, "libheif-dev"],
  [/^jansson\.h$|^jansson$/, "libjansson-dev"],
  [/^unicode\/|^icu-uc$|^icu-i18n$|^icu\w*$/, "libicu-dev"],
];

export function packageForHeader(name: string): string | null {
  for (const [re, pkg] of HEADER_PACKAGES) if (re.test(name)) return pkg;
  return null;
}

/** Import names that differ from the PyPI package that provides them. */
export const PYPI_NAMES: Record<string, string> = {
  cv2: "opencv-python-headless",
  PIL: "Pillow",
  yaml: "PyYAML",
  sklearn: "scikit-learn",
  skimage: "scikit-image",
  bs4: "beautifulsoup4",
  dotenv: "python-dotenv",
  jwt: "PyJWT",
  jose: "python-jose",
  Crypto: "pycryptodome",
  Cryptodome: "pycryptodomex",
  dateutil: "python-dateutil",
  docx: "python-docx",
  pptx: "python-pptx",
  attr: "attrs",
  serial: "pyserial",
  OpenSSL: "pyOpenSSL",
  MySQLdb: "mysqlclient",
  psycopg2: "psycopg2-binary",
  psycopg: "psycopg[binary]",
  "google.protobuf": "protobuf",
  "google.generativeai": "google-generativeai",
  "google.genai": "google-genai",
  "google.cloud.storage": "google-cloud-storage",
  "google.cloud.bigquery": "google-cloud-bigquery",
  "google.cloud.firestore": "google-cloud-firestore",
  "google.oauth2": "google-auth",
  "google.auth": "google-auth",
  googleapiclient: "google-api-python-client",
  magic: "python-magic",
  fitz: "PyMuPDF",
  telegram: "python-telegram-bot",
  discord: "discord.py",
  multipart: "python-multipart",
  slugify: "python-slugify",
  socketio: "python-socketio",
  engineio: "python-engineio",
  usb: "pyusb",
  zmq: "pyzmq",
  gi: "PyGObject",
  win32api: "pywin32",
  wx: "wxPython",
  Levenshtein: "python-Levenshtein",
  sentencepiece: "sentencepiece",
  faiss: "faiss-cpu",
  lxml: "lxml",
  markdown: "Markdown",
  jinja2: "Jinja2",
  flask_cors: "flask-cors",
  flask_sqlalchemy: "Flask-SQLAlchemy",
  flask_login: "Flask-Login",
  flask_migrate: "Flask-Migrate",
  flask_wtf: "Flask-WTF",
  flask_socketio: "Flask-SocketIO",
  flask_restful: "Flask-RESTful",
  flask_jwt_extended: "Flask-JWT-Extended",
  flask_mail: "Flask-Mail",
  flask_bcrypt: "Flask-Bcrypt",
  rest_framework: "djangorestframework",
  corsheaders: "django-cors-headers",
  environ: "django-environ",
  dj_database_url: "dj-database-url",
  decouple: "python-decouple",
  crispy_forms: "django-crispy-forms",
  debug_toolbar: "django-debug-toolbar",
  storages: "django-storages",
  django_extensions: "django-extensions",
  whitenoise: "whitenoise",
  pydantic_settings: "pydantic-settings",
  speech_recognition: "SpeechRecognition",
  pyaudio: "PyAudio",
  sounddevice: "sounddevice",
  torch: "torch",
  tensorflow: "tensorflow-cpu",
  distutils: "setuptools",
  pkg_resources: "setuptools",
  _cffi_backend: "cffi",
  imp: "setuptools",
  tomli: "tomli",
  Bio: "biopython",
  ruamel: "ruamel.yaml",
  pymysql: "PyMySQL",
  github: "PyGithub",
  git: "GitPython",
  nacl: "PyNaCl",
  kafka: "kafka-python",
  websocket: "websocket-client",
  pkg: "pkg",
  igraph: "python-igraph",
  osgeo: "GDAL",
  shapefile: "pyshp",
  umap: "umap-learn",
  hdbscan: "hdbscan",
  llama_index: "llama-index",
  langchain_openai: "langchain-openai",
  langchain_community: "langchain-community",
  langchain_core: "langchain-core",
  sentence_transformers: "sentence-transformers",
  pinecone: "pinecone",
  chromadb: "chromadb",
  qdrant_client: "qdrant-client",
};

/** The PyPI package for a missing import, or null for names that can't be installed (stdlib, the repo's own code). */
export function pypiFor(module: string, local: string[] = []): string | null {
  const top = module.split(".")[0]!;
  if (local.includes(top)) return null;
  if (PYPI_NAMES[module]) return PYPI_NAMES[module]!;
  const two = module.split(".").slice(0, 2).join(".");
  if (PYPI_NAMES[two]) return PYPI_NAMES[two]!;
  if (PYPI_NAMES[top]) return PYPI_NAMES[top]!;
  if (/^(google|azure|aws)$/.test(top)) return null;
  if (!/^[A-Za-z][\w]*$/.test(top) || /^(tkinter|_tkinter|tomllib|__main__|test|tests|src|app|main|config|settings|utils|models|api)$/.test(top)) return null;
  return top.replace(/_/g, "-");
}

const NODE_BUILTINS = new Set(
  "assert buffer child_process cluster console constants crypto dgram dns domain events fs http http2 https inspector module net os path perf_hooks process punycode querystring readline repl stream string_decoder timers tls trace_events tty url util v8 vm wasi worker_threads zlib".split(" "),
);

/** The npm package for a bare import specifier (`lodash/fp` → lodash, `@scope/pkg/x` → @scope/pkg). */
export function npmPackageOf(spec: string): string | null {
  if (/^(\.|\/|node:|#|~|@\/|virtual:)/.test(spec)) return null;
  const parts = spec.split("/");
  const name = spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0]!;
  if (NODE_BUILTINS.has(name) || !/^(@[\w.-]+\/)?[\w.-]+$/.test(name)) return null;
  return name;
}

/** Tools a command can need that the box installs on demand. */
export const TOOLS: Record<string, string> = {
  poetry: "pip install poetry",
  pipenv: "pip install pipenv",
  pdm: "pip install pdm",
  hatch: "pip install hatch",
  tox: "pip install tox",
  nox: "pip install nox",
  just: "mise use -g just@latest",
  task: "mise use -g task@latest",
  go: "mise use -g go@latest",
  cargo: "mise use -g rust@stable",
  rustc: "mise use -g rust@stable",
  ruby: "mise use -g ruby@3.3",
  bundle: "mise use -g ruby@3.3",
  gem: "mise use -g ruby@3.3",
  deno: "mise use -g deno@latest",
  java: "mise use -g java@21",
  mvn: "mise use -g maven@latest",
  gradle: "mise use -g gradle@latest",
  php: apt("php-cli", "php-mbstring", "php-xml", "php-curl", "php-sqlite3", "php-zip"),
  composer: apt("php-cli", "php-mbstring", "php-xml", "php-curl", "php-zip", "composer"),
  elixir: "mise use -g erlang@latest elixir@latest",
  mix: "mise use -g erlang@latest elixir@latest",
  hugo: "mise use -g hugo@latest",
  air: "mise use -g go@latest && go install github.com/air-verse/air@latest",
  nodemon: "npm install -g nodemon",
  "ts-node": "npm install -g ts-node typescript",
  tsx: "npm install -g tsx",
  foreman: "pip install honcho && ln -sf /opt/venv/bin/honcho /usr/local/bin/foreman",
  ffmpeg: apt("ffmpeg"),
  convert: apt("imagemagick"),
  redis: apt("redis-server"),
};

// ---------------------------------------------------------------- rules

const PLACEHOLDER_URL = /(_URL|_URI|_ENDPOINT|_HOST)$/;

/** A value that lets the app boot without a real credential. */
export function placeholderFor(name: string, plan: Plan): string {
  if (name === "DATABASE_URL") return plan.env.DATABASE_URL ?? "sqlite:///db.sqlite3";
  if (name === "PORT") return String(plan.port ?? 3000);
  if (/SECRET|SALT|SIGNING|ENCRYPTION|SESSION|COOKIE/.test(name) && !/API|CLIENT/.test(name)) return randomBytes(32).toString("hex");
  if (/^NEXTAUTH_URL$|^(APP|BASE|SITE|PUBLIC|FRONTEND|CLIENT)_URL$/.test(name)) return `http://localhost:${plan.port ?? 3000}`;
  if (PLACEHOLDER_URL.test(name)) return name.endsWith("_HOST") ? "localhost" : "http://localhost";
  if (/_PORT$/.test(name)) return "0";
  if (/OPENAI/.test(name)) return "sk-placeholder";
  if (/(DEBUG|ENABLED|_ENABLE)$/.test(name)) return "false";
  return "placeholder";
}

function retryWith(command: string, re: RegExp, replace: string): string {
  return command.replace(re, replace);
}

/** Every failing install command is matched against these, in order; specific rules come before generic ones. */
export const REPAIR_RULES: RepairRule[] = [
  // ---- runtimes and package managers
  {
    id: "node-engine",
    phase: "any",
    description: 'A package needs a different Node.js ("The engine node is incompatible", "requires node >=18"): install that version with mise, then retry.',
    prior: 0.7,
    match(_cmd, out) {
      const m = first(out, [
        /The engine "node" is incompatible with this module\. Expected version "([^"]+)"/,
        /Your Node version is incompatible with "[^"]*"\.[\s\S]{0,200}?Expected version: ([^\n]+)/,
        /ERR_PNPM_UNSUPPORTED_ENGINE[\s\S]{0,400}?Expected version: ([^\n]+)/,
        /requires (?:a )?node(?:\.js)?(?: version)?\s*(?:of\s*)?((?:>=?|\^|~)?\s*v?\d+(?:\.[\dx]+)*(?:\s*(?:<|\|\|)\s*v?\d+(?:\.[\dx]+)*)?)/i,
        /Node\.js (?:version )?v?((?:>=?|\^)?\d+(?:\.\d+)*)(?:\.\d+)* or (?:higher|newer|later) is required/i,
        /You are using Node\.js v?[\d.]+\. [\w.\s]+ requires Node\.js version ([^\s.]+(?:\.\d+)*)/i,
      ]);
      if (!m) return null;
      const range = withoutOrHigher(m[1]!.trim());
      const major = nodeMajorFor(/^\d+$/.test(range) && /or (higher|newer|later)|requires/i.test(m[0]) ? `>=${range}` : range);
      return major ? { major: String(major), range } : null;
    },
    fix: (c) => ({ run: [`mise use -g node@${c.major}`], note: `It needs Node ${c.range}. Switching to Node ${c.major}.` }),
  },
  {
    id: "corepack-pm",
    phase: "install",
    description: "packageManager pins a Yarn or pnpm version the box doesn't have (yarn@4, pnpm@9): prepare it with corepack, then retry.",
    prior: 0.75,
    match(cmd, out) {
      const m = first(out, [
        /packageManager"?:\s*"?(yarn|pnpm)@(\d+(?:\.\d+)*)/,
        /This project is configured to use (yarn|pnpm)(?:@| version )?(\d+(?:\.\d+)*)?/,
        /The project in .* is configured to use (yarn|pnpm)/,
        /defines "packageManager": "(yarn|pnpm)@(\d[\w.+-]*)"/,
      ]);
      if (!m || !/\b(yarn|pnpm|corepack)\b/.test(cmd + out)) return null;
      return { pm: m[1]!, version: (m[2] ?? "latest").split("+")[0]! };
    },
    fix: (c) => ({ run: ["corepack enable", `corepack prepare ${c.pm}@${c.version} --activate`], note: `The project pins ${c.pm} ${c.version}. Preparing it with corepack.` }),
  },
  {
    id: "corepack-keys",
    phase: "install",
    description: 'Corepack can\'t verify a package manager download ("Cannot find matching keyid"): skip the stale signature check and retry.',
    prior: 0.8,
    match: (_cmd, out) => (/Cannot find matching keyid|corepack.*signature/i.test(out) ? {} : null),
    fix: () => ({ env: { COREPACK_INTEGRITY_KEYS: "0" }, note: "Corepack's signing keys are out of date. Retrying without the signature check." }),
  },
  {
    id: "python-version",
    phase: "any",
    description: 'A package or the project needs a different Python ("requires a different Python", requires-python): make a venv with that version via uv, then retry.',
    prior: 0.7,
    match(_cmd, out) {
      const m = first(out, [
        /requires a different Python: [\d.]+ not in '([^']+)'/,
        /the current Python version \([\d.]+\) does not satisfy Python([<>=!~^][^\s,]*(?:,\s*[<>=!~][^\s,]*)*)/,
        /Python requirement \(([^)]+)\)/,
        /is not allowed by the project \(([^)]+)\)/,
        /Requires-Python ([<>=!~][^\s;]+)/,
        /requires Python ([<>=!~]=?\s*3\.\d+)/i,
      ]);
      if (!m) return null;
      const version = pythonFor(m[1]!);
      return version ? { version, range: m[1]! } : null;
    },
    fix: (c) => ({ run: [pythonVenv(c.version!)], note: `It needs Python ${c.range}. Creating a Python ${c.version} environment.` }),
  },
  {
    id: "go-version",
    phase: "any",
    description: 'go.mod needs a newer Go ("go.mod requires go >= 1.23"): install it with mise, then retry.',
    prior: 0.8,
    match(_cmd, out) {
      const m = /go(?:\.mod)? requires go >= ?(\d+\.\d+(?:\.\d+)?)/.exec(out) ?? /requires go(\d+\.\d+(?:\.\d+)?) or later/.exec(out);
      return m ? { version: m[1]! } : null;
    },
    fix: (c) => ({ run: [`mise use -g go@${c.version}`], note: `It needs Go ${c.version}. Installing it.` }),
  },
  {
    id: "php-version",
    phase: "any",
    description:
      'Composer needs a newer PHP than Debian ships ("requires php ^8.3 but your php version (8.2.x)"): install it from the Sury repository, then retry.',
    prior: 0.75,
    match(_cmd, out) {
      if (!/your php version \([\d.]+\) does not satisfy/i.test(out)) return null;
      const m = /requires php (?:\^|~|>=\s?)?(8\.\d+)/i.exec(out);
      return m ? { version: m[1]! } : null;
    },
    fix: (c) => {
      const v = c.version!;
      const exts = ["cli", "mbstring", "xml", "curl", "sqlite3", "zip", "bcmath", "intl", "gd", "pgsql", "mysql"].map((e) => `php${v}-${e}`);
      return {
        run: [
          `${apt("ca-certificates", "curl")} && curl -fsSLo /tmp/sury-keyring.deb https://packages.sury.org/debsuryorg-archive-keyring.deb && dpkg -i /tmp/sury-keyring.deb && . /etc/os-release && echo "deb [signed-by=/usr/share/keyrings/debsuryorg-archive-keyring.gpg] https://packages.sury.org/php/ $VERSION_CODENAME main" > /etc/apt/sources.list.d/php.list`,
          `${apt(...exts)} && update-alternatives --set php /usr/bin/php${v}`,
        ],
        note: `The project needs PHP ${v}, newer than the box's. Installing it.`,
      };
    },
  },
  {
    id: "ruby-version",
    phase: "any",
    description: 'The Gemfile pins another Ruby ("Your Ruby version is 3.3.0, but your Gemfile specified 3.2.2"): install it with mise, then retry.',
    prior: 0.8,
    match(_cmd, out) {
      const m = /Your Ruby version is [\d.]+, but your Gemfile specified (?:~> |>= )?(\d+\.\d+(?:\.\d+)?)/.exec(out) ?? /requires ruby version (?:>= |~> )?(\d+\.\d+(?:\.\d+)?)/i.exec(out);
      return m ? { version: m[1]! } : null;
    },
    fix: (c) => ({ run: [`mise use -g ruby@${c.version}`, "gem install bundler --conservative"], note: `The Gemfile wants Ruby ${c.version}. Installing it.` }),
  },
  {
    id: "tauri-no-rust",
    phase: "launch",
    description: "A Tauri project's start runs the native shell, which needs Rust (cargo metadata: No such file or directory, cargo: not found): start the web frontend instead and say what does not work.",
    prior: 0.9,
    match(cmd, out) {
      const rustMissing = /failed to run (?:'cargo metadata' command|command (?:cargo|rustc)\b)|(?:^|\n)(?:\/\S+: |bash: |sh: (?:\d+: )?)?(?:line \d+: )?(?:cargo|rustc): (?:command )?not found|`(?:cargo|rustc)` (?:is )?not found|no such command: `tauri`/i.test(out);
      return rustMissing && /\btauri\b/i.test(`${cmd}\n${out}`) ? { command: cmd } : null;
    },
    fix(c, plan) {
      const command = c.command ?? "";
      const known = plan.facts?.tauri;
      // The detector's reading of the project when the plan has it; a plan from elsewhere has the script names, or nothing.
      const failing = command.split(/\s/).filter(Boolean).at(-1);
      const scripts = plan.facts?.scripts;
      const tried = plan.facts?.tried ?? [];
      const pm = pmOf(plan, command);
      // Without the script names there is nothing to pick from, and a guess may not exist.
      const script = scripts ? START_SCRIPTS.find((s) => scripts.includes(s) && s !== failing && !tried.includes(runScript(pm, s))) : undefined;
      const retry = known ? known.start : script ? runScript(pm, script) : null;
      if (!retry || retry === command) return null;
      const port = known?.port ?? null;
      return {
        retry,
        ...(port ? { env: { PORT: String(port) }, port } : {}),
        note: `The start runs the Tauri desktop shell, which needs Rust. Starting its web page with \`${retry}\` instead.`,
        planNote: TAURI_RUNS_NOTE,
      };
    },
  },
  {
    id: "missing-tool",
    phase: "any",
    description: "A command the project uses isn't installed (poetry, just, go, cargo, deno, php…): install it, then retry.",
    prior: 0.75,
    match(_cmd, out) {
      const m = /(?:^|\n)(?:\/\S+: )?(?:bash: |sh: (?:\d+: )?|\/usr\/bin\/env: ‘?'?)?(?:line \d+: )?([\w.+-]+)(?:’|')?: (?:command )?not found/.exec(out) ?? /env: ['‘]?([\w.-]+)['’]?: No such file or directory/.exec(out);
      return m && TOOLS[m[1]!] ? { tool: m[1]! } : null;
    },
    fix: (c) => ({ run: [TOOLS[c.tool!]!], note: `\`${c.tool}\` isn't installed in the box yet. Installing it.` }),
  },
  {
    id: "node-modules-missing",
    phase: "any",
    description: "A JavaScript tool from the project's dependencies isn't on PATH (vite: not found, next: not found): install the folder's dependencies, then retry.",
    prior: 0.6,
    match(_cmd, out) {
      const m = /(?:^|\n)(?:sh: \d+: |bash: |\/bin\/sh: (?:\d+: )?)?(vite|next|nuxt|nuxi|astro|react-scripts|vue-cli-service|ng|webpack|webpack-dev-server|tsc|ts-node|tsx|nodemon|concurrently|cross-env|remix|gatsby|svelte-kit|parcel|esbuild|rollup|turbo|nx|prisma|vitepress|docusaurus|eleventy|storybook|serve|http-server|nest|expo|electron|rimraf|run-p|run-s|npm-run-all)(?:: command)?: not found/.exec(out);
      return m ? { tool: m[1]! } : null;
    },
    fix(c, plan) {
      const pm = pmOf(plan);
      return { run: [installCommand(pm)], note: `\`${c.tool}\` comes from the project's dependencies, which aren't installed in this folder yet. Installing them.` };
    },
  },
  // ---- JavaScript installs
  {
    id: "npm-peer-deps",
    phase: "install",
    description: "npm can't resolve peer dependencies (ERESOLVE): retry with --legacy-peer-deps.",
    prior: 0.85,
    match: (cmd, out) => (/\bnpm (install|ci|i)\b/.test(cmd) && !/--legacy-peer-deps/.test(cmd) && /ERESOLVE|peer dep|Could not resolve dependency/i.test(out) ? {} : null),
    fix: () => ({ retry: "", note: "npm hit a peer-dependency conflict. Retrying with --legacy-peer-deps, the way most projects install." }),
  },
  {
    id: "npm-ci-lockfile",
    phase: "install",
    description: "npm ci needs a package-lock.json in sync with package.json: retry with npm install.",
    prior: 0.85,
    match: (cmd, out) => (/\bnpm ci\b/.test(cmd) && /can only install (packages )?(when your package\.json and package-lock\.json|with an existing package-lock)|npm-shrinkwrap|in sync/i.test(out) ? {} : null),
    fix: () => ({ retry: "", note: "The lockfile is missing or out of date. Retrying with npm install." }),
  },
  {
    id: "pnpm-engine-strict",
    phase: "install",
    description: "pnpm refuses a dependency's engines field (ERR_PNPM_UNSUPPORTED_ENGINE): retry without engine-strict.",
    prior: 0.7,
    match: (cmd, out) => (/\bpnpm (install|i)\b/.test(cmd) && !/engine-strict/.test(cmd) && /ERR_PNPM_UNSUPPORTED_ENGINE|Unsupported engine/i.test(out) ? {} : null),
    fix: () => ({ retry: "", note: "A dependency declares an engine the box doesn't match. Retrying without the strict engine check." }),
  },
  {
    id: "git-ssh-deps",
    phase: "install",
    description: "A dependency is fetched over SSH (Permission denied (publickey)): rewrite GitHub and GitLab SSH URLs to HTTPS, then retry.",
    prior: 0.7,
    match: (_cmd, out) => (/Permission denied \(publickey\)|Host key verification failed|ssh: connect to host (?:github|gitlab)\.com/.test(out) ? {} : null),
    fix: () => ({
      run: [
        'git config --global url."https://github.com/".insteadOf "git@github.com:"',
        'git config --global --add url."https://github.com/".insteadOf "ssh://git@github.com/"',
        'git config --global url."https://gitlab.com/".insteadOf "git@gitlab.com:"',
        'git config --global --add url."https://gitlab.com/".insteadOf "ssh://git@gitlab.com/"',
      ],
      note: "A dependency points at GitHub or GitLab over SSH. Fetching it over HTTPS instead.",
    }),
  },
  // ---- native builds
  {
    id: "pg-config",
    phase: "install",
    description: "psycopg2 or another Postgres driver can't find pg_config: install libpq-dev, then retry.",
    prior: 0.8,
    match: (_cmd, out) => (/pg_config executable not found|pg_config: (command )?not found|Error: pg_config|libpq-fe\.h/.test(out) ? {} : null),
    fix: () => ({ run: [apt("libpq-dev")], note: "Building the Postgres driver needs libpq-dev. Installing it." }),
  },
  {
    id: "psycopg2-binary",
    phase: "install",
    description: "psycopg2 still won't build: switch the requirement to the prebuilt psycopg2-binary, then retry.",
    prior: 0.6,
    match(cmd, out) {
      const req = /-r\s+(\S*requirements[\w.-]*\.txt)/.exec(cmd);
      return req && /psycopg2/.test(out) && /pg_config|Failed building wheel for psycopg2|psycopg2.*error/i.test(out) ? { file: req[1]! } : null;
    },
    fix: (c) => ({
      run: [`sed -i -E 's/^psycopg2([^-_a-zA-Z]|$)/psycopg2-binary\\1/' ${c.file}`],
      note: "psycopg2 won't compile here. Using psycopg2-binary, the same driver prebuilt.",
    }),
  },
  {
    id: "mysql-config",
    phase: "install",
    description: "mysqlclient can't find mysql_config: install default-libmysqlclient-dev and pkg-config, then retry.",
    prior: 0.8,
    match: (_cmd, out) => (/mysql_config( not found|: not found)|OSError: mysql_config|Can not find valid pkg-config name|pkg-config.*(mysqlclient|mariadb)/.test(out) ? {} : null),
    fix: () => ({ run: [apt("default-libmysqlclient-dev", "pkg-config", "build-essential")], note: "Building the MySQL driver needs its client headers. Installing them." }),
  },
  {
    id: "native-header",
    phase: "install",
    description: "A native extension is missing a C header or library (ffi.h, openssl/ssl.h, Python.h, libpq-fe.h, -lz …): install the Debian -dev package, then retry.",
    prior: 0.75,
    match(_cmd, out) {
      const names: string[] = [];
      for (const m of out.matchAll(/(?:fatal error: |error: )?([\w/+.-]+\.h): No such file or directory/g)) names.push(m[1]!);
      for (const m of out.matchAll(/Package '?([\w.+-]+)'?,? (?:required by '[^']*', )?(?:was )?not found/g)) names.push(m[1]!);
      for (const m of out.matchAll(/(?:cannot find|unable to find library) -l([\w.+-]+)/g)) names.push(m[1]!);
      for (const m of out.matchAll(/(?:Could not find|Couldn't find|Unable to find) (?:the )?(?:library |package )?['"]?(libffi|openssl|libxml2|libxslt|zlib|libjpeg|cairo|sqlite3|libpq|freetype|libpng)['"]?/gi)) names.push(m[1]!.toLowerCase());
      const pkgs = [...new Set(names.map((n) => packageForHeader(n.replace(/^lib(?=\w+-dev$)/, ""))).filter((p): p is string => p !== null))];
      return pkgs.length ? { packages: pkgs.join(" "), header: names[0]! } : null;
    },
    fix: (c) => ({ run: [apt(...c.packages!.split(" "))], note: `The build needs ${c.header}. Installing ${c.packages}.` }),
  },
  {
    id: "node-gyp",
    phase: "install",
    description: "node-gyp fails to compile a native module (gyp ERR!): install build-essential, python3, make and g++, then retry.",
    prior: 0.45,
    match: (_cmd, out) => (/gyp ERR!|node-gyp rebuild|gyp: (?:Call to|No Xcode)|make: (g\+\+|cc|gcc): (?:Command )?not found/.test(out) ? {} : null),
    fix: () => ({ run: [apt("build-essential", "python3", "make", "g++")], note: "A native module failed to compile. Making sure the C++ toolchain is installed." }),
  },
  // ---- Ruby
  {
    id: "bundle-install",
    phase: "any",
    description: "Bundler can't find gems (Bundler::GemNotFound, \"Run `bundle install`\"): run bundle install, then retry.",
    prior: 0.75,
    match: (cmd, out) => (!/^bundle install\b/.test(cmd) && /Bundler::GemNotFound|Could not find gem '|Run `bundle install` to install missing gems|bundler: command not found: \w+/.test(out) ? {} : null),
    fix: () => ({ run: ["bundle install"], note: "Some gems aren't installed yet. Running bundle install." }),
  },
  // ---- Python
  {
    id: "uv-to-pip",
    phase: "install",
    description: "uv can't install something plain pip can (resolver differences, legacy setup.py): retry the same install with pip.",
    prior: 0.5,
    match: (cmd) => (/\buv pip install\b/.test(cmd) ? {} : null),
    fix: () => ({ retry: "", note: "uv couldn't install this. Retrying with pip." }),
  },
  {
    id: "python-missing-module",
    phase: "any",
    description: "Python can't import a package (No module named 'cv2'): install it from PyPI under its real name (cv2 → opencv-python-headless, PIL → Pillow, yaml → PyYAML …), then retry.",
    prior: 0.65,
    match(_cmd, out) {
      const m = /ModuleNotFoundError: No module named '([\w.]+)'/.exec(out) ?? /ImportError: No module named '?([\w.]+)'?/.exec(out);
      return m ? { module: m[1]! } : null;
    },
    fix(c, plan) {
      const top = c.module!.split(".")[0]!;
      if (plan.facts?.localModules?.includes(top)) {
        return { env: { PYTHONPATH: [plan.cwd, "/workspace"].filter((v, i, a) => a.indexOf(v) === i).join(":") }, note: `\`${top}\` is part of this repo. Adding it to PYTHONPATH.` };
      }
      const pkg = pypiFor(c.module!, plan.facts?.localModules);
      if (!pkg) return null;
      const quoted = /[[\]]/.test(pkg) ? `'${pkg}'` : pkg;
      return { run: [`uv pip install ${quoted} || pip install ${quoted}`], note: `\`${c.module}\` isn't installed. Installing ${pkg}.` };
    },
  },
  // ---- JavaScript at runtime
  {
    id: "prisma-generate",
    phase: "any",
    description: 'Prisma Client hasn\'t been generated ("did not initialize yet", "Cannot find module \'.prisma/client\'"): run prisma generate, then retry.',
    prior: 0.85,
    match: (_cmd, out) => (/@prisma\/client did not initialize yet|run "prisma generate"|Cannot find module '\.prisma\/client|Prisma Client could not locate the Query Engine|PrismaClientInitializationError.*generate/.test(out) ? {} : null),
    fix: () => ({ run: ["npx prisma generate"], note: "Prisma's client isn't generated yet. Running prisma generate." }),
  },
  {
    id: "node-missing-build",
    phase: "launch",
    description: "The start script runs build output that doesn't exist yet (Cannot find module '/workspace/dist/index.js'): run the build script, then relaunch.",
    prior: 0.75,
    match(_cmd, out) {
      const m = /Cannot find module '(\/workspace\/[^']*\/(?:dist|build|out|lib|\.next)\/[^']*|\/workspace\/[^']*\/(?:dist|build|out)[^']*)'/.exec(out) ?? /Could not find a production build in the '([^']+)' directory/.exec(out);
      return m ? { path: m[1]! } : null;
    },
    fix(_c, plan) {
      if (!plan.facts?.scripts?.includes("build")) return null;
      const pm = pmOf(plan);
      return { run: [runScript(pm, "build")], note: "The start script needs a build first. Running the build." };
    },
  },
  {
    id: "pnpm-hoist-undeclared",
    phase: "any",
    description:
      "With pnpm, code imports a package it never declares (Module not found: Can't resolve '@mdx-js/react' in a Docusaurus 2 site), which pnpm keeps out of reach though another dependency installed it: reinstall with those packages hoisted to the top-level node_modules, then retry.",
    prior: 0.7,
    match(_cmd, out) {
      const pkgs = new Set<string>();
      for (const re of UNRESOLVED) {
        for (const m of out.matchAll(re)) {
          const pkg = npmPackageOf(m[1]!);
          if (pkg && !/^\.prisma/.test(pkg)) pkgs.add(pkg);
          if (pkgs.size >= 8) break;
        }
      }
      return pkgs.size ? { pkgs: [...pkgs].sort().join(" ") } : null;
    },
    fix(c, plan) {
      if (pmOf(plan) !== "pnpm") return null;
      const pkgs = c.pkgs!.split(" ");
      // Only a package pnpm already installed for another dependency can be hoisted. One that isn't there at all is
      // missing, and the next rule adds it. The store is at the workspace's root, wherever the app's folder is.
      const store = '"$(pnpm root -w 2>/dev/null || pnpm root)/.pnpm/node_modules"';
      const present = pkgs.map((p) => `[ -d ${store}/${p} ]`).join(" && ");
      const hoist = pkgs.map((p) => `--public-hoist-pattern='${p}'`).join(" ");
      const names = pkgs.map((p) => `\`${p}\``).join(", ");
      return {
        run: [`${present} && ${installCommand("pnpm")} --config.confirm-modules-purge=false ${hoist}`],
        note: `The code imports ${names} without declaring ${pkgs.length === 1 ? "it" : "them"}. Another dependency installed ${pkgs.length === 1 ? "it" : "them"}, but pnpm only lets a package see what it declares. Reinstalling with ${pkgs.length === 1 ? "it" : "them"} hoisted to the top-level node_modules.`,
      };
    },
  },
  {
    id: "node-missing-module",
    phase: "any",
    description: "Node can't find a package (Cannot find module 'x', ERR_MODULE_NOT_FOUND): add it with the repo's package manager, then retry.",
    prior: 0.55,
    match(_cmd, out) {
      const m =
        /Cannot find package '([^']+)' imported from/.exec(out) ??
        /Error: Cannot find module '([^']+)'/.exec(out) ??
        /Module not found: (?:Error: )?Can't resolve '([^']+)'/.exec(out) ??
        /Failed to resolve import "([^"]+)"/.exec(out);
      const pkg = m ? npmPackageOf(m[1]!) : null;
      return pkg && !/^\.prisma/.test(pkg) ? { pkg } : null;
    },
    fix(c, plan) {
      const pm = pmOf(plan);
      // pnpm refuses to add to a workspace's root without -w (ERR_PNPM_ADDING_TO_ROOT).
      const add = pm === "pnpm" ? `${addCommand(pm, c.pkg!)} || pnpm add -w ${c.pkg}` : addCommand(pm, c.pkg!);
      return { run: [add], note: `\`${c.pkg}\` isn't installed. Adding it with ${pm}.` };
    },
  },
  // ---- databases
  {
    id: "run-migrations",
    phase: "any",
    description: 'The database has no tables yet (Django "no such table", Rails NoDatabaseError or pending migrations, Prisma P2021, Laravel SQLSTATE no such table, Flask/SQLAlchemy "no such table"): run the migrations (flask db upgrade for Flask-Migrate), then retry.',
    prior: 0.75,
    match(cmd, out) {
      if (/\b(migrate|db:prepare|db:migrate|db push|alembic upgrade|db upgrade)\b/.test(cmd)) return null;
      if (/ActiveRecord::(NoDatabaseError|PendingMigrationError)|Migrations are pending|ActiveRecord::StatementInvalid.*(no such table|does not exist)/.test(out)) return { tool: "rails" };
      if (/\bP2021\b|The table `[^`]+` does not exist in the current database/.test(out)) return { tool: "prisma" };
      if (/You have \d+ unapplied migration|django\.db\.utils\.(OperationalError|ProgrammingError): (no such table|relation "[^"]+" does not exist)/.test(out)) return { tool: "django" };
      if (/SQLSTATE\[(HY000|42S02|42P01)\].*(no such table|doesn't exist|does not exist)/.test(out)) return { tool: "laravel" };
      if (/sqlite3\.OperationalError(\)|:) no such table|sqlalchemy\.exc\.(OperationalError|ProgrammingError).*(no such table|does not exist)/.test(out)) return { tool: "sqlalchemy" };
      return null;
    },
    fix(c, plan) {
      const commands: Record<string, string> = {
        rails: "bin/rails db:prepare",
        prisma: "npx prisma migrate deploy || npx prisma db push --skip-generate",
        django: "python manage.py migrate --noinput",
        laravel: "php artisan migrate --force",
      };
      // SQLAlchemy has no migration command of its own: the detector's (Flask-Migrate's `flask db upgrade`) or nothing.
      const command = plan.facts?.migrate ?? commands[c.tool!];
      return command ? { run: [command], note: "The database has no tables yet. Running the migrations." } : null;
    },
  },
  // ---- environment
  {
    id: "missing-env",
    phase: "any",
    description: 'The app needs an environment variable (KeyError: \'X\', "Missing required environment variable X", Prisma "Environment variable not found: X"): set a safe placeholder, then retry.',
    prior: 0.6,
    match(_cmd, out) {
      const names = new Set<string>();
      const patterns = [
        /KeyError: '([A-Z][A-Z0-9_]{2,})'/g,
        /Environment variable not found: ([A-Z][A-Z0-9_]+)/g,
        /[Mm]issing (?:required )?env(?:ironment)?(?: variable)?s?:?\s+['"`]?([A-Z][A-Z0-9_]{2,})/g,
        /(?:env(?:ironment)? variable|env var) ['"`]?([A-Z][A-Z0-9_]{2,})['"`]? (?:is )?(?:not set|missing|required|undefined|must be set)/gi,
        /\b([A-Z][A-Z0-9_]{2,}) (?:environment variable )?(?:is not set|must be set|is required|is missing|is undefined)\b/g,
        /ImproperlyConfigured: Set the ([A-Z][A-Z0-9_]+) environment variable/g,
        /The ([A-Z][A-Z0-9_]+) environment variable is (?:missing|not set|required)/g,
        /❌ Invalid environment variables:[\s\S]{0,40}?([A-Z][A-Z0-9_]{2,}):/g,
        /pydantic[\s\S]{0,200}?\n([A-Za-z][A-Za-z0-9_]{2,})\n\s+Field required/g,
      ];
      for (const re of patterns) for (const m of out.matchAll(re)) if (m[1] && !/^(PATH|HOME|NODE_ENV)$/.test(m[1])) names.add(m[1].toUpperCase());
      return names.size ? { names: [...names].slice(0, 6).join(",") } : null;
    },
    fix(c, plan) {
      const env: Record<string, string> = {};
      for (const name of c.names!.split(",")) if (plan.env[name] === undefined) env[name] = placeholderFor(name, plan);
      if (!Object.keys(env).length) return null;
      return { env, note: `It needs ${Object.keys(env).join(", ")}. Setting placeholder${Object.keys(env).length > 1 ? "s" : ""} so it can start; add real values in .env if a feature needs them.` };
    },
  },
  {
    id: "openssl-legacy",
    phase: "any",
    description: "Old webpack on Node 17+ fails with ERR_OSSL_EVP_UNSUPPORTED: set NODE_OPTIONS=--openssl-legacy-provider, then retry.",
    prior: 0.9,
    match: (_cmd, out) => (/ERR_OSSL_EVP_UNSUPPORTED|error:0308010C:digital envelope routines::unsupported/.test(out) ? {} : null),
    fix: (_c, plan) => ({ env: { NODE_OPTIONS: `${plan.env.NODE_OPTIONS ?? ""} --openssl-legacy-provider`.trim() }, note: "This webpack version predates Node 17's OpenSSL. Enabling the legacy provider." }),
  },
  {
    id: "node-heap",
    phase: "any",
    description: "Node runs out of memory (JavaScript heap out of memory): raise the heap limit, then retry.",
    prior: 0.6,
    match: (_cmd, out) => (/JavaScript heap out of memory|Reached heap limit/.test(out) ? {} : null),
    fix: (_c, plan) => ({ env: { NODE_OPTIONS: `${(plan.env.NODE_OPTIONS ?? "").replace(/--max-old-space-size=\d+/, "")} --max-old-space-size=3072`.trim() }, note: "Node ran out of memory. Giving it a 3 GB heap." }),
  },
  {
    id: "port-in-use",
    phase: "launch",
    description: "Another process holds the port (EADDRINUSE, \"address already in use\"): move the app to the next port with PORT, then relaunch.",
    prior: 0.7,
    match(_cmd, out) {
      const m = /EADDRINUSE[^\n]*?:(\d{2,5})\b/.exec(out) ?? /[Aa]ddress already in use[^\n]*?(?:port |:)(\d{2,5})\b/.exec(out) ?? /[Pp]ort (\d{2,5}) is (?:already )?in use/.exec(out) ?? /(?:Errno 98|OSError: \[Errno 98\])[^\n]*?(\d{2,5})?/.exec(out);
      return m ? { port: m[1] ?? "" } : null;
    },
    fix(c, plan) {
      const current = Number(c.port) || plan.port || 3000;
      const next = current + 1;
      const retry = plan.start && new RegExp(`(--port[= ]|-p\\s*|:)${current}\\b`).test(plan.start) ? plan.start.replace(new RegExp(`(--port[= ]|-p\\s*|:)${current}\\b`), `$1${next}`) : undefined;
      return { env: { PORT: String(next) }, port: next, ...(retry ? { retry } : {}), note: `Port ${current} is taken. Moving the app to ${next}.` };
    },
  },
  {
    id: "file-watchers",
    phase: "launch",
    description: "The dev server runs out of file watchers (ENOSPC: System limit for number of file watchers): switch watchers to polling, then relaunch.",
    prior: 0.85,
    match: (_cmd, out) => (/ENOSPC: System limit for number of file watchers|inotify (watch )?limit|EMFILE: too many open files, watch|OS file watch limit reached/.test(out) ? {} : null),
    fix: () => ({ env: { CHOKIDAR_USEPOLLING: "true", WATCHPACK_POLLING: "true", WATCHFILES_FORCE_POLLING: "true" }, note: "The box ran out of file watchers. Switching the dev server to polling." }),
  },
  {
    id: "missing-script",
    phase: "launch",
    description: 'The start script doesn\'t exist ("Missing script: dev"): try the next script the package defines (start, serve, develop, preview).',
    prior: 0.7,
    match(_cmd, out) {
      const m = /Missing script: "?([\w:.-]+)"?/.exec(out) ?? /error Command "([\w:.-]+)" not found/.exec(out) ?? /ERR_PNPM_NO_SCRIPT[^\n]*?Missing script: ([\w:.-]+)/.exec(out) ?? /None of the selected packages has a "([\w:.-]+)" script/.exec(out);
      return m ? { script: m[1]! } : null;
    },
    fix(c, plan) {
      const next = ["dev", "start", "serve", "develop", "start:dev", "preview"].find((s) => s !== c.script && plan.facts?.scripts?.includes(s));
      if (!next) return null;
      return { retry: runScript(pmOf(plan, plan.start ?? ""), next), note: `There's no \`${c.script}\` script. Trying \`${next}\`.` };
    },
  },
  {
    id: "host-check",
    phase: "launch",
    description: 'A dev server rejects the preview\'s host ("Blocked request. This host is not allowed", "Invalid Host header"): allow it via env, then relaunch.',
    prior: 0.7,
    match(_cmd, out) {
      const vite = /Blocked request\. This host \("?([^")\s]+)"?\) is not allowed/.exec(out);
      if (vite) return { host: vite[1]!, tool: "vite" };
      if (/Invalid Host header/.test(out)) return { host: "", tool: "webpack" };
      if (/Invalid HTTP_HOST header: '([^']+)'/.test(out)) return { host: /Invalid HTTP_HOST header: '([^']+)'/.exec(out)![1]!, tool: "django" };
      return null;
    },
    fix(c): RepairFix {
      if (c.tool === "vite") return { env: { __VITE_ADDITIONAL_SERVER_ALLOWED_HOSTS: c.host! }, note: `Vite blocked the host ${c.host}. Allowing it.` };
      if (c.tool === "django") return { env: { ALLOWED_HOSTS: "*", DJANGO_ALLOWED_HOSTS: "*" }, note: "Django rejected the host. Allowing all hosts inside the box." };
      return { env: { DANGEROUSLY_DISABLE_HOST_CHECK: "true", WDS_SOCKET_HOST: "localhost" }, note: "The dev server checks the Host header. Turning that check off inside the box." };
    },
  },
];

/** The first run of a flag repeated with whitespace between (and before) the copies becomes one ` flag`. A scan, not a regex: `\s+flag(\s+flag)+` is quadratic on a long run of spaces. */
function collapseRepeatedFlag(s: string, flag: string): string {
  const space = (ch: string | undefined) => ch !== undefined && ch.trim() === "";
  for (let at = s.indexOf(flag); at >= 0; at = s.indexOf(flag, at + 1)) {
    if (!space(s[at - 1])) continue;
    let end = at + flag.length;
    let copies = 0;
    for (;;) {
      let k = end;
      while (space(s[k])) k++;
      if (k === end || !s.startsWith(flag, k)) break;
      end = k + flag.length;
      copies++;
    }
    if (copies === 0) continue;
    let start = at;
    while (space(s[start - 1])) start--;
    return `${s.slice(0, start)} ${flag}${s.slice(end)}`;
  }
  return s;
}

// npm-peer-deps, npm-ci-lockfile, pnpm-engine-strict and uv-to-pip rewrite the failing command itself.
const REWRITES: Record<string, (command: string) => string> = {
  "npm-peer-deps": (c) => collapseRepeatedFlag(retryWith(c, /\bnpm (?:ci|install|i)\b([^&|;]*)/, "npm install$1 --legacy-peer-deps"), "--legacy-peer-deps"),
  "npm-ci-lockfile": (c) => retryWith(c, /\bnpm ci\b/, "npm install"),
  "pnpm-engine-strict": (c) => retryWith(c, /\bpnpm (install|i)\b([^&|;]*)/, "pnpm $1$2 --config.engine-strict=false"),
  "uv-to-pip": (c) => retryWith(c, /\buv pip install\b/g, "pip install"),
};

export interface RepairMatch {
  rule: RepairRule;
  fix: RepairFix;
}

/** Only the end of a long log carries the error. */
const TAIL = 16 * 1024;

/** Every rule that recognises this failure and has a fix for it, in knowledge-base order. */
export function matchRepairs(phase: RepairPhase, command: string, output: string, plan: Plan, rules: RepairRule[] = REPAIR_RULES): RepairMatch[] {
  const out = output.length > TAIL ? output.slice(-TAIL) : output;
  const matches: RepairMatch[] = [];
  for (const rule of rules) {
    if (rule.phase !== "any" && rule.phase !== phase) continue;
    const captures = rule.match(command, out);
    if (!captures) continue;
    const fix = rule.fix(captures, plan);
    if (!fix) continue;
    const rewrite = REWRITES[rule.id];
    if (rewrite) fix.retry = rewrite(command);
    else if (fix.retry === "") delete fix.retry;
    matches.push({ rule, fix });
  }
  return matches;
}
