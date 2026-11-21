export interface Listener {
  port: number;
  address: string;
  family: "4" | "6";
}

const LISTEN = "0A";

function ipv4(hex: string): string {
  // /proc/net/tcp stores IPv4 addresses as little-endian 32-bit hex.
  const bytes = hex.match(/../g)!.map((b) => Number.parseInt(b, 16));
  return bytes.reverse().join(".");
}

function ipv6(hex: string): string {
  // Four little-endian 32-bit words.
  const words = hex.match(/.{8}/g)!;
  const bytes = words.flatMap((w) => w.match(/../g)!.reverse());
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((Number.parseInt(bytes[i]!, 16) << 8) | Number.parseInt(bytes[i + 1]!, 16)).toString(16));
  const full = groups.join(":");
  if (full === "0:0:0:0:0:0:0:0") return "::";
  if (full === "0:0:0:0:0:0:0:1") return "::1";
  if (full.startsWith("0:0:0:0:0:ffff:")) return "::ffff:" + ipv4(hex.slice(24));
  return full;
}

/** Parses the concatenated contents of /proc/net/tcp and /proc/net/tcp6 into listening sockets. */
export function parseListeners(text: string): Listener[] {
  const seen = new Set<string>();
  const out: Listener[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+:$/.test(fields[0]!)) continue;
    const [addr, portHex] = fields[1]!.split(":") as [string, string];
    if (fields[3] !== LISTEN || !portHex) continue;
    const family = addr.length === 32 ? "6" : "4";
    const address = family === "4" ? ipv4(addr) : ipv6(addr);
    const port = Number.parseInt(portHex, 16);
    const key = `${family}|${address}|${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ port, address, family });
  }
  return out;
}

export interface Connection {
  localAddress: string;
  localPort: number;
  remoteAddress: string;
  remotePort: number;
  family: "4" | "6";
}

const ESTABLISHED = "01";

/** Parses /proc/net/tcp{,6} text into established TCP connections. */
export function parseConnections(text: string): Connection[] {
  const out: Connection[] = [];
  for (const line of text.split("\n")) {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 4 || !/^\d+:$/.test(fields[0]!) || fields[3] !== ESTABLISHED) continue;
    const [localHex, localPort] = fields[1]!.split(":") as [string, string | undefined];
    const [remoteHex, remotePort] = fields[2]!.split(":") as [string, string | undefined];
    if (!localPort || !remotePort || !/^[0-9A-Fa-f]+$/.test(localHex + remoteHex)) continue;
    if (localHex.length !== remoteHex.length || (localHex.length !== 8 && localHex.length !== 32)) continue;
    const family = localHex.length === 32 ? "6" : "4";
    const decode = family === "4" ? ipv4 : ipv6;
    out.push({
      localAddress: decode(localHex),
      localPort: Number.parseInt(localPort, 16),
      remoteAddress: decode(remoteHex),
      remotePort: Number.parseInt(remotePort, 16),
      family,
    });
  }
  return out;
}

/** Where a relay inside the box should connect to reach a listener. */
export function relayTarget(listeners: Listener[], port: number): { host: string; family: "4" | "6" } | null {
  const forPort = listeners.filter((l) => l.port === port);
  if (forPort.length === 0) return null;
  const v4 = forPort.find((l) => l.family === "4");
  if (v4) return { host: v4.address === "0.0.0.0" ? "127.0.0.1" : v4.address, family: "4" };
  const v6 = forPort[0]!;
  if (v6.address === "::" || v6.address === "::1") return { host: "::1", family: "6" };
  if (v6.address.startsWith("::ffff:")) return { host: v6.address.slice(7), family: "4" };
  return { host: v6.address, family: "6" };
}

/** Pulls likely ports out of dev-server output: "http://localhost:5173", "listening on port 3000", etc. */
export function portsFromLogs(text: string): number[] {
  const found: number[] = [];
  const patterns = [
    /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1?\]|[\w.-]+):(\d{2,5})/gi,
    // Bounded whitespace: with two unbounded \s* runs, "port" followed by a long run of spaces backtracked
    // quadratically and stalled the shared event loop on a box's own log.
    /(?:listening|running|started|serving|available|ready)[^\n]{0,40}?(?:port|:)[ \t]{0,8}(\d{2,5})\b/gi,
    /\bport[ \t]{0,8}[=:]?[ \t]{0,8}(\d{2,5})\b/gi,
  ];
  for (const re of patterns) {
    for (const m of text.matchAll(re)) {
      const port = Number(m[1]);
      if (port >= 80 && port < 65536 && !found.includes(port)) found.push(port);
    }
  }
  return found;
}
