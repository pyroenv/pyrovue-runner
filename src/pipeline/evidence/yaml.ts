/**
 * A small YAML reader for the files Pyrovue mines (docker-compose, render.yaml, Taskfile, .gitlab-ci-ish config).
 * It covers block maps and sequences, flow collections on one line, quoted and block scalars, comments, and
 * anchors with `<<` merges. Anything stranger is read as a plain string rather than throwing.
 */
export type YamlValue = string | number | boolean | null | YamlValue[] | { [key: string]: YamlValue };
export type YamlMap = { [key: string]: YamlValue };

interface Line {
  indent: number;
  text: string;
  raw: string;
}

const WS = /\s/;
const QUOTED_KEY_RE = /^("(?:[^"\\]|\\.)*"|'(?:[^']|'')*')\s*:/;

/**
 * Splits a block-map line into its key and the text after the colon, or null when it isn't `key: value`. The key is a
 * quoted string, or plain text up to the first `:` that ends the line or is followed by whitespace (a `#` before it
 * ends the search). One pass, so a long line or a long whitespace run costs only its length.
 */
function splitKeyLine(s: string): [string, string, string | undefined] | null {
  const first = s[0];
  if (first === undefined) return null;
  if (first === '"' || first === "'") {
    const m = QUOTED_KEY_RE.exec(s);
    if (!m) return null;
    return afterColon(s, m[1]!, m[0].length);
  }
  if (WS.test(first) || "#{[]".includes(first)) return null;
  for (let c = 1; c < s.length; c++) {
    const ch = s[c]!;
    if (ch === "#") return null;
    if (ch === ":" && (c + 1 === s.length || WS.test(s[c + 1]!))) return afterColon(s, s.slice(0, c).trimEnd(), c + 1);
  }
  return null;
}

/** The match for a key whose colon ends just before `at`: undefined value when the line ends there. */
function afterColon(s: string, key: string, at: number): [string, string, string | undefined] | null {
  if (at === s.length) return [s, key, undefined];
  if (!WS.test(s[at]!)) return null;
  return [s, key, s.slice(at).trimStart()];
}

const KEY = {
  test: (s: string): boolean => splitKeyLine(s) !== null,
  exec: splitKeyLine,
};

function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = null;
    } else if (c === '"' || c === "'") {
      if (i === 0 || /[\s:[{,-]/.test(s[i - 1]!)) quote = c;
    } else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) {
      return s.slice(0, i).trimEnd();
    }
  }
  return s.trimEnd();
}

