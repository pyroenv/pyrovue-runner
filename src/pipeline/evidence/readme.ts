import { classifyCommand, type CommandKind, headWord, redact, sanitizeCommand, splitChain, type Tool } from "./shell";

/**
 * Mining a README (or CONTRIBUTING/DEVELOPMENT guide) for the commands a person would type to run the project:
 * shell blocks under headings like "Getting started" or "Development", plus inline `npm run dev` spans.
 */

export interface MinedCommand {
  command: string;
  kind: CommandKind;
  /** Directory the command runs in, relative to the repo root. */
  dir: string;
  /** The heading it was found under ("" before the first heading). */
  section: string;
  /** How much that section looks like run instructions, 0-1. */
  weight: number;
  /** Found in an inline code span rather than a code block. */
  inline?: boolean;
}

export interface ReadmeEvidence {
  commands: MinedCommand[];
  /** Ports from `localhost:NNNN` mentions, most relevant first (database ports excluded). */
  ports: number[];
  env: Record<string, string>;
  versions: { tool: Tool; version: string }[];
  /** Commands that were left out on purpose, and why (for the agent and the logs). */
  skipped: { command: string; reason: string }[];
  usesDocker: boolean;
  /** The README installs the published package (`pip install requests`): a hint the repo is a library. */
  installsPublished: boolean;
}

export interface ReadmeOptions {
  files: Set<string>;
  /** The repository's own name, so `cd repo-name` after a clone is understood. */
  repoName?: string;
  /** Names the project publishes under (package.json / pyproject names). */
  packageNames?: string[];
}

/** Ports that belong to databases and brokers, never the app. */
export const SERVICE_PORTS = new Set([5432, 3306, 6379, 27017, 11211, 5672, 15672, 9200, 9300, 2181, 9092, 1025, 8025, 9000, 9001]);

const STRONG = /\b(quick\s*-?\s*start|getting\s+started|get\s+started|run(ning)?\s+(it\s+|the\s+\w+\s+)?locally|local(ly)?\s+(development|setup|dev|install)|development\s+(setup|server|environment|mode)|dev\s+(setup|server|environment)|how\s+to\s+(run|start|use|install|build)|run(ning)?\s+the\s+(app|application|project|server|site|demo|code)|setup|set\s*-?up|installation|installing|install|development|developing|develop|build\s+(&|and)\s+run|run|running|start(ing)?(\s+the\s+\w+)?|launch(ing)?|serve|hacking)\b/i;
const CORE = /\b(quick\s*-?\s*start|getting\s+started|get\s+started|local(ly)?|development|develop(ing)?|set\s*-?up|install(ation|ing)?)\b/i;
const MEDIUM = /\b(usage|build(ing)?|requirements|prerequisites|dependencies|configuration|configure|environment|database|contribut(e|ing)|demo|example|try\s+it|local)\b/i;
const HARD_NEGATIVE = /\b(deploy(ment|ing)?|production|docker|compose|kubernetes|k8s|helm|heroku|vercel|netlify|cloud|aws|gcp|azure|windows|homebrew|nix|vagrant)\b/i;
const SOFT_NEGATIVE =
  /\b(test(s|ing)?|lint(ing)?|licen[cs]e|faq|troubleshoot(ing)?|changelog|releases?|publish(ing)?|benchmarks?|credits?|acknowledg\w*|contributors|sponsors?|api\s+reference|roadmap|citation|star\s+history|upgrad(e|ing)|migrat(e|ing)\s+from)\b/i;

/** How much a heading looks like run instructions: 1, 0.6, 0 (never run anything from it) or null (no opinion). */
export function sectionWeight(heading: string): number | null {
  if (!heading) return null;
  if (HARD_NEGATIVE.test(heading) && !/\b(local(ly)?|without\s+docker|no\s+docker)\b/i.test(heading)) return 0;
  if (SOFT_NEGATIVE.test(heading) && !CORE.test(heading)) return 0;
  if (STRONG.test(heading)) return 1;
  if (MEDIUM.test(heading)) return 0.6;
  return null;
}

const SHELL_LANGS = new Set(["", "sh", "bash", "shell", "console", "zsh", "terminal", "shell-session", "shellsession", "sh-session", "fish", "text", "txt", "plaintext", "cli", "command", "commands", "bash-session", "shell script", "sh script"]);
const ENV_LANGS = new Set(["env", "dotenv", "ini", "properties", "conf"]);
const PROMPT = /^\s*(\$|%|❯|➜|>|λ)\s+/;

