import { describe, expect, it } from "vitest";
import { emptyProjectSummary, nothingToRun } from "../../src/pipeline/empty";

// Where the line sits between "nothing to run" (no install) and "may run" (the normal setup). Anything not
// known to be documentation or housekeeping is on the "may run" side.
describe("nothingToRun", () => {
  it.each<[string, string[], string | null]>([
    // Nothing to run.
    ["an empty repository", [], "no files yet"],
    ["only a README", ["README.md"], "only a README so far"],
    ["a README without an extension", ["README"], "only a README so far"],
    ["only git settings", [".gitignore", ".gitattributes"], "no files yet besides git settings"],
    ["a README and a placeholder", ["README.md", "src/.gitkeep"], "only a README so far"],
    ["a README, licence and git settings", ["README.md", "LICENSE", ".gitignore", ".editorconfig"], "only documentation so far"],
    ["community files", ["README.rst", "CHANGELOG.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "AUTHORS"], "only documentation so far"],
    ["split licences", ["README.md", "LICENSE-MIT", "LICENSE-APACHE", "COPYING.txt"], "only documentation so far"],
    ["docs and README images", ["README.md", "docs/guide.md", "docs/notes.txt", "assets/logo.png", "screenshot.jpg", "diagram.svg"], "only documentation so far"],
    ["GitHub templates and sponsor button", ["README.md", ".github/ISSUE_TEMPLATE/bug.md", ".github/FUNDING.yml", ".github/CODEOWNERS"], "only documentation so far"],
    // May run.
    ["a source file", ["README.md", "main.py"], null],
    ["a source file in another language", ["README.md", "src/lib.rs"], null],
    ["a C file", ["main.c"], null],
    ["a manifest", ["README.md", "package.json"], null],
    ["a Python requirements file", ["README.md", "requirements.txt"], null],
    ["a CMake build", ["README.md", "CMakeLists.txt"], null],
    ["a Dockerfile", ["README.md", "Dockerfile"], null],
    ["a compose file", ["README.md", "compose.yaml"], null],
    ["a Makefile", ["README.md", "Makefile"], null],
    ["a notebook", ["README.md", "analysis.ipynb"], null],
    ["an HTML page", ["README.md", "index.html"], null],
    ["a shell script", ["README.md", "install.sh"], null],
    ["an MDX page", ["README.md", "docs/intro.mdx"], null],
    ["a Jekyll config", ["README.md", "index.md", "_config.yml"], null],
    ["a CI workflow", ["README.md", ".github/workflows/ci.yml"], null],
    ["a Pyrovue config", ["README.md", "pyrovue.json"], null],
    ["a file named like a doc but with a code extension", ["README.md", "license.js"], null],
    ["a licence-named script", ["README.md", "license-check.sh"], null],
    ["a text file outside docs", ["README.md", "data.txt"], null],
  ])("%s", (_label, files, found) => {
    expect(nothingToRun(files)?.found ?? null).toBe(found);
  });

  it("says plainly what was found in the box's summary", () => {
    expect(emptyProjectSummary(nothingToRun(["README.md"])!)).toBe("An empty project: only a README so far. Nothing was installed or started.");
  });
});
