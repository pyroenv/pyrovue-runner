import type { Box } from "../sandbox/box";
import { type Listener, portsFromLogs } from "../sandbox/procnet";
import { withoutFlaskDebugger } from "./plan";

export interface LaunchSpec {
  command: string;
  cwd: string;
  env: Record<string, string>;
  /** The port we expect; any newly opened port is still accepted. */
  port: number | null;
  previewPath: string | null;
  /**
   * Ports of the plan's background services (a frontend's backend): the preview never relays to them. Without it (a
   * restart or a replayed setup, which have only the command) they are read from the start command instead.
   */
  ignorePorts?: number[];
}

export interface LaunchOptions {
  timeoutSec?: number;
  signal?: AbortSignal;
  /**
   * Also check the page a redirect from the landing path leads to (a "/" that sends a visitor to /login): a 5xx there,
   * or a connection it drops, fails the launch, so a setup doesn't call an app that crashes on its first page running.
   */
  verify?: boolean;
}

export interface LaunchResult {
  ok: boolean;
  port: number | null;
  httpStatus: number | null;
  reason: string | null;
  logTail: string;
  listeners: Listener[];
}

const PREFERRED = [3000, 5173, 8000, 8080, 4321, 5000, 4200, 8501, 7860, 1234, 8888, 4000, 6006, 3001, 5174, 8081];
const NOT_THE_APP = new Set([9229, 9230, 35729, 24678, 5037]);

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason ?? new Error("aborted"));
    const onAbort = () => {
      clearTimeout(t);
      reject(signal!.reason ?? new Error("aborted"));
    };
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

/**
 * The ports a start command gives its background services, `(cd /workspace/api && PORT=8080 go run .) & npm run dev`
 * as candidates.ts writes it. A restart or a replayed setup has only the command, not the plan's services.
 */
export function backgroundPorts(command: string): number[] {
  return [...command.matchAll(/\((?:cd \S+ && )?PORT=(\d{2,5}) [^()]*\) &(?!&)/g)].map((m) => Number(m[1]));
}

export function rankPorts(candidates: number[], expected: number | null, fromLogs: number[]): number[] {
  const unique = [...new Set(candidates)].filter((p) => !NOT_THE_APP.has(p));
  const score = (p: number) => {
    if (p === expected) return 0;
    const logIdx = fromLogs.indexOf(p);
    if (logIdx >= 0) return 1 + logIdx / 100;
    const prefIdx = PREFERRED.indexOf(p);
    if (prefIdx >= 0) return 2 + prefIdx / 100;
    return 3 + p / 100000;
  };
  return unique.sort((a, b) => score(a) - score(b));
}

const REDIRECTS = new Set([301, 302, 303, 307, 308]);
/** A gateway's answer while what it fronts is still starting: worth waiting out, unlike an app's own 500. */
const GATEWAY = new Set([502, 503, 504]);
const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]", "0.0.0.0"]);

/** A dev server saying it built cleanly: errors printed before the last of these were fixed by a later rebuild. */
const BUILT = /compiled successfully|✓ compiled|ready in \d+(?:\.\d+)? ?m?s|build succeeded/gi;
/** A dev server saying a build failed, most telling first: webpack (Next, Docusaurus, Create React App) and Vite. */
const BUILD_ERRORS = [
  /Module not found: (?:Error: )?Can't resolve '[^'\n]+'[^\n]*/,
  /\[vite\] (?:Internal server error|Pre-transform error): [^\n]*/,
  /Failed to resolve import "[^"\n]+"[^\n]*/,
  /Failed to compile\.?/,
  /Compiled with (?:some )?errors?[^\n]*|compiled with \d+ errors?[^\n]*/i,
];

/**
 * The first build error a dev server printed since it last built cleanly, or null. A page can answer 200 while every
 * page's code failed to build: Docusaurus serves its shell and shows "Cannot find module" in the browser.
 */
export function buildFailure(log: string): string | null {
  let since = 0;
  for (const m of log.matchAll(BUILT)) since = m.index! + m[0].length;
  const recent = log.slice(since);
  for (const re of BUILD_ERRORS) {
    const m = re.exec(recent);
    if (m) return m[0].trim().slice(0, 300);
  }
  return null;
}

/** The path a redirect to `location` lands on, when it stays on the app (same port, plain HTTP); null otherwise. */
export function sameOriginPath(location: string | null, port: number): string | null {
  if (!location) return null;
  let url: URL;
  try {
    url = new URL(location);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname) || Number(url.port || 80) !== port) return null;
  return `${url.pathname}${url.search}`;
}

interface Landing {
  /** Where the redirect led. */
  path: string;
  status: number | null;
  /** Why the page counts as broken: it answered 5xx, or dropped the connection without answering. */
  reason: string;
}

/**
 * Follows one same-origin redirect from `path` and returns the page it lands on when that page is broken; null when
 * there is no such redirect or the page is fine. Two requests: one for the Location, one for the page. A 4xx (a login
 * wall), a 200, another redirect or a page too slow to answer in time all count as fine.
 */
async function brokenLanding(box: Box, port: number, path: string): Promise<Landing | null> {
  const first = await box.request(port, path, 5);
  if (first.status === null || !REDIRECTS.has(first.status)) return null;
  const target = sameOriginPath(first.location, port);
  if (target === null || target === path) return null;
  const page = await box.request(port, target, 8);
  if (page.status !== null && page.status >= 500) {
    return { path: target, status: page.status, reason: `${path} redirects to ${target}, which answered HTTP ${page.status}.` };
  }
  if (page.status === null && !page.timedOut) {
    return { path: target, status: null, reason: `${path} redirects to ${target}, which closed the connection without answering.` };
  }
  return null;
}

