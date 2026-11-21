/**
 * A small TOML reader for fly.toml, netlify.toml and pyproject.toml: tables, arrays of tables, dotted keys,
 * strings (basic, literal, multi-line), numbers, booleans, arrays and inline tables. Unknown syntax is skipped.
 */
export type TomlValue = string | number | boolean | TomlValue[] | TomlTable;
export type TomlTable = { [key: string]: TomlValue };

function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      cur += c;
      if (c === "\\" && quote === '"') cur += s[++i] ?? "";
      else if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    else if (c === "[" || c === "{") depth++;
    else if (c === "]" || c === "}") depth--;
    if (c === sep && depth === 0) {
      out.push(cur.trim());
      cur = "";
    } else cur += c;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#") return s.slice(0, i).trim();
  }
  return s.trim();
}

function parseKey(k: string): string[] {
  return splitTop(k, ".").map((p) => p.replace(/^"(.*)"$/, "$1").replace(/^'(.*)'$/, "$1"));
}

/** How deep arrays and inline tables are read: each level reads the rest of the line again, so tens of thousands of brackets are quadratic. Deeper is kept as text. */
const MAX_VALUE_DEPTH = 16;

function parseValue(v: string, depth = 0): TomlValue {
  v = v.trim();
  if (depth >= MAX_VALUE_DEPTH && (v.startsWith("[") || v.startsWith("{"))) return v;
  if (v.startsWith('"""') || v.startsWith("'''")) return v.slice(3, -3).replace(/^\n/, "");
  if (v.startsWith('"')) return v.slice(1, -1).replace(/\\n/g, "\n").replace(/\\t/g, "\t").replace(/\\(["\\])/g, "$1");
  if (v.startsWith("'")) return v.slice(1, -1);
  if (v === "true") return true;
  if (v === "false") return false;
  if (v.startsWith("[")) return splitTop(v.slice(1, -1).replace(/\n/g, " "), ",").filter(Boolean).map((p) => parseValue(p, depth + 1));
  if (v.startsWith("{")) {
    const out: TomlTable = {};
    for (const part of splitTop(v.slice(1, -1), ",")) {
      const eq = part.indexOf("=");
      if (eq > 0) setPath(out, parseKey(part.slice(0, eq).trim()), parseValue(part.slice(eq + 1), depth + 1));
    }
    return out;
  }
  const n = Number(v.replace(/_/g, ""));
  return Number.isFinite(n) && v !== "" ? n : v;
}

/** A `__proto__` key would reach Object.prototype through plain property access, so it is never followed. */
const UNSAFE = (path: string[]) => path.includes("__proto__");

function setPath(root: TomlTable, path: string[], value: TomlValue) {
  if (UNSAFE(path)) return;
  let t = root;
  for (const p of path.slice(0, -1)) {
    const next = t[p];
    if (next && typeof next === "object" && !Array.isArray(next)) t = next;
    else t = t[p] = {};
  }
  t[path.at(-1)!] = value;
}

function tableAt(root: TomlTable, path: string[], arrayItem: boolean): TomlTable {
  let t = root;
  for (let i = 0; i < path.length; i++) {
    const p = path[i]!;
    const last = i === path.length - 1;
    let next = t[p];
    if (last && arrayItem) {
      if (!Array.isArray(next)) next = t[p] = [];
      const item: TomlTable = {};
      (next as TomlValue[]).push(item);
      return item;
    }
    if (Array.isArray(next)) next = next.at(-1) as TomlTable;
    if (!next || typeof next !== "object") next = t[p] = {};
    t = next as TomlTable;
  }
  return t;
}

export function parseToml(text: string | undefined): TomlTable {
  const root: TomlTable = {};
  if (!text) return root;
  let current = root;
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  for (let i = 0; i < lines.length; i++) {
    let line = stripComment(lines[i]!);
    if (!line) continue;
    // Spaces are trimmed after matching: `\s*` around a lazy group backtracks badly on a long run of them.
    const header = /^\[\[([^\]]+)\]\]$/.exec(line) ?? /^\[([^\]]+)\]$/.exec(line);
    if (header) {
      const path = parseKey(header[1]!.trim());
      // Keys under an unsafe header go into a table nobody reads, not into the previous one.
      current = UNSAFE(path) ? {} : tableAt(root, path, line.startsWith("[["));
      continue;
    }
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = parseKey(line.slice(0, eq).trim());
    let value = line.slice(eq + 1).trim();
    // Multi-line strings and arrays continue until they close.
    const opener = value.startsWith('"""') ? '"""' : value.startsWith("'''") ? "'''" : null;
    if (opener && (value.length < 6 || !value.endsWith(opener))) {
      while (++i < lines.length) {
        value += `\n${lines[i]}`;
        if (lines[i]!.includes(opener)) break;
      }
    } else if (value.startsWith("[")) {
      let depth = 0;
      const balance = (s: string) => {
        for (const c of s.replace(/"(?:[^"\\]|\\.)*"|'[^']*'/g, "")) depth += c === "[" ? 1 : c === "]" ? -1 : 0;
      };
      balance(value);
      while (depth > 0 && ++i < lines.length) {
        const next = stripComment(lines[i]!);
        value += ` ${next}`;
        balance(next);
      }
    }
    try {
      setPath(current, key, parseValue(value));
    } catch {
      // Leave anything unparseable out.
    }
  }
  return root;
}

export function tomlGet(t: TomlTable, path: string): TomlValue | undefined {
  let cur: TomlValue | undefined = t;
  for (const p of path.split(".")) {
    if (!cur || typeof cur !== "object" || Array.isArray(cur)) return undefined;
    cur = cur[p];
  }
  return cur;
}
