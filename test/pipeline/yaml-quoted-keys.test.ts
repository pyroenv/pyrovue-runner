import { describe, expect, it } from "vitest";
import { parseYaml } from "../../src/pipeline/evidence/yaml";

/**
 * Every expectation here is what the parser read before the audit's rewrite (commit 5fb0326) returned for the same
 * text, so a quoted key keeps meaning what it always meant.
 */
const CASES: Array<[string, string, unknown]> = [
  ["double-quoted keys at the top", '"web": 1\n"db": 2', { web: 1, db: 2 }],
  ["single-quoted keys with a space and a colon", "'a b': x\n'c:d': y", { "a b": "x", "c:d": "y" }],
  ["quoted service names (docker-compose)", "services:\n  \"web\":\n    command: x\n  'db':\n    image: postgres\n", { services: { web: { command: "x" }, db: { image: "postgres" } } }],
  ["quoted environment names", "env:\n  \"KEY\": value\n  \"OTHER KEY\": \"quoted value\"\n  'single': 'it''s'", { env: { KEY: "value", "OTHER KEY": "quoted value", single: "it's" } }],
  ["escaped quote and backslash inside a key", '"a\\"b": 1\n"c\\\\": 2\n"d:e": 3', { 'a"b': 1, "c\\": 2, "d:e": 3 }],
  ["space before the colon", '"key" : spaced\n"k2"   :   many', { key: "spaced", k2: "many" }],
  ["a quoted key that opens a block", '"empty":\n  nested: 1', { empty: { nested: 1 } }],
  ["a comment after a quoted pair", "\"a\": \"b\"  # comment\n'c': 'd'", { a: "b", c: "d" }],
  [
    "a compose file with quoted environment keys and ports",
    'services:\n  web:\n    image: nginx\n    ports:\n      - "80:80"\n      - \'443:443\'\n    environment:\n      "FOO": bar\n      BAZ: "qux"\n  db:\n    image: postgres\n    environment:\n      - POSTGRES_PASSWORD=x\n',
    { services: { web: { image: "nginx", ports: ["80:80", "443:443"], environment: { FOO: "bar", BAZ: "qux" } }, db: { image: "postgres", environment: ["POSTGRES_PASSWORD=x"] } } },
  ],
  [
    "a GitHub workflow step with a quoted env key",
    'name: CI\njobs:\n  build:\n    steps:\n      - uses: actions/checkout@v4\n      - name: Run\n        run: |\n          npm ci\n        env:\n          "NODE_ENV": test\n',
    { name: "CI", jobs: { build: { steps: [{ uses: "actions/checkout@v4" }, { name: "Run", run: "npm ci\n", env: { NODE_ENV: "test" } }] } } },
  ],
  ["quoted task names (Taskfile)", "version: '3'\ntasks:\n  \"build\":\n    cmds:\n      - go build\n  'test:unit':\n    cmds:\n      - go test ./...\n", { version: "3", tasks: { build: { cmds: ["go build"] }, "test:unit": { cmds: ["go test ./..."] } } }],
  ["a list of maps with quoted keys", "- \"a\": 1\n  \"b\": 2\n- 'c': 3", [{ a: 1, b: 2 }, { c: 3 }]],
  ["a merge from a map with quoted keys", 'anchors:\n  base: &base\n    "k": v\nuse:\n  <<: *base\n  "extra": 1', { anchors: { base: { k: "v" } }, use: { k: "v", extra: 1 } }],
];

describe("parseYaml reads quoted map keys", () => {
  for (const [name, text, want] of CASES) it(name, () => expect(parseYaml(text)).toEqual(want));

  it("reads the same document the same way twice in a row (no state left in a regex between calls)", () => {
    const text = '"web": 1\n"db": 2';
    expect(parseYaml(text)).toEqual(parseYaml(text));
  });
});

describe("parseYaml on a hostile line", () => {
  const time = (f: () => unknown) => {
    const t = performance.now();
    f();
    return performance.now() - t;
  };
  const ws = [" ", "\t", " \t"];
  for (const w of ws) {
    const run = w.repeat(100_000);
    for (const [name, text] of [
      ["a quoted key then whitespace then a letter", `"a"${run}b`],
      ["an unterminated quoted key", `"a${run}b`],
      ["a plain key then whitespace then a letter", `a${run}b`],
      ["a value with whitespace before a comment mark", `k: a${run}#`],
      ["a quoted key with backslashes", `"${"\\a".repeat(100_000)}`],
    ] as const) {
      it(`${name} (${JSON.stringify(w)}) is read in well under a second`, () => {
        expect(time(() => parseYaml(`x:\n  ${text}\n  ${text}\n`))).toBeLessThan(300);
      });
    }
  }
});
