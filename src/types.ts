/** The steps of a run, in order. */
export type StepId = "provision" | "clone" | "analyze" | "install" | "launch" | "tour";
export type StepState = "pending" | "active" | "done" | "failed" | "skipped";

/** What a repository turned out to be: a web app with a preview, a command-line project, or not known yet. */
export type AppKind = "web" | "cli" | "unknown";

/** A file of environment variables the app wants before it runs, and the keys the repo's example names. */
export interface EnvNeed {
  file: string;
  keys: string[];
  /** Which of `keys` have been filled in since the run started (names only, never values). */
  added?: string[];
}
