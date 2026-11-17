FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY code/ts/package.json ./
RUN npm install --no-audit --no-fund
COPY code/ts/src ./src
COPY code/ts/public ./public
# Exercise the bundled runtime and grammars in the actual Linux/Node 22 image.
RUN node --import tsx --input-type=module <<'JS'
import { chunkSource, indexSource } from "./src/chunking.ts";
import { sourceEvidence } from "./src/evidence.ts";
import assert from "node:assert/strict";
for (const [file, source, language] of [["check.ts", "export function check() {}", "typescript"], ["check.py", "def check():\n    return True", "python"]]) {
  const chunks = await chunkSource("smoke", file, source);
  assert.equal(chunks[0].symbol, "check");
  assert.equal(chunks[0].strategy, `tree-sitter-${language}`);
}
const body = `export class Worker {\n run() {\n${"console.log('full source');\n".repeat(200)}}\n}`;
const indexed = await indexSource("smoke", "worker.ts", body);
const result = sourceEvidence({ sources: { "worker.ts": body }, definitions: indexed.definitions }, "show Worker class", []);
assert.equal(result.evidence[0].body, body);
assert.equal(result.evidence[0].complete, true);
console.log("AST chunking and complete evidence smoke passed");
JS
RUN mkdir data && chown node:node data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm", "start"]
