import { describe, expect, it } from "vitest";
import { detect } from "../../src/pipeline/detect";

const snap = (contents: Record<string, string>, extra: string[] = []) => ({ files: [...Object.keys(contents), ...extra], contents });
const workspace = (members: string[], extra: string[]) =>
  snap({ "Cargo.toml": `[workspace]\nmembers = [${members.map((m) => JSON.stringify(m)).join(", ")}]\n` }, extra);

describe("detect: Cargo workspace members", () => {
  it("still matches glob members against program folders", () => {
    const plan = detect(workspace(["crates/*"], ["crates/api/Cargo.toml", "crates/api/src/main.rs", "crates/lib/Cargo.toml", "crates/lib/src/lib.rs"]));
    expect(plan.start).toBe("cargo run --manifest-path crates/api/Cargo.toml");
  });

  it("matches a star in the middle of a member name", () => {
    const plan = detect(workspace(["services/*-api"], ["services/user-api/src/main.rs", "services/worker/src/main.rs"]));
    expect(plan.start).toBe("cargo run --manifest-path services/user-api/Cargo.toml");
  });

  it("finishes fast on a member with many consecutive stars", () => {
    const dir = "a".repeat(40);
    const t0 = Date.now();
    detect(workspace([`a${"*".repeat(30)}x`], [`${dir}/src/main.rs`]));
    expect(Date.now() - t0).toBeLessThan(500);
  });
});
