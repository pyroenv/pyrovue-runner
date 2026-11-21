import type { RepoEvidence } from "../evidence";
import type { Plan } from "../plan";
import type { Snapshot } from "../snapshot";

/**
 * A language other than JavaScript that can own a repository's root. detect.ts asks each one whether the root marks
 * a project in it, counts the source files written in it to settle a root that marks several, and has the owner plan
 * the project from its own conventions.
 */
export interface RootLanguage {
  /** The root holds this language's manifest (go.mod, pom.xml, a solution file). */
  marks: (files: Set<string>) => boolean;
  /** Source files written in it. */
  source: RegExp;
  /**
   * Keeps the root over a JavaScript app in a subfolder whatever the two hold (Python, which always has: a library's
   * frontend folder is part of the library). The others take the root from such an app only under detect.ts's rules.
   */
  keepsRootOverSubfolderApp?: boolean;
  /** The plan its conventions give for the project at the root. Only called when `marks` is true. */
  detect: (snapshot: Snapshot, files: Set<string>, ev: RepoEvidence) => Plan;
}
