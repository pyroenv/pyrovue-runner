import { describe, expect, it } from "vitest";
import { rankPorts } from "../../src/pipeline/launch";
import { stripAnsi } from "../../src/sandbox/box";
import { parseListeners, portsFromLogs, relayTarget } from "../../src/sandbox/procnet";

const TCP = `  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000:1F90 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 15468 1 0000000000000000 100 0 0 10 0
   1: 0B00007F:AFE1 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 12928 2 0000000000000000 100 0 0 10 0
   2: 0100007F:1F90 0100007F:8F44 06 00000000:00000000 03:00000F4C 00000000     0        0 0 3 0000000000000000
   3: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
  sl  local_address                         remote_address                        st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode
   0: 00000000000000000000000001000000:1435 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
   1: 00000000000000000000000000000000:1F40 00000000000000000000000000000000:0000 0A 00000000:00000000 00:00000000 00000000     0        0 1 1 0000000000000000 100 0 0 10 0
`;

describe("parseListeners", () => {
  it("finds IPv4 and IPv6 listening sockets and skips established ones", () => {
    const listeners = parseListeners(TCP);
    expect(listeners).toEqual([
      { port: 8080, address: "0.0.0.0", family: "4" },
      { port: 45025, address: "127.0.0.11", family: "4" },
      { port: 3000, address: "127.0.0.1", family: "4" },
      { port: 5173, address: "::1", family: "6" },
      { port: 8000, address: "::", family: "6" },
    ]);
  });
});

describe("relayTarget", () => {
  const listeners = parseListeners(TCP);
  it("connects to loopback for wildcard and loopback IPv4 binds", () => {
    expect(relayTarget(listeners, 8080)).toEqual({ host: "127.0.0.1", family: "4" });
    expect(relayTarget(listeners, 3000)).toEqual({ host: "127.0.0.1", family: "4" });
  });
  it("uses ::1 for IPv6-only listeners (e.g. Vite bound to localhost)", () => {
    expect(relayTarget(listeners, 5173)).toEqual({ host: "::1", family: "6" });
    expect(relayTarget(listeners, 8000)).toEqual({ host: "::1", family: "6" });
  });
  it("returns null for ports nobody listens on", () => {
    expect(relayTarget(listeners, 1234)).toBeNull();
  });
});

describe("portsFromLogs", () => {
  it("pulls ports out of common dev server banners", () => {
    expect(portsFromLogs("  ➜  Local:   http://localhost:5173/")).toEqual([5173]);
    expect(portsFromLogs("Uvicorn running on http://0.0.0.0:8000 (Press CTRL+C to quit)")).toEqual([8000]);
    expect(portsFromLogs("Server listening on port 4000")).toContain(4000);
    expect(portsFromLogs("Starting development server at http://127.0.0.1:8000/")).toEqual([8000]);
  });
});

describe("rankPorts", () => {
  it("prefers the expected port, then ports named in logs, then common web ports", () => {
    expect(rankPorts([9229, 24678, 5173, 3000], 3000, [])).toEqual([3000, 5173]);
    expect(rankPorts([8080, 41234], null, [41234])).toEqual([41234, 8080]);
    expect(rankPorts([41234, 3000], null, [])).toEqual([3000, 41234]);
  });
});

describe("box output parsing stays linear", () => {
  // Both run on the shared event loop over text a box controls; these inputs took tens of seconds before.
  const elapsed = (fn: () => unknown) => {
    const start = performance.now();
    fn();
    return performance.now() - start;
  };

  it("portsFromLogs: 'port' followed by a long run of whitespace", () => {
    const text = `port${" ".repeat(256 * 1024)}x`;
    expect(elapsed(() => portsFromLogs(text))).toBeLessThan(500);
    expect(portsFromLogs(`listening on port 3000\nPORT=8080\nport: 5173`)).toEqual([3000, 8080, 5173]);
  });

  it("stripAnsi: many unterminated OSC introducers", () => {
    const text = "\x1b]".repeat(128 * 1024);
    expect(elapsed(() => stripAnsi(text))).toBeLessThan(500);
    expect(stripAnsi("\x1b]0;title\x07a\x1b[31mb\x1b[0m\x1b]8;;https://x\x1b\\c")).toBe("abc");
  });
});
