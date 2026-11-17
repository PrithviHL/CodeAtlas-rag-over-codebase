import { test } from "node:test";
import assert from "node:assert/strict";
import { chunkSource } from "../src/chunking.ts";

const fixtures = [
  ["ts", "export function authorize(token: string) { return token; }", "authorize", "typescript"],
  ["tsx", "export function View() { return <div>Hello</div>; }", "View", "tsx"],
  ["js", "export const authorize = token => token;", "authorize", "javascript"],
  ["jsx", "function View() { return <div />; }", "View", "javascript"],
  ["py", "@checked\ndef authorize(token):\n    return token", "authorize", "python"],
  ["go", "package auth\nfunc authorize() bool { return true }", "authorize", "go"],
  ["rs", "pub fn authorize() -> bool { true }", "authorize", "rust"],
  ["java", "class Auth { boolean authorize() { return true; } }", "Auth", "java"],
  ["rb", "def authorize(token)\n  token\nend", "authorize", "ruby"],
  ["c", "int authorize(int token) { return token; }", "authorize", "cpp"],
  ["cpp", "class Auth {};", "Auth", "cpp"],
  ["h", "struct Auth { int token; };", "Auth", "cpp"],
  ["sh", "authorize() { echo yes; }", "authorize", "bash"],
  ["css", ".auth { color: red; }", ".auth", "css"],
];
for (const [ext, body, name, language] of fixtures) {
  test(`bundled ${ext} grammar finds declarations with exact citations`, async () => {
    const result = await chunkSource("owner/repo", `auth.${ext}`, body + "\n");
    assert.ok(result.some(c => c.symbol.includes(name)), JSON.stringify(result));
    assert.ok(result.every(c => c.strategy === `tree-sitter-${language}`));
    for (const c of result) {
      assert.equal(c.body, body.split("\n").slice(c.startLine - 1, c.endLine).join("\n"));
    }
  });
}
test("preserves Unicode, decorators, exports, imports and gaps between distinct symbols", async () => {
  const source = '// café 🌳\nimport { check } from "auth";\n\nexport function alpha() { return "é"; }\n\n// keep this comment\nexport function beta() { return check(); }\n';
  const result = await chunkSource("r", "auth.ts", source);
  assert.deepEqual(result.filter(c => c.symbol !== "auth.ts").map(c => c.symbol), ["alpha", "beta"]);
  for (const c of result) assert.equal(c.body, source.split("\n").slice(c.startLine - 1, c.endLine).join("\n"));
  for (const line of source.split("\n").filter(s => s.trim())) assert.ok(result.some(c => c.body.includes(line)));
});
test("oversized declarations keep the symbol, bounds, overlap and every source line", async () => {
  const source = `function huge() {\n${Array.from({ length: 160 }, (_, i) => `  const item${i} = ${i};`).join("\n")}\n}`;
  const result = await chunkSource("r", "big.js", source);
  assert.ok(result.length > 2);
  assert.ok(result.every(c => c.symbol === "huge" && c.body.length <= 2400 && c.endLine - c.startLine < 60));
  assert.ok(result[1].startLine <= result[0].endLine);
  for (const line of source.split("\n")) assert.ok(result.some(c => c.body.includes(line)));
});
test("invalid syntax and unsupported formats fall back without losing text", async () => {
  for (const [file, body, strategy] of [["bad.py", "def broken(", "syntax-error-window"], ["README.md", "# Project\nDescription", "text-window"], ["View.vue", "<template>Hello</template>", "text-window"]]) {
    const result = await chunkSource("r", file, body);
    assert.equal(result[0].strategy, strategy); assert.equal(result[0].body, body);
  }
  const long = await chunkSource("r", "long.json", "x".repeat(7500));
  assert.ok(long.every(c => c.body.length <= 2400 && c.startLine === 1 && c.endLine === 1));
  assert.equal(long.map(c => c.body).join(""), "x".repeat(7500));
  assert.deepEqual(await chunkSource("r", "empty.ts", "\n  \n"), []);
});
test("concurrent imports share grammar initialization without sharing parser state", async () => {
  const results = await Promise.all(Array.from({ length: 12 }, (_, i) => chunkSource("r", "file.ts", `function item${i}() {}`)));
  results.forEach((result, i) => assert.equal(result[0].symbol, `item${i}`));
});
