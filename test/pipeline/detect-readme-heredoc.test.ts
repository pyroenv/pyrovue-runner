import { describe, expect, it } from "vitest";
import { blockCommands } from "../../src/pipeline/evidence/readme";

describe("blockCommands and `<<`", () => {
  it("keeps the commands after a bit shift inside quotes", () => {
    expect(blockCommands(["python3 -c 'print(1 << 2)'", "npm install", "npm run dev"])).toEqual(["python3 -c 'print(1 << 2)'", "npm install", "npm run dev"]);
  });

  it("keeps the commands after a here-string", () => {
    expect(blockCommands(['cat <<< "hello" > x', "npm install", "npm run dev"])).toEqual(['cat <<< "hello" > x', "npm install", "npm run dev"]);
    expect(blockCommands(["grep a <<<hello", "npm start"])).toEqual(["grep a <<<hello", "npm start"]);
  });

  it("keeps the commands after arithmetic outside quotes", () => {
    expect(blockCommands(["echo $((1 << 3))", "npm start"])).toEqual(["echo $((1 << 3))", "npm start"]);
  });

  it("still skips a real heredoc body", () => {
    expect(blockCommands(["cat <<EOF > .env", "PORT=3000", "EOF", "npm start"])).toEqual(["npm start"]);
    expect(blockCommands(["cat <<-'END' > f", "x", "END", "npm install"])).toEqual(["npm install"]);
    expect(blockCommands(['cat << "EOF"', "a", "EOF", "npm run dev"])).toEqual(["npm run dev"]);
  });
});
