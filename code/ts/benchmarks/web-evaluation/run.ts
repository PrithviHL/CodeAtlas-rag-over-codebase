import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { performance } from "node:perf_hooks";
import ts from "typescript";
import { indexSource } from "../../src/chunking.ts";
import { BM25Index, DenseIndex } from "../../src/index_store.ts";
import { rrf } from "../../src/retrieval.ts";
import { sourceEvidence } from "../../src/evidence.ts";
import { readChunks, Workspace, type Repository } from "../../src/workspace.ts";
import type { Chunk, SourceDefinition, RankedChunk } from "../../src/types.ts";

const root = path.resolve(import.meta.dirname, "../../../..");
const work = path.resolve(process.argv[2] ?? path.join(root, ".runtime/web-evaluation"));
const out = path.resolve(process.argv[3] ?? path.join(import.meta.dirname, "results"));
const manifest = JSON.parse(await fs.readFile(path.join(out, "inputs.json"), "utf8"));
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const read = async (file: string) => JSON.parse(await fs.readFile(path.join(work, file), "utf8"));
const percentile = (items: number[], p: number) => [...items].sort((a, b) => a - b)[Math.max(0, Math.ceil(p * items.length) - 1)] ?? 0;
function times(items: number[]) { return { count: items.length, median_ms: percentile(items, .5), p95_ms: percentile(items, .95), max_ms: Math.max(...items) }; }
const modes = ["window_bm25", "ast_bm25", "ast_hybrid", "web_evidence"] as const;
type Mode = typeof modes[number];
type Row = { language: string; query_id: string; expected: number[]; rank: Record<Mode, number | null>; latency_ms: Record<Mode, number> };
const allRows: Row[] = [];
const summary: any = { target_commit: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  measured_at: new Date().toISOString(), protocol_sha256: hash(await fs.readFile(path.join(import.meta.dirname, "PROTOCOL.md"), "utf8")),
  environment: { node: process.version, os: os.platform(), release: os.release(), arch: os.arch(), cpu: os.cpus()[0].model, logical_cpus: os.cpus().length, ram_bytes: os.totalmem(), public_demo: true, llm_calls: 0 }, dataset_revision: manifest.dataset_revision,
  retrieval: {}, repositories: [], exact_code: {} };
function legacy(repo: string, file: string, source: string): Chunk[] {
  const lines = source.split("\n"), result: Chunk[] = [];
  for (let i = 0; i < lines.length; i += 48) {
    const body = lines.slice(i, i + 60).join("\n");
    if (body.trim()) result.push({ repo, path: file, startLine: i + 1, endLine: Math.min(i + 60, lines.length), symbol: file, summary: file, body });
  }
  return result;
}
function docRank(paths: string[], expected: Set<number>, mapping: Map<string, number>): number | null {
  const unique = [...new Set(paths.map(p => mapping.get(p)!))].slice(0, 10);
  const index = unique.findIndex(id => expected.has(id));
  return index < 0 ? null : index + 1;
}
function metric(rows: Row[], mode: Mode) {
  const ranks = rows.map(r => r.rank[mode]);
  const hit = (k: number) => ranks.filter(r => r !== null && r <= k).length / ranks.length;
  return { queries: rows.length, mrr_at_10: ranks.reduce<number>((s, r) => s + (r ? 1 / r : 0), 0) / ranks.length, hit_at_1: hit(1), hit_at_5: hit(5), hit_at_10: hit(10), latency: times(rows.map(r => r.latency_ms[mode])) };
}
function bootstrap(rows: Row[], baseline: Mode, candidate: Mode) {
  let seed = 20261116;
  const random = () => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 4294967296; };
  const deltas = rows.map(r => (r.rank[candidate] ? 1 / r.rank[candidate]! : 0) - (r.rank[baseline] ? 1 / r.rank[baseline]! : 0));
  const samples: number[] = [];
  for (let j = 0; j < 2000; j++) {
    let sum = 0; for (let i = 0; i < deltas.length; i++) sum += deltas[Math.floor(random() * deltas.length)];
    samples.push(sum / deltas.length);
  }
  return { baseline, candidate, delta_mrr: deltas.reduce((a, b) => a + b, 0) / deltas.length, ci95: [percentile(samples, .025), percentile(samples, .975)], method: "paired query bootstrap; 2,000 resamples; fixed seed 20261116; no multiplicity adjustment" };
}

