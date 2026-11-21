import { describe, expect, it } from "vitest";
import { nodeMajorFor, pythonFor } from "../../src/pipeline/repairs";

describe("nodeMajorFor reads operators followed by a space", () => {
  it("leaves the default Node alone for '>= 18' as it does for '>=18'", () => {
    expect(nodeMajorFor(">=18")).toBeNull();
    expect(nodeMajorFor(">= 18")).toBeNull();
    expect(nodeMajorFor(">=  18.17.0")).toBeNull();
  });

  it("reads '> 20' as above 20", () => {
    expect(nodeMajorFor("> 20")).toBeNull();
  });

  it("reads '>= 14 < 17' as 14 to 16 and picks the newest", () => {
    expect(nodeMajorFor(">= 14 < 17")).toBe(16);
    expect(nodeMajorFor(">=14 <17")).toBe(16);
  });

  it("reads a pre-release suffix on a bound", () => {
    expect(nodeMajorFor(">= 18.0.0-rc.1")).toBeNull();
  });

  it("still pins a range that excludes 22", () => {
    expect(nodeMajorFor("^18")).toBe(18);
    expect(nodeMajorFor("18.x || 20.x")).toBe(20);
    expect(nodeMajorFor("< 21")).toBe(20);
  });
});

describe("pythonFor reads operators followed by a space", () => {
  it("leaves the default Python alone for '>= 3.9'", () => {
    expect(pythonFor(">=3.9")).toBeNull();
    expect(pythonFor(">= 3.9")).toBeNull();
    expect(pythonFor(">= 3.9, < 4")).toBeNull();
  });

  it("still pins a range that excludes 3.11", () => {
    expect(pythonFor(">=3.8,<3.11")).toBe("3.10");
    expect(pythonFor(">= 3.8, < 3.11")).toBe("3.10");
  });
});
