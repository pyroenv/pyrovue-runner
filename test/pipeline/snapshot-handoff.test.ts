import { describe, expect, it } from "vitest";
import { collectSnapshot } from "../../src/pipeline/snapshot";
import type { Box } from "../../src/sandbox/box";

// git ls-files lists paths in byte order, so a cut at 20,000 keeps only an alphabetical prefix of a big repo.
describe("the snapshot of a big repo", () => {
  it("sees files that sort after the first 20,000 paths", async () => {
    const all = [...Array.from({ length: 25_000 }, (_, i) => `addons/m${i}/models.py`), "requirements.txt", "setup.py", "yarn.lock"].sort(
      (a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)),
    );
    const box = {
      listFiles: async (limit = 20_000) => all.slice(0, limit),
      readText: async (file: string) => (/\/(requirements\.txt|setup\.py)$/.test(file) ? "x" : null),
    };
    const snapshot = await collectSnapshot(box as unknown as Box);
    expect(snapshot.files).toHaveLength(25_003);
    expect(snapshot.files).toContain("yarn.lock");
    expect(snapshot.contents["requirements.txt"]).toBeDefined();
  });
});