// Cold/warm repository measurements run before benchmark grammars are loaded.
process.env.PUBLIC_DEMO = "true";
process.env.LLM_MODEL = "";
type Reference = { path: string; symbol: string; qualifiedName: string; body: string; startLine: number; endLine: number; oracle: string };
function tsReferences(sources: Record<string, string>): { references: Reference[]; errors: string[] } {
  const references: Reference[] = [], errors: string[] = [];
  for (const [file, text] of Object.entries(sources)) {
    if (!/\.[jt]sx?$/.test(file)) continue;
    const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    if ((source as any).parseDiagnostics?.length) errors.push(file);
    function visit(node: ts.Node, scope: string[]) {
      const isClass = ts.isClassDeclaration(node) || ts.isClassExpression(node);
      const isFunc = ts.isFunctionDeclaration(node) || (ts.isMethodDeclaration(node) && Boolean(node.body));
      const isVar = ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer));
      const named = isClass || isFunc || isVar ? (node as ts.NamedDeclaration).name : undefined;
      let next = scope;
      if (named && ts.isIdentifier(named)) {
        let boundary = node;
        if (isVar && ts.isVariableDeclarationList(node.parent) && node.parent.declarations.length === 1 && ts.isVariableStatement(node.parent.parent)) boundary = node.parent.parent;
        const start = boundary.getStart(source), end = boundary.getEnd();
        const symbol = named.text, qualifiedName = [...scope, symbol].join(".");
        references.push({ path: file, symbol, qualifiedName, body: text.slice(start, end), startLine: source.getLineAndCharacterOfPosition(start).line + 1, endLine: source.getLineAndCharacterOfPosition(end - 1).line + 1, oracle: "typescript-compiler" });
        next = [...scope, symbol];
      }
      ts.forEachChild(node, child => visit(child, next));
    }
    visit(source, []);
  }
  return { references, errors };
}
const exactRows: any[] = [], negativeRows: any[] = [];
for (const [repoIndex, repo] of manifest.repositories.entries()) {
  const checkout = path.join(work, "repos", repo.repo.replace("/", "__"));
  const trials: any[] = [];
  let corpus: Awaited<ReturnType<typeof readChunks>> | undefined;
  for (let trial = 0; trial < 5; trial++) {
    const started = performance.now();
    corpus = await readChunks(checkout, repo.repo);
    const parsed = performance.now();
    const sparse = new BM25Index(), dense = new DenseIndex();
    for (const chunk of corpus.chunks) { sparse.add(chunk); dense.add(chunk); }
    const indexed = performance.now();
    const snapshot = { id: "performance", name: repo.repo, url: `https://github.com/${repo.repo}`, commit: repo.commit, ...corpus, createdAt: new Date().toISOString(), messages: [] } satisfies Repository;
    const dir = path.join(work, "persist", `${repoIndex}-${trial}`);
    const workspace = new Workspace(dir); await workspace.load(); await workspace.save(snapshot);
    const finished = performance.now();
    trials.push({ trial, parser_initialization: trial === 0 ? "first use for this repo; process may have prior languages" : "warm", read_parse_ms: parsed - started, index_build_ms: indexed - parsed, persist_ms: finished - indexed, total_ms: finished - started, rss_bytes: process.memoryUsage().rss });
  }
  const snapshot = corpus!;
  const inventory = { files: snapshot.files, skipped: snapshot.skipped, bytes: Object.values(snapshot.sources).reduce((n, s) => n + Buffer.byteLength(s), 0), lines: Object.values(snapshot.sources).reduce((n, s) => n + (s.endsWith("\n") ? s.split("\n").length - 1 : s.split("\n").length), 0), chunks: snapshot.chunks.length, definitions: snapshot.definitions.length };
  const py = JSON.parse(execFileSync(process.env.BENCH_PYTHON ?? "python3", [path.join(import.meta.dirname, "reference_python.py")], { input: JSON.stringify(snapshot.sources), maxBuffer: 20_000_000, encoding: "utf8" }));
  const typescript = tsReferences(snapshot.sources);
  const references: Reference[] = [...py.references, ...typescript.references];
  const selected = [...references].sort((a, b) => hash(`${a.path}:${a.qualifiedName}:${a.startLine}`).localeCompare(hash(`${b.path}:${b.qualifiedName}:${b.startLine}`))).slice(0, 100);
  for (const reference of selected) {
    const question = `Show \`${reference.qualifiedName}\` in ${reference.path}`;
    const started = performance.now();
    const result = sourceEvidence(snapshot, question, []);
    const elapsed = performance.now() - started;
    const correct = result.evidence.find(c => c.body === reference.body && c.startLine === reference.startLine && c.endLine === reference.endLine && c.path === reference.path);
    const precision = result.evidence.filter(c => references.some(r => r.path === c.path && r.body === c.body && r.startLine === c.startLine && r.endLine === c.endLine)).length;
    exactRows.push({ repo: repo.repo, commit: repo.commit, path: reference.path, qualified_name: reference.qualifiedName, oracle: reference.oracle, start_line: reference.startLine, end_line: reference.endLine, expected_body_sha256: hash(reference.body), bytes: Buffer.byteLength(reference.body), pass: Boolean(correct), returned: result.evidence.length, independently_valid_returns: precision, latency_ms: elapsed, failure: correct ? null : result.evidence.length ? "body-or-line-span-mismatch" : "no-exact-definition", returned_hashes: result.evidence.map(c => ({ body_sha256: hash(c.body), start_line: c.startLine, end_line: c.endLine, symbol: c.symbol })) });
  }
  for (let i = 0; i < 50; i++) {
    const question = `Show function CodeAtlasMissing_${repoIndex}_${i}`;
    if (references.some(r => r.symbol === `CodeAtlasMissing_${repoIndex}_${i}`)) throw new Error("negative collision");
    const result = sourceEvidence(snapshot, question, []);
    negativeRows.push({ repo: repo.repo, question, pass: result.evidence.length === 0 });
  }
  summary.repositories.push({ ...repo, inventory, independent_reference_count: references.length, reference_parser_errors: [...py.errors, ...typescript.errors], trials, warm_total: times(trials.slice(1).map(t => t.total_ms)) });
  await fs.writeFile(path.join(work, `snapshot-${repoIndex}.json`), JSON.stringify(snapshot));
  console.log(JSON.stringify({ stage: "repository", repo: repo.repo, inventory, exact_passes: exactRows.filter(r => r.repo === repo.repo && r.pass).length, exact_queries: selected.length }));
}
summary.exact_code = { positives: exactRows.length, passed: exactRows.filter(r => r.pass).length, exact_body_and_line_recall: exactRows.filter(r => r.pass).length / exactRows.length, returned: exactRows.reduce((n, r) => n + r.returned, 0), independently_valid_returns: exactRows.reduce((n, r) => n + r.independently_valid_returns, 0), negatives: negativeRows.length, negatives_rejected: negativeRows.filter(r => r.pass).length, latency: times(exactRows.map(r => r.latency_ms)), per_repo: manifest.repositories.map((r: any) => ({ repo: r.repo, queries: exactRows.filter(x => x.repo === r.repo).length, passed: exactRows.filter(x => x.repo === r.repo && x.pass).length })) };
await fs.writeFile(path.join(out, "exact-code.json"), JSON.stringify({ positive: exactRows, negative: negativeRows }, null, 2) + "\n");

