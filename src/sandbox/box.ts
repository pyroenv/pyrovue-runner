import type Docker from "dockerode";
import { randomBytes } from "node:crypto";
import { PassThrough } from "node:stream";
import { type Listener, parseListeners, relayTarget } from "./procnet";

export const WORKSPACE = "/workspace";
export const PYRO_DIR = "/var/pyro";
export const RELAY_PORT = 49999;

export interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string | Buffer;
  /** Called with output as it arrives (stdout and stderr interleaved). */
  onOutput?: (text: string) => void;
  /** Kills the command (and its children) after this many seconds. */
  timeoutSec?: number;
  /** Bytes of output to retain (head and tail are kept, the middle is elided). */
  maxBuffer?: number;
  /** Ends the command early: the call rejects with the signal's reason. */
  signal?: AbortSignal;
}

/**
 * How long the host waits for a command run without timeoutSec. Everything in a box, its `timeout`, sh and cat
 * included, is the repository's to replace, so the host keeps its own deadline instead of trusting the box to finish.
 */
export const DEFAULT_EXEC_DEADLINE_SEC = 300;
/** Added to timeoutSec: `timeout -k 10` sends SIGKILL 10 s late, and Docker needs a moment to close the stream. */
const DEADLINE_GRACE_SEC = 25;

/** How long one call to the Docker daemon (create an exec, start one, stop or remove a container) may take. */
export const DOCKER_CALL_MS = 60_000;

/**
 * Settles with `call`, or rejects when it has taken `ms`. A daemon that accepts the socket and then stops answering
 * must cost one failed call, not a frozen health check, setup or housekeeping tick. The call itself is not cancelled
 * (dockerode has no way to), and whatever it later resolves to goes to `late`.
 */
export function withinDocker<T>(call: Promise<T>, ms = DOCKER_CALL_MS, late?: (value: T) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let over = false;
    const timer = setTimeout(() => {
      over = true;
      reject(new Error("Docker did not answer in time."));
    }, ms);
    call.then(
      (value) => {
        clearTimeout(timer);
        if (over) late?.(value);
        else resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        if (!over) reject(err);
      },
    );
  });
}

/** What Box.request got back. */
export interface PageResponse {
  status: number | null;
  location: string | null;
  timedOut: boolean;
}

export interface ExecResult {
  exitCode: number;
  output: string;
  stdout: Buffer;
  timedOut: boolean;
}

/** Keeps the first and last N bytes of a long stream. */
class OutputBuffer {
  private head: Buffer[] = [];
  private headLen = 0;
  private tail: Buffer[] = [];
  private tailLen = 0;
  private dropped = 0;

  constructor(private readonly max: number) {}

  push(chunk: Buffer) {
    const half = Math.floor(this.max / 2);
    if (this.headLen < half) {
      const take = chunk.subarray(0, half - this.headLen);
      this.head.push(take);
      this.headLen += take.length;
      chunk = chunk.subarray(take.length);
    }
    if (chunk.length === 0) return;
    this.tail.push(chunk);
    this.tailLen += chunk.length;
    while (this.tailLen > half && this.tail.length > 1) {
      const first = this.tail.shift()!;
      this.tailLen -= first.length;
      this.dropped += first.length;
    }
  }

  toBuffer(): Buffer {
    const parts = [...this.head];
    if (this.dropped > 0) parts.push(Buffer.from(`\n… [${this.dropped} bytes elided] …\n`));
    parts.push(...this.tail);
    return Buffer.concat(parts);
  }
}

// eslint-disable-next-line no-control-regex
// The OSC body excludes ESC so a match never runs past the next escape: with ESC allowed, every unterminated
// "ESC ]" scanned to the end of the text, which is quadratic on box output and stalled the shared event loop.
const ANSI = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[()][A-Z0-9]|\r(?!\n)/g;
export const stripAnsi = (s: string) => s.replace(ANSI, "");

export function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/** A running sandbox container and everything Pyrovue does inside it. */
export class Box {
  constructor(
    readonly docker: Docker,
    readonly id: string,
  ) {}

  get container() {
    return this.docker.getContainer(this.id);
  }

