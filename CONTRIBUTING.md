# Contributing

Thanks for helping more repositories run with one command.

## Reporting a repo that doesn't run

Open an issue with:

- the repository link (and branch, if not the default)
- the output of `pyrovue-run <repo> --plan`
- the end of the output of a full run, where it failed

That is usually enough to tell whether the detector picked the wrong plan or a repair rule is missing.

## Setting up

```bash
npm install
npm test
npm run typecheck
npm run dev -- owner/repo
```

The tests don't need Docker: they run the detector on file snapshots and the run loop against a scripted box.

## Where things live

- **A new framework or tool** usually means a reader in `src/pipeline/evidence/` or a case in `src/pipeline/detect.ts`
  or `src/pipeline/candidates.ts`, with a test in `test/pipeline/` that builds a snapshot of the files and checks the
  plan.
- **A new repair rule** goes in `src/pipeline/repairs.ts`. A rule recognises one failure from the command and its
  output and proposes a fix: commands to run first, a command to retry instead, or env to set. Add a test with the
  real error output in `test/pipeline/repairs.test.ts`.
- **The box image** is `box/Dockerfile`. Keep it to tools most repos need; `mise` installs the rest on demand.

## Ground rules

- Every regular expression that reads repository files must run in linear time: repos are untrusted input.
  `test/pipeline/no-quadratic-whitespace-regex.test.ts` checks for the common mistakes.
- Never print the value of an environment variable; names are fine.
- Keep the box's limits and dropped capabilities as they are unless an issue explains why.