for (const language of ["python", "javascript", "go", "java", "ruby"]) {
  const corpus: { id: string; text: string; title: string }[] = await read(`${language}-corpus.json`);
  const queries: { id: string; text: string }[] = await read(`${language}-queries.json`);
  const qrels: { "query-id": string; "corpus-id": string; score: number }[] = await read(`${language}-qrels.json`);
  if (corpus.length !== 1000 || queries.length !== 1000) throw new Error("Unexpected partition size");
  const gold = new Map<string, Set<number>>(), ids = new Map(corpus.map((c, i) => [c.id, i]));
  for (const r of qrels) {
    const doc = ids.get(r["corpus-id"]); if (doc === undefined) throw new Error("Missing gold document");
    if (r.score > 0) { const set = gold.get(r["query-id"]) ?? new Set(); set.add(doc); gold.set(r["query-id"], set); }
  }
  const sources: Record<string, string> = Object.create(null), definitions: SourceDefinition[] = [], chunks: Chunk[] = [], windows: Chunk[] = [];
  const mapping = new Map<string, number>();
  const started = performance.now();
  for (const [i, doc] of corpus.entries()) {
    const original = decodeURIComponent(new URL(doc.id).pathname.split("/blob/")[1]?.split("/").slice(1).join("/") ?? `source.${language}`);
    const file = `record-${String(i).padStart(4, "0")}/${original}`;
    mapping.set(file, i); sources[file] = doc.text;
    const parsed = await indexSource(language, file, doc.text);
    chunks.push(...parsed.chunks); definitions.push(...parsed.definitions); windows.push(...legacy(language, file, doc.text));
  }
  const parsedAt = performance.now();
  const oldSparse = new BM25Index(), sparse = new BM25Index(), dense = new DenseIndex();
  for (const chunk of windows) oldSparse.add(chunk);
  for (const chunk of chunks) { sparse.add(chunk); dense.add(chunk); }
  const builtAt = performance.now();
  const rows: Row[] = [];
  // Warm JIT on an unrelated fixed string; never warm/tune on relevance labels.
  oldSparse.search("codeatlas benchmark warmup", 16); sparse.search("codeatlas benchmark warmup", 16); dense.search("codeatlas benchmark warmup", 16);
  for (const query of queries) {
    const expected = gold.get(query.id); if (!expected?.size) throw new Error("Missing qrels");
    const t0 = performance.now(); const baseline = oldSparse.search(query.text, 16); const t1 = performance.now();
    const lexical = sparse.search(query.text, 16); const t2 = performance.now();
    const lexicalAnchors = new Set(lexical.map(r => `${r.chunk.path}:${r.chunk.startLine}`));
    const hybrid = rrf(dense.search(query.text, 16), lexical).filter(r => lexicalAnchors.has(`${r.chunk.path}:${r.chunk.startLine}`)); const t3 = performance.now();
    const selected = sourceEvidence({ sources, definitions }, query.text, hybrid); const t4 = performance.now();
    const rank = (results: RankedChunk[]) => docRank(results.map(r => r.chunk.path), expected, mapping);
    const row: Row = { language, query_id: query.id, expected: [...expected], rank: { window_bm25: rank(baseline), ast_bm25: rank(lexical), ast_hybrid: rank(hybrid), web_evidence: docRank(selected.evidence.map(c => c.path), expected, mapping) }, latency_ms: { window_bm25: t1 - t0, ast_bm25: t2 - t1, ast_hybrid: t3 - t1, web_evidence: t4 - t1 } };
    rows.push(row);
  }
  allRows.push(...rows);
  summary.retrieval[language] = { documents: corpus.length, queries: queries.length, source_bytes: Object.values(sources).reduce((n, s) => n + Buffer.byteLength(s), 0), ast_chunks: chunks.length, window_chunks: windows.length, definitions: definitions.length, syntax_error_chunks: chunks.filter(c => c.strategy === "syntax-error-window").length, parse_ms: parsedAt - started, index_build_ms: builtAt - parsedAt, metrics: Object.fromEntries(modes.map(m => [m, metric(rows, m)])), comparisons: [bootstrap(rows, "window_bm25", "web_evidence"), bootstrap(rows, "ast_bm25", "ast_hybrid")] };
  await fs.writeFile(path.join(out, `${language}-corpus-ids.json`), JSON.stringify(corpus.map(c => c.id), null, 2) + "\n");
  await fs.writeFile(path.join(out, `${language}-queries.jsonl`), rows.map(r => JSON.stringify(r)).join("\n") + "\n");
  console.log(JSON.stringify({ stage: "retrieval", language, metrics: summary.retrieval[language].metrics }));
}
summary.retrieval.overall = { metrics: Object.fromEntries(modes.map(m => [m, metric(allRows, m)])), comparisons: [bootstrap(allRows, "window_bm25", "web_evidence"), bootstrap(allRows, "ast_bm25", "ast_hybrid")] };
summary.resource = { max_rss_kib: process.resourceUsage().maxRSS, final_rss_bytes: process.memoryUsage().rss, cpu_user_microseconds: process.resourceUsage().userCPUTime, cpu_system_microseconds: process.resourceUsage().systemCPUTime };
await fs.writeFile(path.join(out, "summary.json"), JSON.stringify(summary, null, 2) + "\n");
console.log(JSON.stringify({ stage: "complete", exact_code: summary.exact_code, overall: summary.retrieval.overall, resource: summary.resource }, null, 2));
