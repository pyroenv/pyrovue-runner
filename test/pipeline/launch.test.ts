import { spawnSync } from "node:child_process";
import { getEventListeners } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type Docker from "dockerode";
import { afterEach, describe, expect, it, vi } from "vitest";
import { backgroundPorts, launchApp } from "../../src/pipeline/launch";
import { Box, type ExecResult, PYRO_DIR } from "../../src/sandbox/box";

/** An app that opens port 3000 after `opensAfter` polls. */
class StubBox {
  started: string[] = [];
  private polls = -1; // the first listeners() call is the baseline, before the app starts
  constructor(private readonly opensAfter = 1) {}
  async stopApp() {}
  async listeners() {
    this.polls++;
    return this.polls >= this.opensAfter ? [{ port: 3000, address: "0.0.0.0", family: "4" as const }] : [];
  }
  async startApp(command: string) {
    this.started.push(command);
  }
  async appLogTail() {
    return "";
  }
  async appRunning() {
    return true;
  }
  async probe() {
    return 200;
  }
  async relayTo() {
    return true;
  }
}

const spec = { command: "npm run dev", cwd: "/workspace", env: {}, port: 3000, previewPath: null };

describe("launchApp", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("doesn't start anything once the setup is cancelled or timed out", async () => {
    const box = new StubBox();
    const controller = new AbortController();
    controller.abort(new Error("Setup took longer than 20 minutes."));
    await expect(launchApp(box as unknown as Box, spec, { signal: controller.signal })).rejects.toThrow("longer than 20 minutes");
    expect(box.started).toEqual([]);
  });

  it("stops polling when the signal aborts mid-launch", async () => {
    vi.useFakeTimers();
    const box = new StubBox(1000);
    const controller = new AbortController();
    const launched = launchApp(box as unknown as Box, spec, { signal: controller.signal, timeoutSec: 600 });
    const settled = launched.catch((err: Error) => err);
    await vi.advanceTimersByTimeAsync(5000);
    controller.abort(new Error("cancelled"));
    await vi.advanceTimersByTimeAsync(1500);
    expect(await settled).toMatchObject({ message: "cancelled" });
  });

  it("leaves no abort listeners behind on the pipeline's signal", async () => {
    vi.useFakeTimers();
    const box = new StubBox(4);
    const controller = new AbortController();
    const launched = launchApp(box as unknown as Box, spec, { signal: controller.signal });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await launched).toMatchObject({ ok: true, port: 3000 });
    expect(getEventListeners(controller.signal, "abort")).toHaveLength(0);
  });

  /** A backend that opens 8000 a poll before the frontend opens 5173, both answering HTTP. */
  class TwoServers {
    relayed: number[] = [];
    private calls = -1;
    async stopApp() {}
    async startApp() {}
    async appLogTail() {
      return "";
    }
    async appRunning() {
      return true;
    }
    async probe() {
      return 200;
    }
    async listeners() {
      this.calls++;
      const at = (port: number) => ({ port, address: "0.0.0.0", family: "4" as const });
      return this.calls === 0 ? [] : this.calls === 1 ? [at(8000)] : [at(8000), at(5173)];
    }
    async relayTo(port: number) {
      this.relayed.push(port);
      return true;
    }
  }

  it("never relays to a background service's port", async () => {
    vi.useFakeTimers();
    const box = new TwoServers();
    const launched = launchApp(box as unknown as Box, { ...spec, command: "(cd /workspace/backend && uvicorn main:app --port 8000) & npm run dev", port: 5173, ignorePorts: [8000] });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await launched;
    expect(result).toMatchObject({ ok: true, port: 5173 });
    expect(box.relayed).toEqual([5173]);
    expect(result.listeners.map((l) => l.port)).toEqual([8000, 5173]);
  });

  it("reads a background service's port from the start command, for a wake or a recipe replay", async () => {
    vi.useFakeTimers();
    const box = new TwoServers();
    const launched = launchApp(box as unknown as Box, { ...spec, command: "service postgresql start || true; (cd /workspace/backend && PORT=8000 uvicorn main:app --port 8000) & npm run dev", port: 5173 });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await launched).toMatchObject({ ok: true, port: 5173 });
    expect(box.relayed).toEqual([5173]);
  });

  it("takes the plan's list of service ports over the ones its start command gives", async () => {
    vi.useFakeTimers();
    // Only 8080 opens: a frontend whose own config moved it there, next to a backend told PORT=8080 that ignores it.
    const box = new StubBox();
    box.listeners = async function (this: StubBox) {
      return (await StubBox.prototype.listeners.call(this)).map((l) => ({ ...l, port: 8080 }));
    };
    const launched = launchApp(box as unknown as Box, { ...spec, command: "(cd /workspace/server && PORT=8080 go run .) & npm run dev", port: 5173, ignorePorts: [] }, { timeoutSec: 10 });
    await vi.advanceTimersByTimeAsync(12_000);
    expect(await launched).toMatchObject({ ok: true, port: 8080 });
  });

  it("still relays to the expected port when a service shares it", async () => {
    vi.useFakeTimers();
    const box = new TwoServers();
    const launched = launchApp(box as unknown as Box, { ...spec, port: 8000, ignorePorts: [8000] });
    await vi.advanceTimersByTimeAsync(5000);
    expect(await launched).toMatchObject({ ok: true, port: 8000 });
    expect(box.relayed).toEqual([8000]);
  });
});

