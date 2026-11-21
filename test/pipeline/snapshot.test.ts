import { describe, expect, it } from "vitest";
import { collectSnapshot, selectKeyFiles } from "../../src/pipeline/snapshot";
import type { Box } from "../../src/sandbox/box";

const turn = () => new Promise((r) => setImmediate(r));

describe("collectSnapshot reads key files", () => {
  it("several at a time, at most 8, and keeps the selection order whatever order they finish in", async () => {
    const files = ["README.md", "package.json", ...Array.from({ length: 12 }, (_, i) => `packages/p${i}/package.json`)];
    const pending: { path: string; resolve: (text: string) => void }[] = [];
    let inFlight = 0;
    let maxInFlight = 0;
    const box = {
      listFiles: async () => files,
      readText: (path: string) =>
        new Promise<string>((resolve) => {
          inFlight++;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push({
            path,
            resolve: (text) => {
              inFlight--;
              resolve(text);
            },
          });
        }),
    };

    let settled = false;
    const p = collectSnapshot(box as unknown as Box).finally(() => {
      settled = true;
    });
    await turn();
    await turn();
    expect(pending.length).toBeGreaterThan(1);
    expect(pending.length).toBeLessThanOrEqual(8);

    // Finish the newest reads first, so later files complete before earlier ones.
    while (!settled) {
      const batch = pending.splice(0).reverse();
      for (const read of batch) read.resolve(`{"name":"${read.path}"}`);
      await turn();
      await turn();
    }
    const snapshot = await p;
    expect(maxInFlight).toBeLessThanOrEqual(8);
    expect(Object.keys(snapshot.contents)).toEqual(selectKeyFiles(files));
    expect(snapshot.contents["README.md"]).toBe('{"name":"/workspace/README.md"}');
  });

  it("skips files that are missing or binary", async () => {
    const box = {
      listFiles: async () => ["README.md", "package.json", "index.html"],
      readText: async (path: string) => (path.endsWith("README.md") ? "# Hi" : path.endsWith("index.html") ? "a\u0000b" : null),
    };
    const snapshot = await collectSnapshot(box as unknown as Box);
    expect(snapshot.contents).toEqual({ "README.md": "# Hi" });
  });
});
