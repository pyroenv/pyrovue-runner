/**
 * Stand-ins for the databases, caches and brokers a project expects to find next to it (usually from
 * docker-compose). There is no Docker inside a box, so each one is installed natively with apt and started in the
 * background, with connection settings that match what the project was told.
 */

export type ServiceKind = "postgres" | "mysql" | "redis" | "mongo" | "rabbitmq" | "memcached" | "elasticsearch";

export interface ServiceSettings {
  user?: string;
  password?: string;
  database?: string;
}

export interface ServiceShim {
  kind: ServiceKind;
  /** Debian packages to install. */
  packages: string[];
  /** Commands after the install that start the service and create the user and database. */
  init: string[];
  /** Starts it again (when a stopped box wakes up); prefixed to the app's start command. */
  start: string;
  env: Record<string, string>;
  note: string;
}

const IMAGES: [RegExp, ServiceKind][] = [
  [/^(postgres|postgis|timescale(db)?(-ha)?|pgvector|supabase\/postgres|bitnami\/postgresql|ankane\/pgvector)$/, "postgres"],
  [/^(mysql|mariadb|percona|bitnami\/mysql|bitnami\/mariadb)$/, "mysql"],
  [/^(redis|valkey|keydb|redis-stack(-server)?|bitnami\/redis|eqalpha\/keydb|redis\/redis-stack(-server)?|valkey\/valkey)$/, "redis"],
  [/^(mongo|mongodb|bitnami\/mongodb|mongodb\/mongodb-community-server)$/, "mongo"],
  [/^(rabbitmq|bitnami\/rabbitmq)$/, "rabbitmq"],
  [/^(memcached|bitnami\/memcached)$/, "memcached"],
  [/^(elasticsearch|opensearch|opensearchproject\/opensearch|elastic\/elasticsearch|docker\.elastic\.co\/elasticsearch\/elasticsearch)$/, "elasticsearch"],
];

