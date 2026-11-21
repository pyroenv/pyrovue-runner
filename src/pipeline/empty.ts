import type { StepId } from "../types";

/**
 * Whether a repository has anything to run, decided from its file list alone, before any install or model call.
 *
 * A brand new project (no commits, or a README with only a title) has nothing to install or start, and trying would
 * only end in a failed run. This check stops those repositories early. It is deliberately narrow: a file it does not
 * know is treated as something that may run, so only repositories made of documentation and housekeeping stop here.
 */

/** Documentation and community files, by name, with or without a text extension (README, README.md, LICENSE.txt). */
const DOC_NAME =
  /^(readme|license|licence|copying|copyright|notice|authors|contributors|maintainers|changelog|changes|history|news|contributing|code_of_conduct|code-of-conduct|security|support|governance|funding|codeowners|todo|notes)(\.(md|markdown|rst|txt|adoc|asciidoc|org))?$/i;

/** A licence split by kind, as Rust and dual-licensed projects do: LICENSE-MIT, LICENSE-APACHE, LICENSE_APACHE-2.0.txt. */
const LICENSE_KIND = /^(LICEN[CS]E|COPYING)[-_][A-Z0-9-]+(\.\d+)*(\.(md|txt))?$/;

/** Prose anywhere in the tree. Plain .txt is not here: requirements.txt and CMakeLists.txt are build files. */
const PROSE = /\.(md|markdown|rst|adoc|asciidoc)$/i;

/** Plain text that is only prose: a .txt under a docs folder. */
const DOCS_TEXT = /(^|\/)docs?\/.*\.txt$/i;

/** Images a README shows. */
const IMAGE = /\.(png|jpe?g|gif|svg|webp|avif|ico|bmp)$/i;

/** Git and editor housekeeping, and the empty placeholder files that keep a folder in git. */
const HOUSEKEEPING = /^(\.gitignore|\.gitattributes|\.editorconfig|\.mailmap|\.gitkeep|\.keep|\.DS_Store)$/i;

/** GitHub's own community files: issue and pull request templates and the sponsor button. Workflows are not here. */
const GITHUB_META = /^\.github\/(.*\.(md|markdown)|FUNDING\.ya?ml|CODEOWNERS)$/i;

/** A file that holds only documentation or housekeeping, nothing that installs, builds or runs. */
export function isDocOrHousekeeping(path: string): boolean {
  const base = path.split("/").pop() ?? path;
  // .mdx is a page component (Docusaurus, Next), not prose.
  if (/\.mdx$/i.test(base)) return false;
  return DOC_NAME.test(base) || LICENSE_KIND.test(base) || PROSE.test(base) || DOCS_TEXT.test(path) || IMAGE.test(base) || HOUSEKEEPING.test(base) || GITHUB_META.test(path);
}

export interface NothingToRun {
  /** What the repository holds, for the box's summary: "only a README so far". */
  found: string;
}

/**
 * Null when the repository may have something to run (the normal setup goes ahead), or what it holds when it is empty
 * or only documentation and housekeeping. `files` is the snapshot's file list: the paths git tracks, plus untracked
 * ones that are not ignored.
 */
export function nothingToRun(files: readonly string[]): NothingToRun | null {
  if (files.length === 0) return { found: "no files yet" };
  if (!files.every(isDocOrHousekeeping)) return null;
  const docs = files.filter((f) => !HOUSEKEEPING.test(f.split("/").pop() ?? f));
  if (docs.length === 0) return { found: "no files yet besides git settings" };
  if (docs.length === 1 && /^readme/i.test(docs[0]!.split("/").pop() ?? "")) return { found: "only a README so far" };
  return { found: "only documentation so far" };
}

/** The box's summary, which the setup log repeats. */
export function emptyProjectSummary(found: NothingToRun): string {
  return `An empty project: ${found.found}. Nothing was installed or started.`;
}

/**
 * The steps an empty project's setup does not do. It is cloned and looked at, so those two are done; the rest are
 * skipped the way a sandbox's are, never pending or failed.
 */
export const EMPTY_SKIPPED_STEPS: readonly StepId[] = ["install", "launch", "tour"];
