<div align="center">

# Pyrovue Runner

**Run any Git repository with one command. No Dockerfile, no devcontainer, no setup guide.**

Point it at a GitHub or GitLab link. It starts a disposable Docker box, reads the repo's own files to work out how to
install and start it, fixes the common errors on the way, and hands you a live preview on `localhost`.

[![Run on pyrovue](https://pyrovue.com/badge.svg)](https://pyrovue.com/github.com/pyroenv/pyrovue-runner?ref=badge)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

</div>

```text
$ pyrovue-run satnaing/astro-paper

Running satnaing/astro-paper

✓ Starting a box · pyrovue-run-satnaing-astro-paper-66587d
✓ Cloning · 217c4e3
✓ Reading the repo · 153 files · Astro app using pnpm.
✓ Installing
✓ Starting the app · port 4321

✓ It's running: http://localhost:32770
  The app listens on port 4321 inside the box. Press Ctrl+C to stop.
```

Press Ctrl+C and the box is gone. Nothing was installed on your machine.

## Why

Trying someone else's project usually goes like this: clone it, install dependencies, hit an error about a missing
native library or the wrong Node version, search for it, give up twenty minutes later without ever seeing it run.

Pyrovue Runner does that work for you, in a box you can throw away:

- **No config needed.** It reads what the repo already has: `package.json`, lockfiles, `pyproject.toml`,
  `requirements.txt`, `Gemfile`, `go.mod`, `Cargo.toml`, `pom.xml`, Dockerfiles, `docker-compose.yml`,
  devcontainers, Procfiles, Makefiles, hosting configs and even the commands in the README.
- **It fixes things as it goes.** 34 repair rules recognise common failures from their output (a missing system
  library, the wrong runtime version, a pnpm package that wasn't hoisted, a database that needs migrating) and retry
  with the fix.
- **It tries another way when the first one fails.** Every repo gets a ranked list of plans. If the most likely one
  doesn't start, the next one is tried.
- **It gets better on your machine.** Which plans and repairs worked for which kind of project is remembered locally,
  so the next similar repo starts with what worked.
- **It's disposable and fenced in.** Each repo runs in its own container with CPU, memory and process limits. Add
  `--gvisor` for a sandboxed kernel when you're running code you don't trust.

## Quick start

You need **Node 20+** and **Docker** (Docker Desktop on macOS and Windows).

```bash
git clone https://github.com/pyroenv/pyrovue-runner.git
cd pyrovue-runner
npm install
npm link            # puts `pyrovue-run` on your PATH

pyrovue-run gabrielecirulli/2048
```

The first run builds the box image, which takes a few minutes. Every run after that starts in seconds.

### Things to try

```bash
pyrovue-run miguelgrinberg/microblog                         # owner/repo means GitHub
pyrovue-run https://github.com/owner/repo/tree/some-branch   # a branch
pyrovue-run https://gitlab.com/group/project                 # GitLab, nested groups too
pyrovue-run owner/repo --plan                                # only show how it would run it
pyrovue-run owner/repo --shell                               # open a shell in the box when it's ready
pyrovue-run owner/repo -e OPENAI_API_KEY --env-file .env     # pass keys the app needs
pyrovue-run owner/repo --gvisor                              # stronger isolation (needs runsc installed)
```

## What it knows

| | |
| --- | --- |
| **JavaScript / TypeScript** | npm, pnpm, yarn, Bun and Deno. Next.js, Vite, Astro, Nuxt, SvelteKit, Remix, Angular, Gatsby, Docusaurus, VitePress, Eleventy, Storybook, Express, NestJS, Hono and monorepos with a frontend and a backend |
| **Python** | pip, uv and Poetry. Flask, Django, FastAPI, Streamlit, Gradio, MkDocs |
| **Ruby / PHP** | Rails, Sinatra, Laravel |
| **JVM / .NET** | Maven and Gradle (Spring Boot), ASP.NET |
| **Go / Rust** | `go run`, Cargo workspaces |
| **Desktop apps** | Tauri and Electron projects are started by their web frontend |
| **Databases** | Postgres, MySQL, Redis and other services a `docker-compose.yml` or `.env` file asks for are installed and started inside the box where possible |
| **Static sites** | served as they are |
| **Anything else** | the commands in its Dockerfile, devcontainer, Procfile, Makefile or README |

A repo with no web server (a library or a CLI tool) is installed, and `pyrovue-run` opens a shell so you can use it.

## How it works

```text
 repo link
     │
     ▼
 ┌──────────┐   ┌───────────┐   ┌───────────────────────┐   ┌──────────────────────┐   ┌──────────────┐
 │ new box  │──▶│ shallow   │──▶│ read the repo         │──▶│ install + start      │──▶│ preview on   │
 │ (Docker) │   │ clone     │   │ manifests, lockfiles, │   │ best plan first,     │   │ localhost    │
 └──────────┘   └───────────┘   │ Dockerfile, compose,  │   │ repairs on failure,  │   └──────────────┘
                                │ README, Procfile…     │   │ then the next plan   │
                                └───────────────────────┘   └──────────────────────┘
```

1. **The box.** A container from one polyglot image ([`box/Dockerfile`](box/Dockerfile)): Node 22 with npm, pnpm,
   yarn and Bun; Python 3.11 with uv; [mise](https://mise.jdx.dev) for Go, Rust, Ruby, Java, PHP and the rest on
   demand; plus git, build tools, ripgrep and socat.
2. **Reading the repo.** The detector ([`src/pipeline`](src/pipeline)) collects evidence from the repo's files and
   turns it into plans: the folder to run in, the install commands, the start command, the port and the env it needs.
   Each plan carries a prior, how likely it is to work given the evidence.
3. **Ranking.** Plans and repair rules are ranked by a Beta posterior: the evidence prior counts as a few
   observations, and every real outcome on your machine adds a success or a failure. Outcomes from other projects in
   the same language count for half. No sampling, so the same history always gives the same order.
4. **Install and start.** Commands run in the box with live output. A failure is matched against the repair rules
   ([`src/pipeline/repairs.ts`](src/pipeline/repairs.ts)); a fix is applied and the step retried. When a plan
   still fails, the next one is tried, within a time budget.
5. **Is it really up?** The app counts as running only when it opens a port and answers HTTP without a server error
   (a crash on the login page it redirects to counts as a failure). The port is found from `/proc/net/tcp`, the
   app's own log and a probe.
6. **The preview.** Dev servers often listen on `localhost` only, which can't be reached from outside a container.
   A small `socat` relay in the box forwards to the app's port, and only that relay is published, on `127.0.0.1`.

## Make your repo run perfectly: `pyrovue.json`

Detection handles most repos. For full control, add a `pyrovue.json` at the root of your repo and it's used instead
of guessing:

```json
{
  "setup": ["pnpm install", "pnpm db:migrate"],
  "start": "pnpm dev",
  "port": 3000,
  "env": { "DATABASE_URL": "file:./dev.db" },
  "cwd": ".",
  "previewPath": "/"
}
```

A frontend with a backend declares the backend as a service, which starts before the frontend:

```json
{
  "setup": ["cd /workspace/backend && pip install -r requirements.txt", "npm install"],
  "services": [{ "cwd": "backend", "start": "uvicorn main:app --port 8000", "port": 8000 }],
  "cwd": "frontend",
  "start": "npm run dev",
  "port": 5173
}
```

The same file works on [pyrovue.com](https://pyrovue.com).

## The Run on Pyrovue button

Don't want people to install anything? [Pyrovue](https://pyrovue.com) runs this engine in the cloud: anyone can open
your repo in a browser with a live preview, a terminal and an editor, share it with a link, and an AI agent takes
over for the rare repo the detector can't handle.

Add the button to your README:

[![Run on pyrovue](https://pyrovue.com/badge.svg)](https://pyrovue.com/github.com/pyroenv/pyrovue-runner?ref=badge)

```markdown
[![Run on pyrovue](https://pyrovue.com/badge.svg)](https://pyrovue.com/github.com/OWNER/REPO?ref=badge)
```

```html
<a href="https://pyrovue.com/github.com/OWNER/REPO?ref=badge"><img src="https://pyrovue.com/badge.svg" alt="Run on pyrovue" width="132" height="28"></a>
```

Replace `OWNER/REPO` with your repository. GitLab projects work too: `https://pyrovue.com/gitlab.com/GROUP/PROJECT`.
You can also make one at [pyrovue.com/button](https://pyrovue.com/button).

## Options

| Option | What it does |
| --- | --- |
| `-b, --branch <name>` | Branch or tag to run |
| `-p, --port <port>` | Port on your machine for the preview (default: a free one) |
| `-e, --env KEY=VALUE` | Pass a variable to the app; `-e KEY` takes it from your shell. Repeat for more |
| `--env-file <file>` | Pass every variable in a dotenv file |
| `--plan` | Only show how the repo would be run; install nothing |
| `--shell` | Open a shell in the box once it's ready |
| `--open` | Open the preview in your browser |
| `--keep` | Keep the box when you exit (remove it later with `docker rm -f <name>`) |
| `--gvisor` | Run the box on [gVisor](https://gvisor.dev) (`runsc` must be installed and registered with Docker) |
| `--runtime <name>` | Use another Docker runtime |
| `--cpus <n>` | CPU limit (default: 2) |
| `--memory <mb>` | Memory limit in MB (default: 4096) |
| `--timeout <min>` | Give up on install and start after this long (default: 20) |
| `--image <name>` | Use your own box image |
| `--no-learn` | Don't read or record what worked on this machine |
| `-q, --quiet` | Hide install output |

Values you pass with `-e` and `--env-file` go into the box's environment and are never printed.

## Security

Running a stranger's repository means running their code. Each box is a container with:

- 2 CPUs, 4 GB of memory, no swap and 2,048 processes by default
- `no-new-privileges`, and `NET_RAW`, `MKNOD`, `AUDIT_WRITE`, `SYS_CHROOT` and `SETFCAP` dropped
- only the preview relay published, and only on `127.0.0.1`, so nothing in the box is reachable from your network
- none of your files mounted: the repo is cloned inside the box, and nothing of yours goes in unless you pass it with `-e`

A container shares your machine's kernel. For code you don't trust, install [gVisor](https://gvisor.dev/docs/user_guide/install/)
and add `--gvisor`, which puts a user-space kernel between the repo and your machine. Installs are slower on gVisor,
but the box is much harder to escape.

## Development

```bash
npm install
npm test             # 450+ tests: detection, evidence readers, repairs, ranking, the run loop with a scripted box
npm run typecheck
npm run dev -- owner/repo   # run the CLI from source
npm run box:build           # build the box image yourself
```

```text
src/
  cli.ts            the command line
  run.ts            one run: box, clone, analyze, install, start, preview
  docker.ts         creating and removing boxes
  repo.ts           reading GitHub, GitLab and git links
  learning.ts       what worked on this machine (~/.cache/pyrovue-runner)
  pipeline/
    evidence/       readers for each kind of file a repo can tell us something with
    stacks/         Java, .NET and desktop-app specifics
    detect.ts       evidence to plans
    candidates.ts   alternative plans, with their priors
    repairs.ts      the repair rules
    ranking.ts      the Beta-posterior ranking
    heuristic.ts    install, start, repair, retry
    launch.ts       starting the app and deciding whether it's really up
  sandbox/
    box.ts          running commands in a box, the preview relay
    procnet.ts      reading listening ports from /proc
box/                the box image
test/
```

## Contributing

Found a repo it can't run? Run it with `--plan` and open an issue with the link and the output. Pull requests that
add a repair rule or teach the detector a new framework are very welcome. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