  /** Runs argv inside the box (no shell). */
  async exec(cmd: string[], opts: ExecOptions = {}): Promise<ExecResult> {
    opts.signal?.throwIfAborted();
    const argv = opts.timeoutSec ? ["timeout", "-k", "10", String(opts.timeoutSec), ...cmd] : cmd;
    // Monotonic, so a wall-clock jump can't turn an early kill into a timeout.
    const started = performance.now();
    const exec = await withinDocker(
      this.container.exec({
        Cmd: argv,
        AttachStdout: true,
        AttachStderr: true,
        AttachStdin: opts.stdin !== undefined,
        WorkingDir: opts.cwd ?? WORKSPACE,
        Env: opts.env ? Object.entries(opts.env).map(([k, v]) => `${k}=${v}`) : undefined,
        Tty: false,
      }),
    );
    const stream = await withinDocker(exec.start({ hijack: true, stdin: opts.stdin !== undefined }), DOCKER_CALL_MS, (late) => late.destroy());
    const stdoutBuf = new OutputBuffer(opts.maxBuffer ?? 256 * 1024);
    const combined = new OutputBuffer(opts.maxBuffer ?? 256 * 1024);
    const out = new PassThrough();
    const err = new PassThrough();
    const decoder = new TextDecoder();
    // Set once the result is taken: output arriving after a deadline must not reach the next command's log.
    let settled = false;
    const onChunk = (isStdout: boolean) => (chunk: Buffer) => {
      if (settled) return;
      if (isStdout) stdoutBuf.push(chunk);
      combined.push(chunk);
      opts.onOutput?.(decoder.decode(chunk, { stream: true }));
    };
    out.on("data", onChunk(true));
    err.on("data", onChunk(false));
    this.docker.modem.demuxStream(stream, out, err);

    const done = new Promise<void>((resolve, reject) => {
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", reject);
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const cutOff = new Promise<"deadline" | "aborted">((resolve) => {
      const deadlineSec = opts.timeoutSec ? opts.timeoutSec + DEADLINE_GRACE_SEC : DEFAULT_EXEC_DEADLINE_SEC;
      timer = setTimeout(() => resolve("deadline"), deadlineSec * 1000);
      onAbort = () => resolve("aborted");
      if (opts.signal?.aborted) onAbort();
      else opts.signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (opts.stdin !== undefined) {
      stream.write(opts.stdin);
      stream.end();
    }
    let cut: "deadline" | "aborted" | null;
    try {
      cut = await Promise.race([done.then(() => null), cutOff]);
    } finally {
      clearTimeout(timer);
      if (onAbort) opts.signal?.removeEventListener("abort", onAbort);
      settled = true;
    }
    const result = (exitCode: number, timedOut: boolean): ExecResult => {
      let output: string | undefined;
      return {
        exitCode,
        // Decoded on first read: callers that only want stdout (file views, listings) skip the copy and the regex.
        get output() {
          return (output ??= stripAnsi(combined.toBuffer().toString("utf8")));
        },
        stdout: stdoutBuf.toBuffer(),
        timedOut,
      };
    };
    if (cut) {
      // Docker has no way to kill an exec, so the host detaches; the process itself may run on inside the box.
      stream.destroy();
      if (cut === "aborted") throw opts.signal!.reason;
      return result(124, true);
    }
    const info = await exec.inspect({ abortSignal: AbortSignal.timeout(10_000) });
    const exitCode = info.ExitCode ?? -1;
    // 137 is any SIGKILL, the OOM killer's included. It's only a timeout once `timeout -k` could have sent it.
    const ranOut = opts.timeoutSec !== undefined && performance.now() - started >= opts.timeoutSec * 1000;
    return result(exitCode, Boolean(opts.timeoutSec) && (exitCode === 124 || (exitCode === 137 && ranOut)));
  }

  /**
   * Runs argv and hands its stdout over as a stream, for output too large to hold in memory (an archive). `stop()`
   * ends it early; `exitCode()` settles once the command is done. The stream fails, instead of ending, when the
   * command exits with more than 1 (tar's 1 means "some file changed or went missing"): a cut-off archive must not
   * look finished. Stderr is kept short, for the error message.
   */
  async streamStdout(cmd: string[], opts: { cwd?: string } = {}): Promise<{ stdout: PassThrough; stop: () => void; exitCode: () => Promise<number>; stderr: () => string }> {
    const exec = await this.container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false, WorkingDir: opts.cwd ?? WORKSPACE });
    const stream = await exec.start({ hijack: true, stdin: false });
    const stdout = new PassThrough();
    const err = new PassThrough();
    let errText = "";
    err.on("data", (c: Buffer) => {
      if (errText.length < 2000) errText += c.toString("utf8");
    });
    this.docker.modem.demuxStream(stream, stdout, err);
    const finished = new Promise<void>((resolve) => {
      stream.on("end", () => resolve());
      stream.on("close", () => resolve());
      stream.on("error", () => resolve());
    });
    const exit = finished.then(async () => (await exec.inspect({ abortSignal: AbortSignal.timeout(10_000) }).catch(() => null))?.ExitCode ?? -1);
    void exit.then((code) => {
      if (code > 1 || code < 0) stdout.destroy(new Error(stripAnsi(errText).trim() || `exited with ${code}`));
      else stdout.end();
    });
    return {
      stdout,
      stop: () => stream.destroy(),
      stderr: () => stripAnsi(errText),
      exitCode: () => exit,
    };
  }

  /**
   * Runs a bash command line inside the box. With `pipefail`, a pipeline fails when any part of it does, so
   * `pip install … | tail` reports pip's failure rather than tail's success.
   */
  sh(command: string, opts: ExecOptions & { pipefail?: boolean } = {}): Promise<ExecResult> {
    const { pipefail, ...rest } = opts;
    return this.exec(pipefail ? ["bash", "-o", "pipefail", "-c", command] : ["bash", "-c", command], rest);
  }

  /** Starts a long-lived command and streams its output until stop() is called. `onEnd` fires once if the stream ends by itself. */
  async follow(cmd: string[], onOutput: (text: string) => void, onEnd?: () => void): Promise<{ stop: () => void }> {
    const exec = await this.container.exec({ Cmd: cmd, AttachStdout: true, AttachStderr: true, Tty: false });
    const stream = await exec.start({ hijack: true, stdin: false });
    const out = new PassThrough();
    const decoder = new TextDecoder();
    out.on("data", (chunk: Buffer) => onOutput(decoder.decode(chunk, { stream: true })));
    this.docker.modem.demuxStream(stream, out, out);
    stream.on("error", () => {});
    let ended = false;
    const end = () => {
      if (ended) return;
      ended = true;
      onEnd?.();
    };
    stream.on("end", end);
    stream.on("close", end);
    return {
      stop: () => {
        stream.destroy();
      },
    };
  }

  // ---------- files ----------

  async readFile(path: string, maxBytes = 512 * 1024, timeoutSec?: number): Promise<{ data: Buffer; size: number; truncated: boolean } | null> {
    const res = await this.exec(
      ["sh", "-c", 'test -f "$1" || exit 3; stat -c %s -- "$1"; head -c "$2" -- "$1"', "_", path, String(maxBytes)],
      { maxBuffer: maxBytes * 2 + 64, timeoutSec },
    );
    if (res.exitCode !== 0) return null;
    const nl = res.stdout.indexOf(0x0a);
    const size = Number(res.stdout.subarray(0, nl).toString());
    const data = res.stdout.subarray(nl + 1);
    return { data, size, truncated: size > data.length };
  }

  async readText(path: string, maxBytes?: number): Promise<string | null> {
    const file = await this.readFile(path, maxBytes);
    return file ? file.data.toString("utf8") : null;
  }

  /**
   * Writes a file without using exec stdin: half-closing a hijacked stdin isn't reliable over Docker Desktop's
   * Windows named pipe, so the content travels base64-encoded in an env var, in chunks under the argv limit. The
   * chunks go into a file beside it that is moved into place at the end, so a dev server watching it never reads half
   * a file, and a chunk that fails (a full disk) leaves the old one whole. The file keeps its mode, and a symlink is
   * written through rather than replaced.
   */
  async writeFile(path: string, content: string | Buffer, timeoutSec?: number): Promise<void> {
    const b64 = Buffer.from(content).toString("base64");
    const CHUNK = 96 * 1024;
    // A name of its own: two writes to one path at once must not share a temp file, or the first move takes it from the second.
    const temp = `${path}.pyrovue-tmp-${randomBytes(4).toString("hex")}`;
    const moveIntoPlace =
      ' && dest=$(readlink -f -- "$1" || printf %s "$1") && { [ ! -e "$dest" ] || chmod --reference="$dest" -- "$2" 2>/dev/null || true; } && mv -f -- "$2" "$dest"';
    let offset = 0;
    try {
      do {
        const part = b64.slice(offset, offset + CHUNK);
        const redirect = offset === 0 ? ">" : ">>";
        const last = offset + CHUNK >= b64.length;
        const res = await this.exec(
          ["sh", "-c", `mkdir -p "$(dirname "$1")" && printf '%s' "$PYRO_B64" | base64 -d ${redirect} "$2"${last ? moveIntoPlace : ""}`, "_", path, temp],
          { env: { PYRO_B64: part }, timeoutSec },
        );
        if (res.exitCode !== 0) throw new Error(`Could not write ${path}: ${res.output.trim() || `exit ${res.exitCode}`}`);
        offset += CHUNK;
      } while (offset < b64.length);
    } catch (err) {
      await this.exec(["rm", "-f", "--", temp]).catch(() => {});
      throw err;
    }
  }

  /**
   * Files git knows about (tracked + untracked-but-not-ignored), relative to the workspace. `includeEnv` adds the
   * dotenv files git ignores (.env, .env.local and so on).
   */
  async listFiles(limit = 20000, { includeEnv = false }: { includeEnv?: boolean } = {}): Promise<string[]> {
    // Room for `limit` long paths: a buffer that fills up keeps the head and tail and quietly drops the middle.
    const maxBuffer = Math.min(64 * 1024 * 1024, Math.max(8 * 1024 * 1024, limit * 160));
    // Dotenv files are looked for at the same time as the list, not after it.
    const [res, envFiles] = await Promise.all([
      this.sh(`git -c core.quotepath=off -C ${WORKSPACE} ls-files -z --cached --others --exclude-standard 2>/dev/null | head -z -n ${limit}`, { maxBuffer }),
      includeEnv ? this.envFiles() : Promise.resolve([]),
    ]);
    // NUL-separated and unquoted: git otherwise writes a non-ASCII name as "caf\303\251" in quotes, which no one can open.
    const files = res.stdout
      .toString("utf8")
      .split("\0")
      .filter(Boolean);
    if (files.length > 0) {
      if (!includeEnv) return files;
      const listed = new Set(files);
      for (const file of envFiles) {
        if (listed.has(file)) continue;
        listed.add(file);
        files.push(file);
      }
      return files;
    }
    const fallback = await this.sh(
      `cd ${WORKSPACE} && find . -type f -not -path '*/node_modules/*' -not -path '*/.git/*' -not -path '*/.venv/*' | sed 's|^\\./||' | head -n ${limit}`,
      { maxBuffer },
    );
    return fallback.stdout.toString("utf8").split("\n").filter(Boolean);
  }

  /**
   * Dotenv files in the top four levels of the workspace, the ones git ignores included (listFiles skips those it has
   * already). find steps over dependency, build and git folders, which git would walk to find an ignored file, and a
   * short deadline means a huge tree lists without them rather than waits.
   */
  private async envFiles(): Promise<string[]> {
    const skip = ["node_modules", ".git", "target", ".venv", "venv", "vendor"].map((d) => `-name ${d}`).join(" -o ");
    const res = await this.sh(
      `cd ${WORKSPACE} && find . -maxdepth 4 \\( ${skip} \\) -prune -o ! -type d \\( -name .env -o -name '.env.*' \\) -print 2>/dev/null | sed 's|^\\./||' | head -n 500`,
      { timeoutSec: 5 },
    );
    if (res.timedOut) return [];
    return res.stdout.toString("utf8").split("\n").filter(Boolean);
  }

  // ---------- networking ----------

  async listeners(): Promise<Listener[]> {
    const res = await this.exec(["cat", "/proc/net/tcp", "/proc/net/tcp6"]);
    // Docker's embedded DNS resolver listens on a random port of 127.0.0.11 in every user-network container; it is not an app.
    return parseListeners(res.stdout.toString("utf8")).filter((l) => l.port !== RELAY_PORT && !(l.family === "4" && l.address === "127.0.0.11"));
  }

  /** Points the relay on RELAY_PORT (published to the host) at a port inside the box. */
  async relayTo(port: number, listeners?: Listener[]): Promise<boolean> {
    const target = relayTarget(listeners ?? (await this.listeners()), port);
    if (!target) return false;
    const dest = target.family === "6" ? `TCP6:[${target.host}]:${port}` : `TCP4:${target.host}:${port}`;
    // Tracked by pid file: a `pkill -f socat…` would match this very shell's command line.
    const pidFile = `${PYRO_DIR}/relay.pid`;
    await this.sh(
      `if [ -f ${pidFile} ]; then kill -- -"$(cat ${pidFile})" 2>/dev/null; rm -f ${pidFile}; sleep 0.1; fi; ` +
        `setsid socat TCP-LISTEN:${RELAY_PORT},fork,reuseaddr ${dest} </dev/null >/dev/null 2>&1 & echo $! > ${pidFile}; sleep 0.2`,
    );
    return this.relayRunning();
  }

  async relayRunning(): Promise<boolean> {
    const res = await this.sh(`test -f ${PYRO_DIR}/relay.pid && kill -0 "$(cat ${PYRO_DIR}/relay.pid)" 2>/dev/null`);
    return res.exitCode === 0;
  }

  /** Makes an HTTP request from inside the box. Returns the status code, or null if nothing answered. */
  async probe(port: number, path = "/"): Promise<number | null> {
    const res = await this.exec(
      ["curl", "-s", "-o", "/dev/null", "-m", "8", "-w", "%{http_code}", `http://localhost:${port}${path}`],
      { timeoutSec: 15 },
    );
    const code = Number(res.stdout.toString().trim());
    return code > 0 ? code : null;
  }

  /**
   * One GET from inside the box that doesn't follow redirects: the status (null when nothing answered), the absolute
   * URL a redirect points to (curl resolves a relative Location), and whether a request that got no answer ran out of
   * time rather than being refused or cut off.
   */
  async request(port: number, path: string, timeoutSec = 8): Promise<PageResponse> {
    const res = await this.exec(
      ["curl", "-s", "-o", "/dev/null", "-m", String(timeoutSec), "-w", "%{http_code} %{redirect_url}", `http://localhost:${port}${path}`],
      { timeoutSec: timeoutSec + 7 },
    );
    const [code, location] = res.stdout.toString().trim().split(/\s+/, 2);
    const status = Number(code);
    // curl exits 28 when -m runs out.
    return { status: status > 0 ? status : null, location: location || null, timedOut: res.exitCode === 28 || res.timedOut };
  }

  // ---------- the app process ----------

  /** Starts the app in its own session so it can be stopped as a group. Output goes to /var/pyro/app.log. */
  async startApp(command: string, opts: { cwd?: string; env?: Record<string, string> } = {}): Promise<void> {
    await this.stopApp();
    const exports = Object.entries(opts.env ?? {})
      .filter(([k]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(k))
      .map(([k, v]) => `export ${k}=${shellQuote(v)}`)
      .join("\n");
    const script = `#!/usr/bin/env bash\ncd ${shellQuote(opts.cwd ?? WORKSPACE)}\n${exports}\n${command}\n`;
    await this.writeFile(`${PYRO_DIR}/start.sh`, script);
    // Only setsid is backgrounded (a bare `a && b & echo $!` would background the whole list in a subshell and record
    // that subshell's pid), so app.pid holds the session leader, whose pid is the app's process group.
    const res = await this.sh(
      `mkdir -p ${PYRO_DIR} && : > ${PYRO_DIR}/app.log && ` +
        `{ setsid bash ${PYRO_DIR}/start.sh >> ${PYRO_DIR}/app.log 2>&1 < /dev/null & echo $! > ${PYRO_DIR}/app.pid; }`,
    );
    if (res.exitCode !== 0) throw new Error(`Could not start the app: ${res.output}`);
  }

  async appRunning(): Promise<boolean> {
    const res = await this.sh(`test -f ${PYRO_DIR}/app.pid && kill -0 -- -"$(cat ${PYRO_DIR}/app.pid)" 2>/dev/null`);
    return res.exitCode === 0;
  }

  async stopApp(): Promise<void> {
    await this.sh(
      `if [ -f ${PYRO_DIR}/app.pid ]; then pg="$(cat ${PYRO_DIR}/app.pid)"; ` +
        `kill -TERM -- -"$pg" 2>/dev/null; for i in 1 2 3 4 5 6 7 8 9 10; do kill -0 -- -"$pg" 2>/dev/null || break; sleep 0.3; done; ` +
        `kill -KILL -- -"$pg" 2>/dev/null; rm -f ${PYRO_DIR}/app.pid; fi; true`,
    );
  }

  async appLogTail(lines = 80): Promise<string> {
    const res = await this.sh(`tail -n ${lines} ${PYRO_DIR}/app.log 2>/dev/null`);
    return stripAnsi(res.stdout.toString("utf8"));
  }

  followAppLog(onOutput: (text: string) => void, fromStart: boolean) {
    // tail's own notices ("file truncated", "has appeared") go to stderr; keep them out of the app log.
    return this.follow(
      ["sh", "-c", `mkdir -p ${PYRO_DIR} && touch ${PYRO_DIR}/app.log && exec tail -n ${fromStart ? "+1" : "0"} -F ${PYRO_DIR}/app.log 2>/dev/null`],
      onOutput,
    );
  }
}
