/**
 * Whether an environment variable name holds a credential (API_KEY, DB_PASSWORD, STRIPE_SECRET…), so the runner
 * can generate a fresh value instead of copying a placeholder, and never prints one.
 */

/** Words a name ends with when its value is a credential. */
const SECRET_WORDS = new Set(["secret", "password", "passwd", "passphrase", "token", "apikey", "credential", "credentials", "privatekey"]);
/** "<qualifier>_key" is a credential (api_key, secret_key, private_key…); a bare "key" usually isn't. */
const KEY_QUALIFIERS = new Set([
  "api", "secret", "private", "access", "auth", "encryption", "signing", "master", "client", "app", "license", "service",
  "webhook", "session", "jwt", "hmac", "admin", "account", "consumer", "subscription",
]);
const NOT_SECRET_KEYS = new Set(["primary", "sort", "partition", "cache", "foreign", "public", "publishable", "unique", "idempotency"]);

export function isSecretName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[_.-]+/)
    .filter(Boolean);
  const last = words.at(-1);
  const prev = words.at(-2);
  if (!last) return false;
  if (SECRET_WORDS.has(last)) return true;
  // PWD and pass alone are the working directory and test-runner output; DB_PWD and SMTP_PASS are passwords.
  if ((last === "pwd" || last === "pass") && words.length > 1) return true;
  if (last === "auth" && prev !== undefined && ["basic", "http", "proxy"].includes(prev)) return true;
  if (last === "key" && prev !== undefined) {
    if (KEY_QUALIFIERS.has(prev)) return true;
    // Environment-style names (STRIPE_KEY, MAPBOX_KEY) are almost always credentials.
    if (/^[A-Z0-9_]+$/.test(name) && !NOT_SECRET_KEYS.has(prev)) return true;
  }
  // SECRET_KEY_BASE, PASSWORD_HASH, TOKEN_VALUE…
  if (["base", "value", "hash", "key"].includes(last) && words.some((w) => SECRET_WORDS.has(w))) return true;
  return false;
}
