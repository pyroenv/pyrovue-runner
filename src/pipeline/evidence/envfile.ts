import { randomBytes } from "node:crypto";
import { type ServiceKind, settingsFromUrl } from "../services";
import { isSecretName } from "../../security/redact";
import { isPlaceholder, SECRET_NAME } from "./shell";

/**
 * A committed env template (.env.example and friends) lists what the app reads at startup. Pyrovue copies it to the
 * file the app loads (never overwriting one), fills what it safely can — app secrets, the port, a local database —
 * and tells the user which third-party keys are still theirs to add.
 */

export interface EnvTemplate {
  file: string;
  /** Where the app expects its env file, next to the template. */
  target: string;
  values: Record<string, string>;
}

export interface EnvFileEvidence {
  template: EnvTemplate;
  /** Copies the template to the file the app loads unless it already exists; runs from the repo root. */
  copy: string;
  /** Values Pyrovue sets because the template's are placeholders. */
  fill: Record<string, string>;
  /** Keys the user has to provide (third-party credentials). */
  needs: string[];
  /** Services the template's URLs point at (postgres://…, redis://…). */
  services: ServiceKind[];
}

const TEMPLATES = /^(.*\/)?(\.env\.(example|sample|template|dist|defaults|local\.example|development\.example|dev\.example)|env\.example|example\.env|\.env-example|\.env_example|\.env\.local\.sample)$/;

export function isEnvTemplate(file: string): boolean {
  return TEMPLATES.test(file);
}

export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=\s*(.*)$/.exec(raw);
    if (!m) continue;
    let v = m[2]!.trim();
    if (/^["']/.test(v)) {
      const q = v[0]!;
      const end = v.indexOf(q, 1);
      v = end > 0 ? v.slice(1, end) : v.slice(1);
    } else v = v.replace(/\s#.*$/, "").trimEnd();
    out[m[1]!] = v;
  }
  return out;
}

/** The file the app reads: `.env.local.example` → `.env.local`, everything else → `.env`. */
function targetOf(file: string): string {
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/") + 1) : "";
  const base = file.slice(dir.length);
  if (/^\.env\.local\.(example|sample)$/.test(base)) return `${dir}.env.local`;
  if (/^\.env\.(development|dev)\.example$/.test(base)) return `${dir}.env.development`;
  return `${dir}.env`;
}

/** App-owned secrets Pyrovue may invent; anything else secret-looking belongs to a third party. */
const APP_SECRET = /^(SECRET_KEY|DJANGO_SECRET_KEY|FLASK_SECRET_KEY|APP_SECRET(_KEY)?|SECRET|SESSION_SECRET|SESSION_KEY|COOKIE_SECRET|JWT_SECRET(_KEY)?|JWT_KEY|JWT_REFRESH_SECRET|ACCESS_TOKEN_SECRET|REFRESH_TOKEN_SECRET|TOKEN_SECRET|NEXTAUTH_SECRET|AUTH_SECRET|BETTER_AUTH_SECRET|SECRET_KEY_BASE|APP_KEY|ENCRYPTION_KEY|ENCRYPTION_SECRET|SIGNING_SECRET|HASH_SECRET|CSRF_SECRET|PAYLOAD_SECRET|STRAPI_\w*SECRET|ADMIN_JWT_SECRET|API_TOKEN_SALT|TRANSFER_TOKEN_SALT|APP_KEYS|ENCRYPTION_SALT|SALT|PEPPER)$/;

/** Is this setting an app-owned secret Pyrovue may invent (rather than a third party's key)? */
export function isAppSecret(name: string): boolean {
  return APP_SECRET.test(name);
}

/** Settings an app keeps its own secrets in: what redaction calls a secret, plus salts, peppers and key lists. */
const SECRET_SETTING = /SECRET|SALT|PEPPER|SIGNING|ENCRYPTION|SESSION|COOKIE|(^|_)KEYS$/;

/**
 * Could this setting hold a secret the app generated? A recorded setup can be replayed elsewhere, so a value under
 * such a name that looksGenerated is rolled afresh on every replay rather than carried.
 */
export function isSecretSetting(name: string): boolean {
  return isAppSecret(name) || isSecretName(name) || SECRET_SETTING.test(name);
}

