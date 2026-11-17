import { test } from "node:test";
import assert from "node:assert/strict";
import { indexSource } from "../src/chunking.ts";
import { sourceEvidence, modelExcerpts } from "../src/evidence.ts";

async function snapshot(files: Record<string, string>) {
  const indexed = await Promise.all(Object.entries(files).map(async ([file, body]) => indexSource("r", file, body)));
  return { sources: files, definitions: indexed.flatMap(s => s.definitions), ranked: indexed.flatMap(s => s.chunks.map(chunk => ({ chunk, score: 1 }))) };
}
test("a requested large class or method is returned in full, with no chunk length cap", async () => {
  const method = `run() {\n${Array.from({ length: 180 }, (_, i) => `    const item${i} = "${"x".repeat(30)}";`).join("\n")}\n    return true;\n  }`;
  const body = `export class Worker {\n  ${method}\n}\nfunction unrelated() { return false; }`;
  const s = await snapshot({ "src/work.ts": body });
  const whole = sourceEvidence(s, "Show the Worker class", s.ranked);
  assert.equal(whole.exact, true); assert.equal(whole.evidence.length, 1);
  assert.equal(whole.evidence[0].body, body.slice(0, body.indexOf("\nfunction unrelated")));
  assert.ok(whole.evidence[0].body.length > 9600);
  assert.equal(whole.evidence[0].complete, true);
  const requested = sourceEvidence(s, "Show Worker.run()", []);
  assert.equal(requested.evidence.length, 1); assert.equal(requested.evidence[0].body, method);
  assert.equal(requested.evidence[0].startLine, 2); assert.equal(requested.evidence[0].endLine, 184);
  assert.equal(requested.evidence[0].symbol, "Worker.run");
  assert.ok(modelExcerpts(requested.evidence).length < 2700);
  assert.match(modelExcerpts(requested.evidence), /partial preview/);
  assert.equal(requested.evidence[0].body, method);
});
test("exact symbol lookup returns all duplicates beyond four, narrowed by file or qualified name", async () => {
  const files = Object.fromEntries(Array.from({ length: 7 }, (_, i) => [`src/file${i}.ts`, `function authorize() { return ${i}; }`]));
  const s = await snapshot(files);
  const all = sourceEvidence(s, "Show authorize", []);
  assert.equal(all.evidence.length, 7);
  assert.ok(all.evidence.every(c => c.complete));
  const single = sourceEvidence(s, "Show authorize from src/file5.ts", []);
  assert.equal(single.evidence.length, 1); assert.equal(single.evidence[0].body, files["src/file5.ts"]);
  const classes = await snapshot({ "auth.ts": "class User { authorize() { return true; } }\nclass Admin { authorize() { return false; } }" });
  assert.equal(sourceEvidence(classes, "show Admin.authorize", []).evidence[0].body, "authorize() { return false; }");
  assert.deepEqual(sourceEvidence(classes, "show authorize in Admin", []).evidence.map(c => c.symbol), ["Admin.authorize"]);
  assert.equal(sourceEvidence(classes, "show User.missing", []).evidence.length, 0);
});
test("nested Python methods include decorators; Unicode and same-line neighbors preserve exact offsets", async () => {
  const py = 'class Auth:\n    @staticmethod\n    def authorize(token):\n        def checked():\n            return token\n        return checked()\n';
  const s = await snapshot({ "auth.py": py, "same.ts": 'const café = "🌳"; function alpha() { return "é"; } function beta() {}' });
  const auth = sourceEvidence(s, "show Auth.authorize", []);
  assert.equal(auth.evidence[0].body, py.slice(py.indexOf("@staticmethod")).trimEnd());
  assert.deepEqual(sourceEvidence(s, "show Auth.authorize.checked", []).evidence.map(c => c.body), ["def checked():\n            return token"]);
  assert.equal(sourceEvidence(s, "show alpha", []).evidence[0].body, 'function alpha() { return "é"; }');
  assert.equal(sourceEvidence(s, "show beta", []).evidence[0].body, 'function beta() {}');
});
test("exported arrow functions, anonymous function bindings and C function names resolve", async () => {
  const s = await snapshot({ "auth.ts": "export const authorize = (token: string) => { return token; };\nconst check = function () { return true; };", "auth.c": "int validate(int token) { return token; }" });
  assert.equal(sourceEvidence(s, "show authorize", []).evidence[0].body, s.sources["auth.ts"].split("\n")[0]);
  assert.equal(sourceEvidence(s, "show check", []).evidence[0].body, s.sources["auth.ts"].split("\n")[1]);
  assert.equal(sourceEvidence(s, "show validate", []).evidence[0].body, s.sources["auth.c"]);
});
test("generic retrieval expands and deduplicates large declarations; fallbacks never claim full code", async () => {
  const s = await snapshot({ "big.ts": `function big() {\n${"  console.log('text');\n".repeat(160)}}`, "bad.py": "def broken(", "README.md": "# Project" });
  const found = sourceEvidence(s, "logging behavior", s.ranked);
  assert.equal(found.exact, false);
  assert.equal(found.evidence.filter(c => c.symbol === "big").length, 1);
  assert.equal(found.evidence.find(c => c.path === "big.ts")?.body, s.sources["big.ts"]);
  assert.equal(found.evidence.find(c => c.path === "bad.py")?.complete, false);
  const legacy = sourceEvidence({}, "big", s.ranked.slice(0, 1));
  assert.equal(legacy.exact, false); assert.equal(legacy.evidence[0].complete, false);
});
test("file qualification distinguishes duplicate basenames and unknown paths", async () => {
  const s = await snapshot({ "one/auth.ts": "function check() { return 1; }", "two/auth.ts": "function check() { return 2; }", "one/auth.tsx": "function check() { return 3; }" });
  assert.deepEqual(sourceEvidence(s, "show check in one/auth.ts", []).evidence.map(c => c.path), ["one/auth.ts"]);
  assert.deepEqual(sourceEvidence(s, "show check in auth.ts", []).evidence.map(c => c.path), ["one/auth.ts", "two/auth.ts"]);
  assert.equal(sourceEvidence(s, "show check in missing/auth.ts", []).evidence.length, 0);
});
test("a missing explicit symbol does not substitute a related class or function", async () => {
  const s = await snapshot({ "auth.ts": "class Auth { authorize() {} }" });
  for (const question of ["show Auth.missing()", "show class Missing", "show function missing", "show Auth.missing"]) {
    assert.deepEqual(sourceEvidence(s, question, s.ranked).evidence, []);
  }
});