describe("backgroundPorts", () => {
  it("finds the PORT given to each background service, and nothing in a plain command", () => {
    expect(backgroundPorts("(cd /workspace/api && PORT=8080 go run .) & (PORT=3036 bin/vite dev) & npm run dev")).toEqual([8080, 3036]);
    expect(backgroundPorts("PORT=3000 npm run dev")).toEqual([]);
    expect(backgroundPorts("(cd /workspace && npm run dev) & php artisan serve")).toEqual([]);
    expect(backgroundPorts("npm run build && PORT=4000 node server.js")).toEqual([]);
  });
});

describe("Box.startApp", () => {
  /** A Box whose shell and file writes are captured instead of sent to Docker. */
  function capturingBox() {
    const box = new Box({} as Docker, "test");
    const commands: string[] = [];
    const files: Record<string, string> = {};
    const ok: ExecResult = { exitCode: 0, output: "", stdout: Buffer.from(""), timedOut: false };
    box.sh = async (command: string) => {
      commands.push(command);
      return ok;
    };
    box.writeFile = async (file: string, content: string | Buffer) => {
      files[file] = content.toString();
    };
    return { box, commands, files };
  }

  it("records the app's own process group in app.pid, not a subshell's", async () => {
    const { box, commands } = capturingBox();
    await box.startApp("npm run dev");
    const start = commands.find((c) => c.includes("setsid"))!;
    // `a && b & echo $!` would background the whole && list: $! would be that subshell's pid.
    expect(start).toMatch(/&& \{ setsid bash \/var\/pyro\/start\.sh [^{}]*& echo \$! > \/var\/pyro\/app\.pid; \}$/);
  });

  // Runs the real command where the host has setsid (Linux), with /var/pyro moved to a temp dir.
  const hasSetsid = process.platform === "linux" && spawnSync("setsid", ["--version"]).status === 0;
  it.skipIf(!hasSetsid)("starts a group that appRunning and stopApp can find", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "pyro-start-"));
    try {
      const { box, commands, files } = capturingBox();
      await box.startApp("exec sleep 30", { cwd: dir });
      const local = (s: string) => s.split(PYRO_DIR).join(dir);
      await writeFile(path.join(dir, "start.sh"), files[`${PYRO_DIR}/start.sh`]!);
      expect(spawnSync("bash", ["-c", local(commands.find((c) => c.includes("setsid"))!)]).status).toBe(0);
      const pid = (await readFile(path.join(dir, "app.pid"), "utf8")).trim();
      expect(spawnSync("bash", ["-c", `kill -0 -- -${pid}`]).status).toBe(0);
      spawnSync("bash", ["-c", `kill -KILL -- -${pid}`]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
