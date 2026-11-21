/** A repository the runner was asked to run: where to clone it from and what to call it. */
export interface RepoTarget {
  /** An https URL git can clone. */
  url: string;
  /** "owner/name" for GitHub and GitLab, the host and path for anything else. */
  label: string;
  /** A branch or tag, when one was asked for. */
  branch: string | null;
}

/** A public hostname: dot-separated labels ending in a top-level domain (github.com, git.example.org). */
const HOSTNAME = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const SHORTHAND = /^([A-Za-z0-9](?:[A-Za-z0-9-]{0,38}))\/([A-Za-z0-9._-]{1,100})$/;

/**
 * Reads what someone typed: a GitHub or GitLab link (a branch from /tree/<branch> is kept), `owner/repo` for GitHub,
 * an SSH address (turned into https, so no key is needed for a public repo), or any other https git URL.
 * Returns null for anything else, local paths and file:// URLs included: the runner only clones over https.
 */
export function parseRepo(input: string, branch: string | null = null): RepoTarget | null {
  const raw = input.trim();
  // No spaces, no local paths, and no . or .. segments (a URL parser would quietly resolve them to another repo).
  if (!raw || /\s/.test(raw) || /^[./~\\]/.test(raw) || /(^|\/)\.\.?(\/|$)/.test(raw)) return null;

  // owner/repo: the owner part of a GitHub name has no dot, which tells it apart from host/path.
  if (SHORTHAND.test(raw)) return fromPath("github.com", raw, branch);

  const ssh = /^git@([A-Za-z0-9.-]+):(.+)$/.exec(raw);
  if (ssh) return fromPath(ssh[1]!.toLowerCase(), ssh[2]!, branch);

  let url: URL;
  try {
    url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username || url.password) return null;
  return fromPath(url.hostname.toLowerCase(), url.pathname, branch);
}

function fromPath(host: string, pathname: string, branch: string | null): RepoTarget | null {
  if (!HOSTNAME.test(host)) return null;
  let parts = pathname.replace(/^\/+|\/+$/g, "").split("/").filter(Boolean);
  let ref = branch;
  if (host === "github.com" || host === "www.github.com") {
    if (parts.length < 2) return null;
    // github.com/owner/repo/tree/<branch>
    if (!ref && parts[2] === "tree" && parts.length > 3) ref = decodeURIComponent(parts.slice(3).join("/"));
    parts = parts.slice(0, 2);
    host = "github.com";
  } else if (host === "gitlab.com") {
    // gitlab.com/group/sub/project/-/tree/<branch>
    const dash = parts.indexOf("-");
    if (dash !== -1) {
      if (!ref && parts[dash + 1] === "tree" && parts.length > dash + 2) ref = decodeURIComponent(parts.slice(dash + 2).join("/"));
      parts = parts.slice(0, dash);
    }
    if (parts.length < 2) return null;
  } else if (parts.length < 1) {
    return null;
  }
  const last = parts.length - 1;
  parts[last] = parts[last]!.replace(/\.git$/, "");
  if (parts.some((p) => !/^[A-Za-z0-9._~-]+$/.test(p) || p === "." || p === "..")) return null;
  if (ref !== null && !/^[A-Za-z0-9._/@+-]{1,200}$/.test(ref)) return null;
  const path = parts.join("/");
  const label = host === "github.com" || host === "gitlab.com" ? path : `${host}/${path}`;
  return { url: `https://${host}/${path}.git`, label, branch: ref };
}