interface Block {
  lang: string;
  lines: string[];
  section: string;
  weight: number;
  /** A new section started since the previous block. */
  newSection: boolean;
}

interface Inline {
  text: string;
  section: string;
  weight: number;
}

/** Splits markdown (and the common reStructuredText forms) into code blocks and inline spans with their section. */
function scan(text: string): { blocks: Block[]; inline: Inline[] } {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  const inline: Inline[] = [];
  const stack: { level: number; title: string; weight: number | null }[] = [];
  let newSection = true;

  const current = () => {
    for (let i = stack.length - 1; i >= 0; i--) if (stack[i]!.weight !== null) return { title: stack.at(-1)!.title, weight: stack[i]!.weight! };
    return { title: stack.at(-1)?.title ?? "", weight: stack.length ? 0.35 : 0.5 };
  };
  const heading = (level: number, title: string) => {
    const clean = title.replace(/<[^>]+>/g, "").replace(/[`*_[\]()#:!]/g, " ").replace(/\s+/g, " ").trim();
    while (stack.length && stack.at(-1)!.level >= level) stack.pop();
    stack.push({ level, title: clean, weight: sectionWeight(clean) });
    newSection = true;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const fence = /^\s{0,3}(`{3,}|~{3,})\s*([\w+#.-]*)[^\n]*$/.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const body: string[] = [];
      for (i++; i < lines.length && !lines[i]!.trimStart().startsWith(marker); i++) body.push(lines[i]!);
      const { title, weight } = current();
      blocks.push({ lang: fence[2]!.toLowerCase(), lines: body, section: title, weight, newSection });
      newSection = false;
      continue;
    }
    // reStructuredText: ".. code-block:: bash" or a paragraph ending in "::", followed by an indented block.
    const rst = /^\s*\.\.\s+(?:code-block|code|sourcecode)::\s*(\S*)/.exec(line);
    if (rst || (/::\s*$/.test(line) && !/^\s*\.\./.test(line))) {
      const body: string[] = [];
      let j = i + 1;
      while (j < lines.length && (lines[j]!.trim() === "" || /^\s*:\w+:/.test(lines[j]!))) j++;
      while (j < lines.length && (lines[j]!.trim() === "" || /^\s{2,}/.test(lines[j]!))) body.push(lines[j++]!.trim());
      if (body.some(Boolean)) {
        const { title, weight } = current();
        blocks.push({ lang: (rst?.[1] ?? "").toLowerCase(), lines: body, section: title, weight, newSection });
        newSection = false;
        i = j - 1;
        continue;
      }
    }
    // heading() trims spaces and drops `#`s; doing it here backtracks badly on a long run of spaces.
    const atx = /^\s{0,3}(#{1,6})\s(.+)$/.exec(line);
    if (atx) {
      heading(atx[1]!.length, atx[2]!);
      continue;
    }
    const html = /^\s*<h([1-6])[^>]*>(.*?)<\/h\1>/i.exec(line);
    if (html) {
      heading(Number(html[1]), html[2]!);
      continue;
    }
    const next = lines[i + 1];
    if (next !== undefined && line.trim() && !/^\s*[-*+>|]/.test(line) && /^\s*(={3,}|-{3,}|~{3,}|\^{3,})\s*$/.test(next) && next.trim().length >= Math.min(line.trim().length, 3)) {
      heading(next.trim().startsWith("=") ? 1 : next.trim().startsWith("-") ? 2 : 3, line);
      i++;
      continue;
    }
    if (line.includes("`")) {
      const { title, weight } = current();
      for (const m of line.matchAll(/(?<!`)`([^`\n]{3,200})`(?!`)/g)) inline.push({ text: m[1]!, section: title, weight });
    }
  }
  return { blocks, inline };
}

/** Joins `\` continuations and trailing `&&`/`|` lines, drops comments, strips prompts and spots shell output. */
export function blockCommands(lines: string[]): string[] {
  const prompted = lines.some((l) => /^\s*(\$|%|❯|➜)\s+\S/.test(l));
  // With shell prompts, a line starting with ">" is output (npm prints "> app@1.0.0 start"), not a command.
  const prompt = prompted ? /^\s*(\$|%|❯|➜)\s+/ : PROMPT;
  const out: string[] = [];
  let pending = "";
  let heredoc: string | null = null;
  for (const raw of lines) {
    if (heredoc !== null) {
      if (raw.trim() === heredoc) heredoc = null;
      continue;
    }
    let line = raw.replace(/\t/g, " ");
    if (!pending) {
      if (prompted && !prompt.test(line)) continue;
      line = line.replace(prompt, "");
      // Comments, Windows prompts and REPL lines aren't commands.
      if (/^\s*(#|\/\/|REM\b|::|>>>|\.\.\.\s|In \[\d+\]|C:\\|PS [A-Z]:)/i.test(line)) continue;
    }
    line = stripComment(line).trimEnd();
    const delimiter = heredocDelimiter(line);
    if (delimiter) {
      heredoc = delimiter;
      pending = "";
      continue;
    }
    if (/\\$/.test(line)) {
      pending += `${line.slice(0, -1).trim()} `;
      continue;
    }
    if (/(&&|\|\||\|)\s*$/.test(line)) {
      pending += `${line.trim()} `;
      continue;
    }
    const full = (pending + line.trim()).trim();
    pending = "";
    if (full) out.push(full);
  }
  if (pending.trim()) out.push(pending.trim());
  return out;
}

/** The word a line's heredoc ends at (`cat <<EOF`), or null: a `<<` inside quotes, a `<<<` here-string and a shift by a number aren't one. */
function heredocDelimiter(line: string): string | null {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "<" && line[i + 1] === "<") {
      if (line[i + 2] === "<") {
        i += 2;
        continue;
      }
      const word = /^-?\s*['"]?([A-Za-z_]\w*)['"]?/.exec(line.slice(i + 2));
      if (word) return word[1]!;
      i++;
    }
  }
  return null;
}

function stripComment(line: string): string {
  let quote: string | null = null;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && i > 0 && /\s/.test(line[i - 1]!)) return line.slice(0, i);
  }
  return line;
}

function normName(s: string): string {
  return s.toLowerCase().replace(/[-_.]+/g, "-");
}

/** `pip install requests` in the requests repo installs the published package, not this checkout. */
function installsPublishedPackage(cmd: string, names: string[]): boolean {
  if (!names.length) return false;
  const m =
    /^(?:python3?\s+-m\s+)?(?:pip3?|uv\s+pip|pipx)\s+install\s+(?:-U\s+|--upgrade\s+|--user\s+)*["']?([A-Za-z0-9_.-]+)(?:\[[^\]]*\])?(?:[=<>~!]=?[^\s"']*)?["']?\s*$/.exec(cmd) ??
    /^(?:npm\s+(?:i|install)|yarn\s+add|pnpm\s+(?:add|i|install)|bun\s+add)\s+(?:-[gSD]\s+|--save(?:-dev)?\s+|--global\s+)*(@?[\w./-]+?)(?:@[\w.^~-]+)?\s*$/.exec(cmd) ??
    /^(?:gem\s+install|cargo\s+(?:install|add)|composer\s+require)\s+([\w./-]+)\s*$/.exec(cmd) ??
    /^go\s+(?:get|install)\s+(?:-u\s+)?([\w./-]+?)(?:@\S+)?\s*$/.exec(cmd);
  if (!m) return false;
  const pkg = normName(m[1]!);
  return names.some((n) => {
    const name = normName(n);
    return pkg === name || pkg.endsWith(`/${name}`);
  });
}

function hasDir(files: Set<string>, name: string): boolean {
  const prefix = `${name.toLowerCase()}/`;
  for (const f of files) if (f.toLowerCase().startsWith(prefix)) return true;
  return false;
}

const CD_REPO = (repo: string) => new RegExp(`^cd\\s+(?:\\./)?${repo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:/(\\S+))?/?$`, "i");

/** Port mentions such as http://localhost:3000, most relevant first. */
export function localhostPorts(text: string): number[] {
  const found: number[] = [];
  for (const m of text.matchAll(/\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\])\s*:\s*(\d{2,5})\b/gi)) {
    const port = Number(m[1]);
    if (port >= 80 && port < 65536 && !SERVICE_PORTS.has(port) && !found.includes(port)) found.push(port);
  }
  return found;
}

export function mineReadme(text: string, opts: ReadmeOptions): ReadmeEvidence {
  const { blocks, inline } = scan(text);
  const evidence: ReadmeEvidence = { commands: [], ports: [], env: {}, versions: [], skipped: [], usesDocker: false, installsPublished: false };
  const seen = new Map<string, MinedCommand>();
  const names = [...(opts.packageNames ?? []), ...(opts.repoName ? [opts.repoName] : [])].filter(Boolean);
  const cdRepo = opts.repoName ? CD_REPO(opts.repoName) : null;
  const sectionPorts: { port: number; weight: number; order: number }[] = [];
  let dir = ".";
  let cloned = false;

  const add = (cmd: string, d: string, section: string, weight: number, inlineSpan = false) => {
    const kind = classifyCommand(cmd);
    const key = `${d}\u0000${cmd}`;
    const prev = seen.get(key);
    if (prev) {
      prev.weight = Math.max(prev.weight, weight);
      return;
    }
    const mined: MinedCommand = { command: cmd, kind, dir: d, section, weight, ...(inlineSpan ? { inline: true } : {}) };
    seen.set(key, mined);
    evidence.commands.push(mined);
  };

  const take = (line: string, section: string, weight: number, inlineSpan: boolean): boolean => {
    let any = false;
    for (let segment of splitChain(line)) {
      if (/^git\s+clone\b|^gh\s+repo\s+clone\b/.test(segment)) cloned = true;
      if (cdRepo) {
        const m = cdRepo.exec(segment);
        if (m && (cloned || !hasDir(opts.files, opts.repoName!))) {
          // `cd repo-name` right after cloning lands in the repo root, which is where Pyrovue already is.
          if (!m[1]) {
            dir = ".";
            continue;
          }
          segment = `cd ${m[1]}`;
        }
      }
      const s = sanitizeCommand(segment, { files: opts.files, dir });
      if (s.docker) evidence.usesDocker = true;
      if (s.skip && !inlineSpan) evidence.skipped.push({ command: redact(segment), reason: s.skip });
      if (s.cd !== undefined) dir = s.cd;
      if (s.env && !inlineSpan) evidence.env[s.env[0]] = s.env[1];
      if (s.version && !evidence.versions.some((v) => v.tool === s.version!.tool)) evidence.versions.push(s.version);
      if (!s.command) continue;
      if (installsPublishedPackage(s.command, names)) {
        evidence.installsPublished = true;
        continue;
      }
      if (inlineSpan && classifyCommand(s.command) === "other") continue;
      add(s.command, dir, section, weight, inlineSpan);
      any = true;
    }
    return any;
  };

  let order = 0;
  for (const block of blocks) {
    if (block.newSection) dir = ".";
    cloned = false;
    if (block.weight === 0) {
      // Still notice Docker-only instructions, but run nothing from deploy/test/Docker sections.
      if (block.lines.some((l) => /\bdocker(-compose|\s+compose|\s+run|\s+build)\b/.test(l))) evidence.usesDocker = true;
      continue;
    }
    for (const port of localhostPorts(block.lines.join("\n"))) sectionPorts.push({ port, weight: block.weight, order: order++ });
    if (ENV_LANGS.has(block.lang)) {
      for (const line of block.lines) {
        const s = sanitizeCommand(line.trim(), { files: opts.files });
        if (s.env) evidence.env[s.env[0]] = s.env[1];
      }
      continue;
    }
    if (!SHELL_LANGS.has(block.lang)) continue;
    // The sanitiser drops unknown commands, so plain-text blocks of output or file trees add nothing.
    for (const command of blockCommands(block.lines)) take(command, block.section, block.weight, false);
  }

  // Inline spans ("then run `npm run dev`") count only under run-instruction headings.
  for (const span of inline) {
    if (span.weight < 0.6 || /\s{2,}/.test(span.text) || !/\s/.test(span.text)) continue;
    const cmd = span.text.replace(PROMPT, "").trim();
    if (headWord(cmd) === "" || /^cd\s+\S+$/.test(cmd)) continue;
    dir = ".";
    take(cmd, span.section, span.weight * 0.6, true);
  }

  for (const port of localhostPorts(text)) if (!sectionPorts.some((p) => p.port === port)) sectionPorts.push({ port, weight: 0.3, order: order++ });
  evidence.ports = sectionPorts.sort((a, b) => b.weight - a.weight || a.order - b.order).map((p) => p.port).filter((p, i, all) => all.indexOf(p) === i);
  return evidence;
}
