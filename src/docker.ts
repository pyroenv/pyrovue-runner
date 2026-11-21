import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import Docker from "dockerode";
import { Box, PYRO_DIR, RELAY_PORT, WORKSPACE } from "./sandbox/box";

/** Environment every box starts with: tools behave non-interactively and quietly, and nothing phones home. */
export const BASE_ENV: Record<string, string> = {
  PYROVUE: "1",
  TERM: "xterm-256color",
  LANG: "C.UTF-8",
  EDITOR: "nano",
  VISUAL: "nano",
  PAGER: "less",
  LESS: "FRX",
  DEBIAN_FRONTEND: "noninteractive",
  BROWSER: "none",
  HUSKY: "0",
  DO_NOT_TRACK: "1",
  NEXT_TELEMETRY_DISABLED: "1",
  NUXT_TELEMETRY_DISABLED: "1",
  ASTRO_TELEMETRY_DISABLED: "1",
  GATSBY_TELEMETRY_DISABLED: "1",
  STORYBOOK_DISABLE_TELEMETRY: "1",
  COREPACK_ENABLE_DOWNLOAD_PROMPT: "0",
  COREPACK_ENABLE_STRICT: "0",
  npm_config_update_notifier: "false",
  npm_config_fund: "false",
  npm_config_audit: "false",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  PIP_NO_INPUT: "1",
  PYTHONUNBUFFERED: "1",
  PYTHONDONTWRITEBYTECODE: "1",
};

export interface BoxOptions {
  image: string;
  cpus: number;
  memoryMb: number;
  pidsLimit: number;
  /** A Docker runtime such as "runsc" (gVisor); empty for Docker's default. */
  runtime: string;
  /** The port on this machine the preview is published on; 0 picks a free one. */
  hostPort: number;
  /** Extra variables for the app, from --env and --env-file. */
  env: Record<string, string>;
  /** Shown in `docker ps`, so people can tell which repo a box holds. */
  label: string;
}

export interface StartedBox {
  box: Box;
  name: string;
  /** Where the preview can be reached from this machine. */
  hostPort: number;
  remove(): Promise<void>;
}

export function connect(): Docker {
  return new Docker();
}

/** Throws a friendly error when Docker isn't running or can't be reached. */
export async function checkDocker(docker: Docker): Promise<void> {
  try {
    await docker.ping();
  } catch {
    throw new Error("Can't reach Docker. Start Docker Desktop (or the Docker daemon) and try again.");
  }
}

export async function imageExists(docker: Docker, image: string): Promise<boolean> {
  try {
    await docker.getImage(image).inspect();
    return true;
  } catch {
    return false;
  }
}

/** Builds the box image from `contextDir` with the docker CLI, streaming its output. */
export function buildImage(image: string, contextDir: string, onOutput: (text: string) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("docker", ["build", "-t", image, contextDir], { stdio: ["ignore", "pipe", "pipe"] });
    child.stdout.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
    child.stderr.on("data", (b: Buffer) => onOutput(b.toString("utf8")));
    child.on("error", (err) => reject(new Error(`Couldn't run docker build: ${err.message}`)));
    child.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`docker build exited with ${code}`))));
  });
}

/**
 * Creates and starts one box: a container that sleeps until told what to do, with hard limits on CPU, memory and
 * processes, the riskiest Linux capabilities dropped, no way to gain privileges, and only the preview relay published,
 * on 127.0.0.1 alone.
 */
export async function startBox(docker: Docker, opts: BoxOptions): Promise<StartedBox> {
  const slug = opts.label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "repo";
  const name = `pyrovue-run-${slug}-${randomBytes(3).toString("hex")}`;
  const env = { ...BASE_ENV, ...opts.env };
  const container = await docker.createContainer({
    name,
    Image: opts.image,
    Cmd: ["sleep", "infinity"],
    Hostname: "box",
    WorkingDir: WORKSPACE,
    Env: Object.entries(env).map(([k, v]) => `${k}=${v}`),
    Labels: { "pyrovue-runner": "true", "pyrovue-runner.repo": opts.label },
    ExposedPorts: { [`${RELAY_PORT}/tcp`]: {} },
    HostConfig: {
      Init: true,
      Memory: opts.memoryMb * 1024 * 1024,
      MemorySwap: opts.memoryMb * 1024 * 1024,
      NanoCpus: Math.round(opts.cpus * 1e9),
      PidsLimit: opts.pidsLimit,
      SecurityOpt: ["no-new-privileges"],
      CapDrop: ["NET_RAW", "MKNOD", "AUDIT_WRITE", "SYS_CHROOT", "SETFCAP"],
      PortBindings: { [`${RELAY_PORT}/tcp`]: [{ HostIp: "127.0.0.1", HostPort: opts.hostPort ? String(opts.hostPort) : "" }] },
      Runtime: opts.runtime || undefined,
      LogConfig: { Type: "json-file", Config: { "max-size": "1m", "max-file": "1" } },
      RestartPolicy: { Name: "no" },
    },
  });
  const remove = async () => {
    await container.remove({ force: true, v: true }).catch(() => {});
  };
  try {
    await container.start();
    const box = new Box(docker, container.id);
    await box.sh(`mkdir -p ${PYRO_DIR} ${WORKSPACE}`, { cwd: "/" });
    const info = await container.inspect();
    const published = info.NetworkSettings.Ports[`${RELAY_PORT}/tcp`]?.[0]?.HostPort;
    if (!published) throw new Error("Docker didn't publish the preview port.");
    return { box, name, hostPort: Number(published), remove };
  } catch (err) {
    // A container that never became usable is not left behind.
    await remove();
    throw err;
  }
}
