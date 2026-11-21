import { SERVICE_PORTS } from "./readme";

/**
 * Where the app will listen, from the strongest evidence down: the start command's own flag, the image's EXPOSE or
 * compose ports, an env PORT, a README's localhost link, a listen() call in the code, then the framework default.
 */

export type PortSource = "command" | "expose" | "env" | "readme" | "code" | "default";

export interface PortHint {
  port: number;
  source: PortSource;
}

const RANK: Record<PortSource, number> = { command: 0, expose: 1, env: 2, readme: 3, code: 4, default: 5 };

const valid = (n: number) => Number.isInteger(n) && n >= 80 && n < 65536 && !SERVICE_PORTS.has(n);

/** The port a start command asks for: `--port 8000`, `-p 3000`, `0.0.0.0:8000`, `PORT=4000 …`. */
export function commandPort(cmd: string): number | null {
  const patterns = [
    /(?:^|\s)PORT=(\d{2,5})\b/,
    /--(?:server\.)?port[= ](\d{2,5})\b/,
    /(?:^|\s)-p\s*(\d{2,5})\b/,
    /(?:--bind|-b|--listen|--host|--addr)[= ](?:[\w.[\]:]*:)?(\d{2,5})\b/,
    /\b(?:0\.0\.0\.0|127\.0\.0\.1|localhost|\[::\]):(\d{2,5})\b/,
    /(?:^|\s)runserver\s+(?:[\w.]+:)?(\d{2,5})\b/,
    /http\.server\s+(\d{2,5})\b/,
    /\$\{PORT:-(\d{2,5})\}/,
  ];
  for (const re of patterns) {
    const m = re.exec(cmd);
    if (m && valid(Number(m[1]))) return Number(m[1]);
  }
  return null;
}

/** Ports a server's source code binds: `listen(3000)`, `PORT || 5000`, `port=8000`, `":8080"`. */
export function codePorts(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /\.listen\(\s*(\d{2,5})\b/g,
    /\bPORT\b['"]?\]?\s*(?:\|\||\?\?|or|,|:-)\s*['"]?(\d{2,5})\b/g,
    /\b(?:getenv|get)\(\s*['"]PORT['"]\s*,\s*['"]?(\d{2,5})\b/g,
    /\bport\s*[:=]\s*(?:int\()?['"]?(\d{2,5})\b/gi,
    /\bListenAndServe\(\s*["'][\w.]*:(\d{2,5})["']/g,
    /\bAddr:\s*["'][\w.]*:(\d{2,5})["']/g,
    /\.(?:run|bind)\(\s*(?:\(?\s*["'][\d.]+["']\s*,\s*)(\d{2,5})\b/g,
    /\bapp\.run\([^)]*\bport\s*=\s*(\d{2,5})\b/g,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const n = Number(m[1]);
      if (valid(n) && !found.includes(n)) found.push(n);
    }
  }
  return found;
}

/** The best-supported port; ties go to the hint seen first. */
export function choosePort(hints: PortHint[]): number | null {
  const best = [...hints].filter((h) => valid(h.port)).sort((a, b) => RANK[a.source] - RANK[b.source])[0];
  return best?.port ?? null;
}