/**
 * Does a value look generated rather than chosen: lowercase hex, or base64 (Laravel's `base64:` form and
 * comma-separated key lists too) that looks random rather than like a word?
 */
export function looksGenerated(value: string): boolean {
  if (/^[0-9a-f]{32,}$/.test(value)) return true;
  const parts = value.replace(/^base64:/, "").split(",");
  return parts.every((part) => /^[A-Za-z0-9+/]{22,}={0,2}$/.test(part) && (/[+/=]/.test(part) || (/\d/.test(part) && /[a-z]/.test(part) && /[A-Z]/.test(part))));
}

/** A fresh secret in the shape the framework expects. */
export function secretFor(name: string): string {
  if (name === "APP_KEY") return `base64:${randomBytes(32).toString("base64")}`;
  if (name === "SECRET_KEY_BASE") return randomBytes(64).toString("hex");
  if (name === "APP_KEYS") return [1, 2, 3, 4].map(() => randomBytes(16).toString("base64")).join(",");
  return randomBytes(32).toString("hex");
}

const DATABASE_KEYS = /^(DATABASE_URL|DB_URL|POSTGRES_URL|POSTGRES_PRISMA_URL|POSTGRES_URL_NON_POOLING|DIRECT_URL|PG_URL|MYSQL_URL|SQLALCHEMY_DATABASE_URI)$/;
const REDIS_KEYS = /^(REDIS_URL|REDIS_URI|CACHE_URL|CELERY_BROKER_URL|BROKER_URL|REDIS_TLS_URL)$/;

export interface EnvFillOptions {
  port: number | null;
  /** Connection URLs for services Pyrovue runs in the box. */
  serviceEnv?: Record<string, string>;
  /** A DATABASE_URL the project's ORM accepts when no database server is available. */
  sqliteUrl?: string | null;
}

/** Fills the placeholders a template leaves, and lists what only the user can provide. */
export function envFileEvidence(template: EnvTemplate, opts: EnvFillOptions): EnvFileEvidence {
  const fill: Record<string, string> = {};
  const needs: string[] = [];
  const services: ServiceKind[] = [];
  const db = opts.serviceEnv?.DATABASE_URL;
  for (const [k, v] of Object.entries(template.values)) {
    const placeholder = isPlaceholder(v) || /<[^>]+>|\{\{|\byour[-_]|changeme/i.test(v);
    if (/:\/\//.test(v)) {
      const parsed = settingsFromUrl(v);
      if (parsed?.kind && !services.includes(parsed.kind)) services.push(parsed.kind);
    }
    if (k === "PORT") {
      if (opts.port) fill[k] = String(opts.port);
      continue;
    }
    if (APP_SECRET.test(k)) {
      if (placeholder || v.length < 16) fill[k] = secretFor(k);
      continue;
    }
    if (DATABASE_KEYS.test(k)) {
      const parsed = settingsFromUrl(v);
      const local = parsed && /^(localhost|127\.0\.0\.1)$/.test(parsed.host);
      if (db && (placeholder || !local)) fill[k] = db;
      else if (!db && placeholder && opts.sqliteUrl) fill[k] = opts.sqliteUrl;
      continue;
    }
    if (REDIS_KEYS.test(k) && opts.serviceEnv?.REDIS_URL) {
      const parsed = settingsFromUrl(v);
      if (placeholder || !parsed || !/^(localhost|127\.0\.0\.1)$/.test(parsed.host)) fill[k] = opts.serviceEnv.REDIS_URL;
      continue;
    }
    if (SECRET_NAME.test(k) && placeholder && !/^(DB_|DATABASE_|POSTGRES_|MYSQL_|REDIS_|MONGO)/.test(k)) needs.push(k);
  }
  // Absolute paths, because setup runs in the plan's cwd. (`cp -n` exits non-zero on some coreutils when the target
  // exists; this form never does.)
  const copy = `test -f /workspace/${template.target} || cp /workspace/${template.file} /workspace/${template.target}`;
  return { template, copy, fill, needs, services };
}

export function readEnvTemplate(file: string, text: string): EnvTemplate {
  return { file, target: targetOf(file), values: parseEnvFile(text) };
}
