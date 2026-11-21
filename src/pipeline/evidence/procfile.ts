import { redact, sanitizeCommand, splitChain } from "./shell";

/**
 * Procfiles (Heroku, foreman, Rails' Procfile.dev): `web:` is the server, `release:` runs before it, and in a
 * Procfile.dev the asset watchers (css, js) run next to the server.
 */

export interface ProcfileEvidence {
  file: string;
  processes: Record<string, string>;
  /** The web process, sanitised, or null when there's none or it can't run in a box. */
  web: string | null;
  /** Release-phase commands (usually migrations), run as setup. */
  release: string[];
  /** Asset watchers from a Procfile.dev, started in the background next to the web process. */
  watchers: string[];
  skipped: { command: string; reason: string }[];
}

export function parseProcfile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    const m = /^([A-Za-z0-9_-]+)\s*:(.*)$/.exec(line);
    const value = m?.[2]?.trim();
    if (m && value && !line.trimStart().startsWith("#")) out[m[1]!] = value;
  }
  return out;
}

const WATCHER = /^(css|js|assets?|tailwind|esbuild|vite|webpack|styles?|sass|postcss)$|watch/i;
const WORKER = /^(worker|jobs?|sidekiq|celery|beat|queue|scheduler|cron|clock)/i;

/** A whole command, or null when any part of it is unsafe or can't run in a box. */
function clean(command: string, files: Set<string>, skipped: ProcfileEvidence["skipped"]): string | null {
  const kept: string[] = [];
  for (const segment of splitChain(command)) {
    const s = sanitizeCommand(segment, { files });
    if (s.skip) {
      skipped.push({ command: redact(segment), reason: s.skip });
      return null;
    }
    if (s.command) kept.push(s.command);
  }
  return kept.length ? kept.join(" && ") : null;
}

export function procfileEvidence(text: string, opts: { files: Set<string>; file: string }): ProcfileEvidence {
  const processes = parseProcfile(text);
  const skipped: ProcfileEvidence["skipped"] = [];
  const webKey = processes.web ? "web" : Object.keys(processes).find((k) => /^(app|server|api|frontend|dev)$/i.test(k));
  const web = webKey ? clean(processes[webKey]!, opts.files, skipped) : null;
  const release = processes.release ? [clean(processes.release, opts.files, skipped)].filter((c): c is string => c !== null) : [];
  const watchers: string[] = [];
  if (/\.dev$/i.test(opts.file)) {
    for (const [name, command] of Object.entries(processes)) {
      if (name === webKey || name === "release" || WORKER.test(name) || !WATCHER.test(`${name} ${command}`)) continue;
      const c = clean(command, opts.files, skipped);
      if (c) watchers.push(c);
    }
  }
  return { file: opts.file, processes, web, release, watchers, skipped };
}
