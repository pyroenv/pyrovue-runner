import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Guards against the family of bugs where a regular expression with a whitespace run (`\s+`, `\s*`, `[ \t]+`) followed
 * by something that can fail to match is quadratic on a long run of spaces: a repo's file is read by the server, and one
 * line of "a" + 200,000 spaces + "b" blocked the event loop for minutes (the .env reader, the YAML reader, ...).
 *
 * It collects every regular expression literal in the server and shared sources that has a whitespace quantifier, runs
 * each on hostile lines (several prefixes, spaces / tabs / mixed, several endings), with `test` and with a global
 * `replace`, and fails any that takes more than 50 ms on 10,000 characters (a linear one takes a millisecond or two;
 * a quadratic one takes hundreds of milliseconds, and minutes at the 200,000 a real file can hold). New code that adds such a regex fails here.
 *
 * The same is done with runs of line breaks and blank lines (third pass T-08): `^\s*ruby` with the `m` flag is tried at
 * every line start, and on a file of blank lines each try swallows all the lines after it. Every regex with a
 * whitespace quantifier, and every one with the `m` flag, is also run on runs of CR, LF, CRLF and blank lines
 * (spaces or a tab, then a break) in the thousands.
 */
const ROOTS = [join(__dirname, "../../src")];
const N = 10_000;
const LIMIT_MS = 50;

/** Offenders in files outside the engine's ownership, handed to their owners (.audit-work/handoff3.md); remove each when fixed. */
const HANDED_OFF: string[] = [];

function files(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    const p = join(dir, e.name);
    if (e.isDirectory()) return e.name === "node_modules" ? [] : files(p);
    return /\.tsx?$/.test(e.name) && !/\.test\.tsx?$/.test(e.name) ? [p] : [];
  });
}

/** Regex literals in TypeScript source: a small scanner that skips strings, template text and comments. */
function regexLiterals(src: string): string[] {
  const out: string[] = [];
  const templates: number[] = [];
  let prev = "";
  let prevWord = "";
  for (let i = 0; i < src.length; ) {
    const c = src[i]!;
    const n = src[i + 1];
    if (c === "/" && n === "/") {
      while (i < src.length && src[i] !== "\n") i++;
    } else if (c === "/" && n === "*") {
      const e = src.indexOf("*/", i + 2);
      i = e < 0 ? src.length : e + 2;
    } else if (c === '"' || c === "'") {
      i++;
      while (i < src.length && src[i] !== c && src[i] !== "\n") i += src[i] === "\\" ? 2 : 1;
      i++;
      prev = "a";
    } else if (c === "`" || (c === "}" && templates.length && templates[templates.length - 1] === 0)) {
      if (c === "}") templates.pop();
      i++;
      let closed = false;
      while (i < src.length) {
        if (src[i] === "\\") i += 2;
        else if (src[i] === "`") {
          closed = true;
          i++;
          break;
        } else if (src[i] === "$" && src[i + 1] === "{") {
          templates.push(0);
          i += 2;
          break;
        } else i++;
      }
      prev = closed ? "a" : "(";
    } else if (c === "/" && (prev === "" || "(,=:[!&|?{};+-*%<>~^".includes(prev) || ["return", "typeof", "case", "in", "of", "void"].includes(prevWord))) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && src[j] !== "\n") {
        if (src[j] === "\\") j += 2;
        else if (src[j] === "[") (inClass = true), j++;
        else if (src[j] === "]") (inClass = false), j++;
        else if (src[j] === "/" && !inClass) break;
        else j++;
      }
      const body = src.slice(i + 1, j);
      let k = j + 1;
      while (/[a-z]/.test(src[k] ?? "")) k++;
      out.push(`${body}\u0000${src.slice(j + 1, k)}`);
      i = k;
      prev = "a";
    } else {
      if (templates.length) {
        if (c === "{") templates[templates.length - 1]!++;
        else if (c === "}") templates[templates.length - 1]!--;
      }
      if (/\s/.test(c)) {
        i++;
        continue;
      }
      if (/[A-Za-z_$]/.test(c)) {
        let j = i;
        while (/[\w$]/.test(src[j] ?? "")) j++;
        prevWord = src.slice(i, j);
        prev = "a";
        i = j;
        continue;
      }
      prevWord = "";
      prev = c;
      i++;
    }
  }
  return out;
}

const HAS_WHITESPACE_RUN = /\\s[+*{]|\[[ \\t]+\][+*{]|\[\^?\\S\][+*{]| [+*{]/;

const BREAKS = ["\n", "\r", "\r\n", " \n", "\n\t", "\n \n"];
const PREFIXES = ["", "K=", "- "];
const RUNS = [" ", "\t", " \t"];
const ENDINGS = ["b", "#"];

function slowest(re: RegExp): { ms: number; input: string } {
  let worst = { ms: 0, input: "" };
  for (const p of PREFIXES) {
    for (const w of RUNS) {
      for (const e of ENDINGS) {
        for (const x of [`${p}a${w.repeat(N / w.length)}${e}`, `${p}${w.repeat(N / w.length)}${e}`]) {
          const t = performance.now();
          re.lastIndex = 0;
          re.test(x);
          re.lastIndex = 0;
          x.replace(re, "");
          const ms = performance.now() - t;
          if (ms > worst.ms) worst = { ms, input: `${JSON.stringify(p)} + "a" + ${JSON.stringify(w)} x ${N} + ${JSON.stringify(e)}` };
        }
      }
    }
  }
  // Runs of line breaks and blank lines, which the pattern may meet in a file of nothing but blank lines.
  for (const p of PREFIXES) {
    for (const w of BREAKS) {
      for (const e of ENDINGS) {
        for (const x of [`${p}a${w.repeat(N / w.length)}${e}`, `${p}${w.repeat(N / w.length)}${e}`, `${w.repeat(N / w.length)}${p}ruby ${e}`]) {
          const t = performance.now();
          re.lastIndex = 0;
          re.test(x);
          re.lastIndex = 0;
          x.replace(re, "");
          const ms = performance.now() - t;
          if (ms > worst.ms) worst = { ms, input: `${JSON.stringify(p)} + "a" + ${JSON.stringify(w)} x ${N / w.length} + ${JSON.stringify(e)}` };
        }
      }
    }
  }
  return worst;
}

describe("no regular expression in the server or shared sources is quadratic on a long run of whitespace", () => {
  const found: Array<{ file: string; source: string; flags: string }> = [];
  for (const root of ROOTS) {
    for (const f of files(root)) {
      for (const lit of regexLiterals(readFileSync(f, "utf8"))) {
        const [source, flags] = lit.split("\u0000") as [string, string];
        if (HAS_WHITESPACE_RUN.test(source) || flags.includes("m")) found.push({ file: relative(root, f).replace(/\\/g, "/"), source, flags });
      }
    }
  }

  it("found the regular expressions to check (the scanner has not gone blind)", () => {
    expect(found.length).toBeGreaterThan(100);
  });

  it(`runs each in under ${LIMIT_MS} ms on lines of ${N} spaces, tabs and mixed whitespace`, () => {
    const slow: string[] = [];
    for (const { file, source, flags } of found) {
      if (HANDED_OFF.includes(file)) continue;
      let re: RegExp;
      try {
        re = new RegExp(source, flags.replace(/[gy]/g, "") + "g");
      } catch {
        continue;
      }
      const { ms, input } = slowest(re);
      if (ms > LIMIT_MS) slow.push(`${Math.round(ms)} ms  ${file}  /${source}/${flags}  on ${input}`);
    }
    expect(slow).toEqual([]);
  }, 120_000);
});