function unquote(s: string): string {
  if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
    return s
      .slice(1, -1)
      .replace(/\\n/g, "\n")
      .replace(/\\t/g, "\t")
      .replace(/\\(["\\/])/g, "$1");
  }
  if (s.length >= 2 && s.startsWith("'") && s.endsWith("'")) return s.slice(1, -1).replace(/''/g, "'");
  return s;
}

/** How deep flow collections ([a, [b]], {a: {b: c}}) are read; deeper is kept as the text it is. */
const MAX_FLOW_DEPTH = 16;

function splitFlow(inner: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quote: string | null = null;
  let cur = "";
  for (const c of inner) {
    if (quote) {
      cur += c;
      if (c === quote) quote = null;
      continue;
    }
    if (c === '"' || c === "'") quote = c;
    if (c === "[" || c === "{") depth++;
    if (c === "]" || c === "}") depth--;
    if (c === "," && depth === 0) {
      parts.push(cur.trim());
      cur = "";
    } else {
      cur += c;
    }
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

export class YamlReader {
  private lines: Line[] = [];
  private i = 0;
  private anchors = new Map<string, YamlValue>();

  constructor(text: string) {
    for (const raw of text.replace(/\r\n?/g, "\n").split("\n")) {
      const indent = raw.length - raw.trimStart().length;
      this.lines.push({ indent, text: stripComment(raw.trim()), raw });
    }
  }

  parse(): YamlValue {
    this.skipBlank();
    if (this.i < this.lines.length && this.lines[this.i]!.text === "---") this.i++;
    return this.block(-1);
  }

  private skipBlank() {
    while (this.i < this.lines.length) {
      const t = this.lines[this.i]!.text;
      if (t === "" || t.startsWith("#")) this.i++;
      else break;
    }
  }

  private peek(): Line | null {
    this.skipBlank();
    const line = this.lines[this.i];
    if (!line || line.text === "---" || line.text === "...") return null;
    return line;
  }

  /** Parses whatever block starts at the next line, if it is indented deeper than `parent`. */
  private block(parent: number): YamlValue {
    const line = this.peek();
    if (!line || line.indent <= parent) return null;
    if (line.text === "-" || line.text.startsWith("- ")) return this.seq(line.indent);
    if (KEY.test(line.text)) return this.map(line.indent);
    // A multi-line plain scalar.
    const parts: string[] = [];
    while (this.peek() && this.peek()!.indent > parent) parts.push(this.lines[this.i++]!.text);
    return this.scalar(parts.join(" "));
  }

  private map(indent: number): YamlMap {
    const out: YamlMap = {};
    for (let line = this.peek(); line && line.indent === indent; line = this.peek()) {
      const m = KEY.exec(line.text);
      if (!m) break;
      this.i++;
      const key = unquote(m[1]!.trim());
      let rest = (m[2] ?? "").trim();
      let anchor: string | null = null;
      const a = /^&([\w.-]+)\s*(.*)$/.exec(rest);
      if (a) {
        anchor = a[1]!;
        rest = a[2]!.trim();
      }
      let value: YamlValue;
      if (rest === "") {
        const next = this.peek();
        value = next && next.indent === indent && (next.text === "-" || next.text.startsWith("- ")) ? this.seq(indent) : this.block(indent);
      } else if (/^[|>][-+]?\d*$/.test(rest)) {
        value = this.blockScalar(indent, rest);
      } else {
        value = this.inline(rest);
      }
      if (anchor) this.anchors.set(anchor, value);
      if (key === "<<") {
        const sources = Array.isArray(value) ? value : [value];
        for (const s of sources) if (s && typeof s === "object" && !Array.isArray(s)) for (const [k, v] of Object.entries(s)) if (!(k in out)) out[k] = v;
      } else {
        out[key] = value;
      }
    }
    return out;
  }

  private seq(indent: number): YamlValue[] {
    const out: YamlValue[] = [];
    for (let line = this.peek(); line && line.indent === indent && (line.text === "-" || line.text.startsWith("- ")); line = this.peek()) {
      const content = line.text === "-" ? "" : line.text.slice(2).trimStart();
      if (content === "") {
        this.i++;
        out.push(this.block(indent));
        continue;
      }
      if ((KEY.test(content) && !/^["']/.test(content)) || /^("[^"]*"|'[^']*')\s*:(\s|$)/.test(content)) {
        // "- key: value" opens a map whose keys line up with `key`.
        const offset = line.raw.indexOf(content, line.indent + 1);
        this.lines[this.i] = { indent: offset, text: content, raw: line.raw };
        out.push(this.map(offset));
        continue;
      }
      this.i++;
      if (/^[|>][-+]?\d*$/.test(content)) out.push(this.blockScalar(indent, content));
      else out.push(this.inline(content));
    }
    return out;
  }

  private blockScalar(indent: number, header: string): string {
    const lines: string[] = [];
    let blockIndent = -1;
    while (this.i < this.lines.length) {
      const line = this.lines[this.i]!;
      if (line.raw.trim() === "") {
        lines.push("");
        this.i++;
        continue;
      }
      if (line.indent <= indent) break;
      if (blockIndent < 0) blockIndent = line.indent;
      if (line.indent < blockIndent) break;
      lines.push(line.raw.slice(blockIndent));
      this.i++;
    }
    while (lines.length && lines.at(-1) === "") lines.pop();
    const text = header.startsWith(">") ? lines.join("\n").replace(/([^\n])\n(?!\n)/g, "$1 ") : lines.join("\n");
    return header.includes("-") ? text : `${text}\n`;
  }

  private inline(s: string, depth = 0): YamlValue {
    if (s.startsWith("*")) return this.anchors.get(s.slice(1).trim()) ?? null;
    // Each level reads the whole rest of the line again, so a line of tens of thousands of brackets is quadratic work
    // (and a stack overflow). No real file nests this deep: past it, the rest is plain text.
    if (depth >= MAX_FLOW_DEPTH && (s.startsWith("[") || s.startsWith("{"))) return s;
    if (s.startsWith("[") && s.endsWith("]")) return splitFlow(s.slice(1, -1)).map((p) => this.inline(p, depth + 1));
    if (s.startsWith("{") && s.endsWith("}")) {
      const out: YamlMap = {};
      for (const part of splitFlow(s.slice(1, -1))) {
        const quoted = /^("[^"]*"|'[^']*')\s*:\s*(.*)$/.exec(part);
        const colon = part.indexOf(":");
        const m: [string, string] | null = quoted ? [quoted[1]!, quoted[2]!] : colon > 0 ? [part.slice(0, colon), part.slice(colon + 1)] : null;
        if (m) out[unquote(m[0].trim())] = this.inline(m[1].trim(), depth + 1);
        else out[unquote(part)] = null;
      }
      return out;
    }
    return this.scalar(s);
  }

  private scalar(s: string): YamlValue {
    if (/^["']/.test(s)) return unquote(s);
    if (s === "" || s === "~" || s === "null" || s === "Null" || s === "NULL") return null;
    if (/^(true|True|TRUE)$/.test(s)) return true;
    if (/^(false|False|FALSE)$/.test(s)) return false;
    // Only a plain whole number that survives the round trip: 3.10, 1.0 and an 18-digit id stay the text they were.
    if (/^-?\d+$/.test(s) && String(Number(s)) === s && Number.isSafeInteger(Number(s))) return Number(s);
    return s;
  }
}

export function parseYaml(text: string | undefined): YamlValue {
  if (!text) return null;
  try {
    return new YamlReader(text).parse();
  } catch {
    return null;
  }
}

export function isMap(v: YamlValue | undefined): v is YamlMap {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

export function asString(v: YamlValue | undefined): string | null {
  if (typeof v === "string") return v;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return null;
}