/**
 * Starts the app, waits for it to open a port and answer HTTP, then points the preview relay at it.
 * Treats any HTTP response on the landing path (even a 404 or 500) as "up": the preview shows what the app shows. With
 * `verify` (a setup deciding the box runs), the landing page answering 5xx, redirecting to a page that fails (5xx,
 * or a dropped connection), or the dev server reporting a failed build (it may still serve a page), is not up: it is seen twice, a poll apart, to rule out a blip, and a gateway's 502-504
 * (a dev proxy whose backend is still starting) is waited out until the time limit. A 404 or a login wall is up.
 * A `flask run` starts without Werkzeug's debugger, whoever chose the command: the preview is a link people share.
 */
export async function launchApp(box: Box, spec: LaunchSpec, opts: LaunchOptions = {}): Promise<LaunchResult> {
  const timeoutMs = (opts.timeoutSec ?? 150) * 1000;
  opts.signal?.throwIfAborted();
  await box.stopApp();
  const baseline = new Set((await box.listeners()).map((l) => l.port));

  const env: Record<string, string> = { HOST: "0.0.0.0", BROWSER: "none", ...spec.env };
  if (spec.port && !env.PORT) env.PORT = String(spec.port);
  await box.startApp(withoutFlaskDebugger(spec.command), { cwd: spec.cwd, env });

  // A backend that opens its port before the frontend's would otherwise win the relay. The expected port is never
  // ignored, even when a service declares it too.
  const ignored = new Set((spec.ignorePorts ?? backgroundPorts(spec.command)).filter((p) => p !== spec.port));
  const deadline = Date.now() + timeoutMs;
  let listeners: Listener[] = [];
  let silentPort: number | null = null;
  let exitedChecks = 0;
  /** The last broken landing page seen, and on how many polls in a row. */
  let broken: (Landing & { port: number; seen: number }) | null = null;

  while (Date.now() < deadline) {
    await sleep(1500, opts.signal);
    opts.signal?.throwIfAborted();
    listeners = await box.listeners();
    const fresh = listeners.map((l) => l.port).filter((p) => !baseline.has(p) && !ignored.has(p));
    const logTail = await box.appLogTail(200);
    const logPorts = portsFromLogs(logTail).filter((p) => fresh.includes(p));
    const alive = await box.appRunning();

    if (!alive && fresh.length === 0) {
      // Give a just-exited process one more look in case it was a launcher that re-parented a server.
      if (++exitedChecks >= 2) {
        return { ok: false, port: null, httpStatus: null, reason: "The process exited before opening a port.", logTail, listeners };
      }
      continue;
    }
    if (alive) exitedChecks = 0;

    for (const port of rankPorts(fresh, spec.port, logPorts)) {
      const path = spec.previewPath ?? "/";
      const status = await box.probe(port, path);
      if (status !== null) {
        const landing = !opts.verify
          ? null
          : status >= 500
            ? { path, status, reason: `${path} answered HTTP ${status}.` }
            : REDIRECTS.has(status)
              ? await brokenLanding(box, port, path)
              : await brokenBuild(box, path, status, opts.signal);
        if (landing) {
          const seen: number = broken?.port === port && broken.path === landing.path && broken.status === landing.status ? broken.seen + 1 : 1;
          broken = { ...landing, port, seen };
          if (seen >= 2 && !GATEWAY.has(landing.status ?? 0)) return landingFailure(box, broken, listeners);
          // Wait for the next poll rather than relaying to another port: this one is the app's.
          break;
        }
        await box.relayTo(port, listeners);
        return { ok: true, port, httpStatus: status, reason: null, logTail, listeners };
      }
      silentPort ??= port;
    }
  }

  if (broken) return landingFailure(box, broken, listeners);
  const logTail = await box.appLogTail(200);
  const alive = await box.appRunning();
  return {
    ok: false,
    port: silentPort,
    httpStatus: null,
    reason: silentPort
      ? `Port ${silentPort} is open but never answered HTTP.`
      : alive
        ? `The process is running but didn't open a port within ${Math.round(timeoutMs / 1000)}s.`
        : "The process exited before opening a port.",
    logTail,
    listeners,
  };
}

/**
 * The dev server's own word on its build, read just after the page answered (a bundler prints its result once it has
 * built what the page asked for): a failed build is a broken landing, whatever the HTTP status.
 */
async function brokenBuild(box: Box, path: string, status: number, signal?: AbortSignal): Promise<Landing | null> {
  let error = buildFailure(await box.appLogTail(200));
  // Vite reports a failed import only once the page's request has been handled: look again a moment later.
  if (!error) {
    await sleep(1000, signal);
    error = buildFailure(await box.appLogTail(200));
  }
  return error ? { path: `${path} (build)`, status, reason: `its dev server failed to build: ${error}` } : null;
}

/** The app answers, but the page its landing path redirects to fails; the log tail has the error the request left. */
async function landingFailure(box: Box, landing: Landing & { port: number }, listeners: Listener[]): Promise<LaunchResult> {
  return {
    ok: false,
    port: landing.port,
    httpStatus: landing.status,
    reason: `Port ${landing.port} answers, but ${landing.reason}`,
    logTail: await box.appLogTail(200),
    listeners,
  };
}
