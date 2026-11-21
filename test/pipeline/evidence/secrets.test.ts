import { beforeAll, describe, expect, it } from "vitest";
import { dockerEvidence } from "../../../src/pipeline/evidence/dockerfile";
import { procfileEvidence } from "../../../src/pipeline/evidence/procfile";
import { looksSecret, redact } from "../../../src/pipeline/evidence/shell";

// Sized so a quadratic scan takes most of a second, rather than the minutes a 48 KB line would.
const RUN = "a-".repeat(8000);
const elapsed = (fn: () => void) => {
  const s = performance.now();
  fn();
  return performance.now() - s;
};

describe("credential checks run in linear time", () => {
  // The first call compiles every pattern on the path; only the pathological input should be timed.
  beforeAll(() => {
    looksSecret("K=x a-b");
    redact("echo a-b");
    procfileEvidence("web: npm start\n", { files: new Set(), file: "Procfile" });
    dockerEvidence("FROM node:20\nRUN npm ci\nCMD npm start\n", { files: new Set(), dir: ".", name: "Dockerfile" });
  });
  it("looksSecret on a long run of word characters and hyphens", () => {
    expect(elapsed(() => looksSecret(`K=x ${RUN}`))).toBeLessThan(200);
  });

  it("redact on a long run of word characters and hyphens", () => {
    expect(elapsed(() => redact(`echo ${RUN}`))).toBeLessThan(200);
  });

  it("a Procfile or Dockerfile with one long command", () => {
    expect(elapsed(() => procfileEvidence(`web: echo ${RUN}\n`, { files: new Set(), file: "Procfile" }))).toBeLessThan(200);
    expect(elapsed(() => dockerEvidence(`FROM node:20\nRUN echo ${RUN}\n`, { files: new Set(), dir: ".", name: "Dockerfile" }))).toBeLessThan(200);
  });
});

describe("credential checks catch the same things", () => {
  it("finds a credential after a name made only of hyphens", () => {
    expect(looksSecret("foo - : api_key=abcdefghijklmnop")).toBe(true);
    expect(looksSecret("run -- : TOKEN=abcd1234efgh5678")).toBe(true);
    expect(redact("run -- : TOKEN=abcd1234efgh5678")).toBe("run -- : TOKEN=***");
  });

  it("masks flags and plain assignments, and leaves placeholders and variables alone", () => {
    expect(redact("--api-key=abcd1234efgh5678ijkl")).toBe("--api-key=***");
    expect(redact("curl -H 'X: 1' --token abcd1234efgh5678 API_KEY=abcd1234efgh5678 x")).toBe("curl -H 'X: 1' --token abcd1234efgh5678 API_KEY=*** x");
    expect(redact("SECRET_KEY=changeme PASSWORD=$DB_PASSWORD npm start")).toBe("SECRET_KEY=changeme PASSWORD=$DB_PASSWORD npm start");
    expect(looksSecret("SECRET_KEY=changeme python app.py")).toBe(false);
    expect(looksSecret("DB_PASSWORD: 'hunter2hunter2'")).toBe(true);
    expect(looksSecret("npm run build -- --mode=production-ready")).toBe(false);
  });
});
