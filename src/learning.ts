import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

export interface LearningStat {
  key: string;
  successes: number;
  failures: number;
}

interface Stored {
  version: 1;
  stats: Record<string, Record<string, { successes: number; failures: number }>>;
  seen: Record<string, true>;
}

/**
 * What the runner has learned from past runs on this machine, without any model: how often each setup strategy or
 * repair rule worked for a kind of project. `scope` names the table ("strategy:node:vite:pnpm"), `key` the thing
 * that was tried. Kept as one small JSON file, by default in ~/.cache/pyrovue-runner/learning.json.
 */
export class LearningRepo {
  private data: Stored;

  constructor(private readonly file: string | null = defaultLearningFile()) {
    this.data = { version: 1, stats: {}, seen: {} };
    if (!file) return;
    try {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<Stored>;
      if (parsed.version === 1 && parsed.stats && parsed.seen) this.data = parsed as Stored;
    } catch {
      // No file yet, or one this version can't read: start fresh.
    }
  }

  /** With a `subject` (a repo and commit), only that subject's first outcome for this scope and key counts. */
  record(scope: string, key: string, ok: boolean, subject?: string): void {
    if (subject !== undefined) {
      const id = `${scope}\u0000${key}\u0000${subject}`;
      if (this.data.seen[id]) return;
      this.data.seen[id] = true;
    }
    const table = (this.data.stats[scope] ??= {});
    const row = (table[key] ??= { successes: 0, failures: 0 });
    if (ok) row.successes++;
    else row.failures++;
    this.save();
  }

  stats(scope: string): LearningStat[] {
    return Object.entries(this.data.stats[scope] ?? {}).map(([key, row]) => ({ key, ...row }));
  }

  private save(): void {
    if (!this.file) return;
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.file);
    } catch {
      // Learning is a bonus: a read-only home directory must never fail a run.
    }
  }
}

export function defaultLearningFile(): string {
  const base = process.env.XDG_CACHE_HOME || path.join(homedir(), ".cache");
  return path.join(base, "pyrovue-runner", "learning.json");
}
