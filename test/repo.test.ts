import { describe, expect, it } from "vitest";
import { parseRepo } from "../src/repo";
import { cloneFailure, cloneScript } from "../src/run";

describe("parseRepo", () => {
  it("reads owner/repo as a GitHub repository", () => {
    expect(parseRepo("vercel/next.js")).toEqual({ url: "https://github.com/vercel/next.js.git", label: "vercel/next.js", branch: null });
  });

  it("reads GitHub links, with and without https and .git", () => {
    for (const input of ["https://github.com/owner/repo", "github.com/owner/repo", "https://github.com/owner/repo.git", "https://www.github.com/owner/repo/"]) {
      expect(parseRepo(input)?.url).toBe("https://github.com/owner/repo.git");
    }
  });

  it("keeps the branch from a /tree/ link, and --branch wins over it", () => {
    expect(parseRepo("https://github.com/owner/repo/tree/feature/login")?.branch).toBe("feature/login");
    expect(parseRepo("https://github.com/owner/repo/tree/main", "dev")?.branch).toBe("dev");
  });

  it("reads GitLab links with subgroups and a branch", () => {
    expect(parseRepo("https://gitlab.com/group/sub/project/-/tree/main")).toEqual({
      url: "https://gitlab.com/group/sub/project.git",
      label: "group/sub/project",
      branch: "main",
    });
  });

  it("turns an SSH address into https", () => {
    expect(parseRepo("git@github.com:owner/repo.git")?.url).toBe("https://github.com/owner/repo.git");
  });

  it("takes any other https git host", () => {
    expect(parseRepo("https://codeberg.org/owner/repo")).toEqual({ url: "https://codeberg.org/owner/repo.git", label: "codeberg.org/owner/repo", branch: null });
  });

  it("refuses local paths, other protocols, credentials and odd names", () => {
    for (const input of ["", "./repo", "/home/me/repo", "file:///etc", "ftp://example.com/repo", "https://user:pw@github.com/o/r", "github.com/owner", "owner/repo name", "https://github.com/o/r/../x", "https://github.com/o/r --upload-pack=x"]) {
      expect(parseRepo(input)).toBeNull();
    }
  });

  it("refuses a branch that could be read as an option", () => {
    expect(parseRepo("owner/repo", "main; rm -rf /")).toBeNull();
  });
});

describe("cloneScript", () => {
  it("makes a shallow clone with submodules, quoting the URL and branch", () => {
    const target = parseRepo("owner/repo", "dev")!;
    expect(cloneScript(target)).toBe("git clone --depth 1 --branch 'dev' --recurse-submodules --shallow-submodules 'https://github.com/owner/repo.git' /workspace");
  });

  it("explains a private or missing repository plainly", () => {
    const target = parseRepo("owner/repo")!;
    expect(cloneFailure(target, "remote: Repository not found.")).toMatch(/doesn't exist or isn't public/);
  });
});
