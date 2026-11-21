import { describe, expect, it } from "vitest";
import { parseCompose } from "../../src/pipeline/evidence/compose";

const envOf = (environment: string) => {
  const info = parseCompose(`services:\n  web:\n    build: .\n    ports:\n      - "3000:3000"\n    environment:\n${environment}\n`);
  return info?.services[0]?.env ?? {};
};

describe("compose environment values keep their written text", () => {
  it("keeps a trailing zero in a version", () => {
    expect(envOf("      PYTHON_VERSION: 3.10\n      V: 1.0")).toMatchObject({ PYTHON_VERSION: "3.10", V: "1.0" });
  });

  it("keeps an 18-digit id exactly", () => {
    expect(envOf("      GUILD_ID: 123456789012345678")).toMatchObject({ GUILD_ID: "123456789012345678" });
  });

  it("keeps yes, on, no and off as written", () => {
    expect(envOf("      A: yes\n      B: on\n      C: no\n      D: off")).toMatchObject({ A: "yes", B: "on", C: "no", D: "off" });
  });

  it("still reads ordinary integers, booleans and quoted values", () => {
    expect(envOf("      PORT: 8080\n      DEBUG: true\n      Q: '3.10'\n      OFF: false")).toMatchObject({ PORT: "8080", DEBUG: "true", Q: "3.10", OFF: "false" });
  });

  it("reads list-form environment entries as written", () => {
    const info = parseCompose("services:\n  web:\n    build: .\n    environment:\n      - PYTHON_VERSION=3.10\n      - DEBUG=yes\n");
    expect(info?.services[0]?.env).toMatchObject({ PYTHON_VERSION: "3.10", DEBUG: "yes" });
  });
});
