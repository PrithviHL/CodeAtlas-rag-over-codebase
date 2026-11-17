FROM node:22-bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends git ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY code/ts/package.json ./
RUN npm install --no-audit --no-fund
COPY code/ts/src ./src
COPY code/ts/public ./public
# Exercise the bundled runtime and grammars in the actual Linux/Node 22 image.
RUN node --import tsx --input-type=module -e 'import { chunkSource } from "./src/chunking.ts"; import assert from "node:assert/strict"; for (const [file, source, language] of [["check.ts", "export function check() {}", "typescript"], ["check.py", "def check():\n    return True", "python"]]) { const chunks = await chunkSource("smoke", file, source); assert.equal(chunks[0].symbol, "check"); assert.equal(chunks[0].strategy, `tree-sitter-${language}`); } console.log("AST chunking smoke passed (TypeScript + Python)");'
RUN mkdir data && chown node:node data
USER node
ENV HOST=0.0.0.0 PORT=3000 DATA_DIR=/app/data
EXPOSE 3000
CMD ["npm", "start"]