/** What kind of service a compose image is, judged by its repository name (registry and tag ignored). */
export function serviceKind(image: string | null | undefined): ServiceKind | null {
  if (!image) return null;
  const repo = image
    .toLowerCase()
    .replace(/@sha256:.*$/, "")
    .replace(/:[^/]*$/, "")
    .replace(/^(docker\.io|ghcr\.io|quay\.io|public\.ecr\.aws|mcr\.microsoft\.com)\//, "")
    .replace(/^library\//, "");
  for (const [re, kind] of IMAGES) if (re.test(repo) || re.test(repo.split("/").pop()!)) return kind;
  return null;
}

/** The default port each kind of service listens on, so the app's port is never mistaken for one. */
export const SERVICE_DEFAULT_PORT: Record<ServiceKind, number> = {
  postgres: 5432,
  mysql: 3306,
  redis: 6379,
  mongo: 27017,
  rabbitmq: 5672,
  memcached: 11211,
  elasticsearch: 9200,
};

const SAFE = /^[A-Za-z0-9_.-]{1,63}$/;
const safe = (v: string | undefined, fallback: string, re = SAFE) => (v && re.test(v) ? v : fallback);

export function shimFor(kind: ServiceKind, settings: ServiceSettings = {}): ServiceShim | null {
  switch (kind) {
    case "postgres": {
      const user = safe(settings.user, "postgres");
      const password = safe(settings.password, "postgres");
      const database = safe(settings.database, user === "postgres" ? "app" : user);
      const role =
        user === "postgres"
          ? `runuser -u postgres -- psql -q -c "ALTER USER postgres PASSWORD '${password}'"`
          : `runuser -u postgres -- psql -q -c "CREATE ROLE \\"${user}\\" WITH LOGIN SUPERUSER PASSWORD '${password}'" || true`;
      return {
        kind,
        packages: ["postgresql"],
        init: ["service postgresql start", role, `runuser -u postgres -- createdb -O "${user}" "${database}" || true`],
        start: "service postgresql start >/dev/null 2>&1 || true",
        env: { DATABASE_URL: `postgresql://${user}:${password}@localhost:5432/${database}` },
        note: `PostgreSQL runs inside the box (user ${user}, database ${database}).`,
      };
    }
    case "mysql": {
      const user = safe(settings.user, "root");
      const password = safe(settings.password, "root");
      const database = safe(settings.database, "app", /^\w{1,63}$/);
      const grants =
        user === "root"
          ? `ALTER USER 'root'@'localhost' IDENTIFIED VIA mysql_native_password USING PASSWORD('${password}') OR unix_socket;`
          : `CREATE USER IF NOT EXISTS '${user}'@'localhost' IDENTIFIED BY '${password}'; CREATE USER IF NOT EXISTS '${user}'@'%' IDENTIFIED BY '${password}'; GRANT ALL PRIVILEGES ON *.* TO '${user}'@'localhost'; GRANT ALL PRIVILEGES ON *.* TO '${user}'@'%';`;
      return {
        kind,
        packages: ["mariadb-server"],
        init: ["service mariadb start", `mysql -uroot -e "CREATE DATABASE IF NOT EXISTS ${database}; ${grants} FLUSH PRIVILEGES;" || true`],
        start: "service mariadb start >/dev/null 2>&1 || true",
        env: { DATABASE_URL: `mysql://${user}:${password}@127.0.0.1:3306/${database}` },
        note: `MariaDB stands in for MySQL inside the box (user ${user}, database ${database}).`,
      };
    }
    case "redis":
      return {
        kind,
        packages: ["redis-server"],
        init: ["redis-server --daemonize yes"],
        start: "redis-server --daemonize yes >/dev/null 2>&1 || true",
        env: { REDIS_URL: "redis://localhost:6379" },
        note: "Redis runs inside the box.",
      };
    case "memcached":
      return {
        kind,
        packages: ["memcached"],
        init: ["memcached -d -u memcache -l 127.0.0.1"],
        start: "memcached -d -u memcache -l 127.0.0.1 >/dev/null 2>&1 || true",
        env: { MEMCACHE_SERVERS: "localhost:11211" },
        note: "Memcached runs inside the box.",
      };
    case "rabbitmq":
      return {
        kind,
        packages: ["rabbitmq-server"],
        init: ["service rabbitmq-server start"],
        start: "service rabbitmq-server start >/dev/null 2>&1 || true",
        env: { RABBITMQ_URL: "amqp://guest:guest@localhost:5672/", AMQP_URL: "amqp://guest:guest@localhost:5672/" },
        note: "RabbitMQ runs inside the box.",
      };
    default:
      return null;
  }
}

/** Why a service can't run in the box, in the product's words. */
export function cannotShim(kind: ServiceKind | null, name: string): string {
  if (kind === "mongo") return `MongoDB (${name}) isn't packaged for Debian, so it isn't running in the box. Features that need it may fail.`;
  if (kind === "elasticsearch") return `Elasticsearch (${name}) is too heavy to run in the box, so it isn't running. Search features may fail.`;
  return `The ${name} service from docker-compose isn't running in the box.`;
}

export interface ShimSet {
  setup: string[];
  /** Prefix for the start command that brings the services back after a restart. */
  prelude: string | null;
  env: Record<string, string>;
  notes: string[];
}

/** Installs every shim with one apt transaction. */
export function combineShims(shims: ServiceShim[]): ShimSet {
  if (!shims.length) return { setup: [], prelude: null, env: {}, notes: [] };
  const packages = [...new Set(shims.flatMap((s) => s.packages))];
  return {
    setup: [`apt-get update -qq && apt-get install -y --no-install-recommends ${packages.join(" ")}`, ...shims.flatMap((s) => s.init)],
    prelude: shims.map((s) => s.start).join("; "),
    env: Object.assign({}, ...shims.map((s) => s.env)) as Record<string, string>,
    notes: shims.map((s) => s.note),
  };
}

/** Reads user, password and database from a connection URL such as postgres://u:p@db:5432/name. */
export function settingsFromUrl(url: string): { kind: ServiceKind | null; host: string; settings: ServiceSettings } | null {
  const m = /^([a-z][\w+.-]*):\/\/(?:([^:@/]*)(?::([^@/]*))?@)?([^:/?#]+)(?::(\d+))?(?:\/([^?#]*))?/i.exec(url.trim());
  if (!m) return null;
  const scheme = m[1]!.toLowerCase().split("+")[0]!;
  const kind: ServiceKind | null = /^postgres(ql)?$/.test(scheme)
    ? "postgres"
    : /^(mysql|mariadb|mysql2)$/.test(scheme)
      ? "mysql"
      : /^rediss?$/.test(scheme)
        ? "redis"
        : /^mongodb(\+srv)?$/.test(scheme) || scheme === "mongodb"
          ? "mongo"
          : /^amqps?$/.test(scheme)
            ? "rabbitmq"
            : null;
  const decode = (s: string | undefined) => {
    if (!s) return undefined;
    try {
      return decodeURIComponent(s);
    } catch {
      return s;
    }
  };
  return { kind, host: m[4]!.toLowerCase(), settings: { user: decode(m[2]), password: decode(m[3]), database: decode(m[6])?.split("/")[0] || undefined } };
}
