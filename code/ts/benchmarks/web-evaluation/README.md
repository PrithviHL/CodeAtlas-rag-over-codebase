# CodeAtlas web evaluation

Measured November 16, 2026 (America/New_York). Target application commit: `a39bfe75f898ce616b9b25b57551ef23ac53646c`. No product changes or relevance-label tuning were made during evaluation.

## Results worth using on a resume

- **96.6% exact-source recovery:** 281/291 deterministic function, class and method lookup cases returned the exact reference body and line span. References came from separate Python stdlib AST and TypeScript compiler implementations across capped Flask, Hono and Express snapshots. The 95% Wilson interval is **93.8%–98.1%**; cases are not independent random user traffic.
- **16.2% higher lexical-search MRR@10:** AST chunks + field-weighted BM25 scored **0.4565**, versus **0.3927** for the original fixed-line chunks + BM25, on **5,000 CodeSearchNet-derived test queries across five languages**. This is a component ablation, not a gain for the full deployed retrieval pipeline.
- **3.59 ms local p95 retrieval/evidence selection:** measured over those 5,000 queries with 1,000 code records in each language-specific candidate pool. Excludes HTTP, authentication, network, cloning and LLM generation. It is not a Render latency claim.
- **40,163 indexed text lines across 300 files:** three capped public-repository snapshots, with five index-stage trials per snapshot. File and repository caps remain enabled. These are not full-repository LOC or a fleet-capacity claim.

## Current limitation that must accompany the component gain

The complete web evidence path scored **0.2596 MRR@10 and 38.04% Hit@10**, below the 0.3927 MRR@10 line-window baseline. Hash-vector fusion reduces rank quality relative to AST BM25, and symbol/evidence selection reduces recall on this docstring task. Do not claim that the full hybrid system improved MRR by 16.2%, or that it has 96.6% natural-language answer accuracy. No generated-answer correctness or citation-faithfulness study was performed.

## Retrieval results

Each language has all 1,000 published test queries and all 1,000 published candidate records. No query was removed after scoring. Published docstring-derived qrels are used unchanged; these are proxy relevance labels, not expert-judged answers. The 5,000-query aggregate weights each language equally. Chunk hits are deduplicated by source record before computing document-level ranks. The original path is retained under a unique virtual record prefix. No downloaded code was executed.

| Configuration | MRR@10 | Hit@1 | Hit@5 | Hit@10 | Local p95 |
|---|---:|---:|---:|---:|---:|
| Fixed windows + BM25 (baseline) | 0.3927 | 30.82% | 50.32% | 58.48% | 3.32 ms |
| AST chunks + BM25 (component ablation) | 0.4565 | 36.96% | 57.16% | 65.50% | 3.17 ms |
| AST + hash-vector/RRF + lexical gate | 0.2642 | 12.72% | 45.74% | 64.30% | 3.41 ms |
| Current web source-evidence selection | 0.2596 | 20.24% | 34.10% | 38.04% | 3.59 ms |

| Language | Baseline MRR@10 | AST BM25 MRR@10 | Hybrid MRR@10 | Web evidence MRR@10 |
|---|---:|---:|---:|---:|
| Python | 0.4815 | 0.5074 | 0.2718 | 0.1221 |
| Javascript | 0.3992 | 0.4151 | 0.2901 | 0.1518 |
| Go | 0.5099 | 0.6701 | 0.3820 | 0.7833 |
| Java | 0.1630 | 0.2466 | 0.1150 | 0.0732 |
| Ruby | 0.4101 | 0.4434 | 0.2621 | 0.1678 |

The AST lexical MRR improvement is **+0.0638 absolute** (paired query-bootstrap 95% interval **+0.0586 to +0.0688**, 2,000 resamples, fixed seed). The full web path loses 0.1331 MRR relative to the window baseline (95% paired bootstrap interval −0.1468 to −0.1192). Intervals are exploratory, have no multiple-comparison adjustment, and ignore repository/query dependence.

The unusually strong Go result is reported alongside the weaker languages. It must not be selected as the overall score; docstring queries often include declaration names, which benefits exact-symbol lookup. All modes use the same record pool, labels and unmodified tokenization/weights. Standalone fragments were parsed as supplied; no wrapper code was added. This is not an official full MTEB/CodeSearchNet leaderboard submission. The offline 1,000-record corpus uses the web retrieval modules directly and exceeds the hosted demo’s 100-file import limit; it is not evidence that the hosted importer accepts 1,000 files.

## Exact-code contract

Independent references are selected by a fixed SHA-256 ordering, at most 100 per repo, before examining production lookup success. Express supplies 91 eligible named declarations, for 291 total. A recovery pass requires the reference body and line interval to appear in the results. Duplicate/overloaded names can legitimately return several declarations; this metric is target recovery, not top-1 search accuracy.

| Snapshot | Reference lookup cases | Exact recoveries | Rate |
|---|---:|---:|---:|
| pallets/flask | 100 | 98 | 98.00% |
| honojs/hono | 100 | 92 | 92.00% |
| expressjs/express | 91 | 91 | 100.00% |

All **150/150** deterministic nonexistent-symbol probes returned no evidence. This checks explicit symbol-lookup rejection, not general natural-language no-answer detection, and is not mixed into the positive recovery rate. Of 578 returned declarations, 576 exactly matched some independently extracted declaration (99.65% source-span agreement); this is not semantic relevance precision.

Ten recovery failures are retained: five involve a TypeScript abstract class and its methods; three involve ambient TypeScript signatures (the reference extractor includes them, although they have no body); two Python bodies differ because Tree-sitter includes a trailing type-ignore comment that stdlib AST omits. The latter two preserve executable code and matching line spans but still fail the strict byte-exact criterion. No failures were reclassified as passes or dropped.

## Indexing measurements under hosted demo limits

`PUBLIC_DEMO=true`: at most 100 files, 1 MB indexed per repository, 200 KB per file. Parser/source read, sparse/hash-vector index construction and JSON snapshot persistence are included. Cloning is timed separately. There are five trials per repo in one process; trials 2–5 reuse parser grammars. Disk caches, background load and JIT state are not controlled. p50 is the nearest-rank empirical quantile; with only four warm trials, p95 is effectively the maximum and is not a robust tail-latency estimate.

| Snapshot | Files | Indexed text lines | Bytes | Chunks | Declarations | First trial | Warm p50 | Warm max | Clone once |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| pallets/flask | 100 | 16,607 | 541,950 | 705 | 1196 | 147.9 ms | 106.7 ms | 117.7 ms | 0.83 s |
| honojs/hono | 100 | 8,199 | 235,120 | 356 | 169 | 79.0 ms | 64.9 ms | 78.1 ms | 1.04 s |
| expressjs/express | 100 | 15,357 | 401,477 | 764 | 91 | 88.4 ms | 78.8 ms | 81.3 ms | 0.67 s |

These inventories include documentation, tests and configuration as well as code. The importer stops at its limits, and repositories can have additional skipped files. Do not add clone and index percentiles or turn these timings into a hosted import SLA.

## Environment and verification

- Apple M4 Pro, 12 logical CPUs, 24 GiB RAM, macOS arm64; Node.js 24.22.1. The deployed Docker runtime is Node 22; timings here come from the native local process.
- Benchmark process peak RSS: **412.0 MiB**, including the TypeScript reference compiler, benchmark harness and retained datasets. This is not a measurement of the isolated hosted service.
- **Zero LLM/API inference calls** during evaluation. No Groq/Claude answer quality, rate-limit or hosting-cost claim follows from this.
- Fresh application verification: **53 Node tests passed**; TypeScript application and benchmark typechecks passed. Python engine test verification is recorded separately in `results/verification.json`.
- Sources were shallow-cloned into ignored scratch storage and parsed only. The existing local Qdrant/engine dataset was not reindexed or overwritten.

## Reproduce

From the repository root with Node 22+ and Python 3.10+:

```sh
npm run setup
python3 -m venv .runtime/web-evaluation/venv
.runtime/web-evaluation/venv/bin/python -m pip install pyarrow==19.0.1
.runtime/web-evaluation/venv/bin/python code/ts/benchmarks/web-evaluation/prepare.py \
  --work-dir .runtime/web-evaluation \
  --results-dir code/ts/benchmarks/web-evaluation/results
cd code/ts
BENCH_PYTHON="../../.runtime/web-evaluation/venv/bin/python" \
  node --import tsx benchmarks/web-evaluation/run.ts
cd ../..
python3 code/ts/benchmarks/web-evaluation/analyze.py \
  code/ts/benchmarks/web-evaluation/results
```

The checked-in input manifest pins dataset revision and repo SHAs. `prepare.py` checks downloaded file hashes. Timings will vary; reruns intentionally replace the results directory. Run against the pinned target implementation to reproduce rankings, and keep this evaluation set separate from future tuning. Benchmark typecheck: `npx --prefix code/ts tsc --project code/ts/tsconfig.benchmarks.json --noEmit` (or run `tsc --project tsconfig.benchmarks.json` from `code/ts`).

## Evidence files

- `PROTOCOL.md`: protocol written before scoring; its hash is in the summary.
- `results/inputs.json`: immutable dataset revision, input checksums, repo commits and clone timings.
- `results/summary.json`: stage metrics, environment and all 15 index trials.
- `results/*-queries.jsonl`: all 5,000 per-query ranks and timings for four configurations.
- `results/*-corpus-ids.json`: immutable source URLs in corpus order; no copied source bodies.
- `results/exact-code.json`: every positive/negative lookup, expected body hashes and returned spans.
- `results/analysis.json`: independent rank recomputation, confidence intervals and all failures.
- `results/SHA256SUMS.json`: result-file integrity manifest.
- `results/source-manifest.json`: source/harness hashes for this run.

## Resume wording

Use the first two bullets together, with the component distinction intact:

> Built and deployed CodeAtlas, an AST-aware codebase Q&A app with OAuth and commit-pinned citations; recovered exact source bodies and line spans in **96.6% of 291 parser-checked lookups** across Flask, Hono and Express.

> Benchmarked **5,000 CodeSearchNet-derived queries across five languages**; AST-based lexical retrieval achieved **0.457 MRR@10**, a **16.2% improvement** over fixed-line chunks.

Optional performance bullet:

> Measured **3.6 ms local p95 retrieval/evidence-selection latency** over 5,000 queries against 1,000 code candidates per language, excluding network and LLM generation.

Do not use “96.6% answer accuracy,” “16.2% better end-to-end hybrid search,” “3.6 ms live app latency,” “40K LOC fully indexed,” “2M LOC,” or a 0.83 MRR claim.

## What to improve next

Prioritize a development-only set for lexical-versus-hash ranking, a less aggressive distinction between exact symbol requests and ordinary prose, and TypeScript abstract/ambient declarations. Evaluate any changes on a new untouched set; the results above remain a baseline, not a held-out set after tuning. The prior local semantic-engine pilot remains separately documented and its numbers must not be mixed with these web results.

## Public dataset references

[MTEB CodeSearchNetRetrieval dataset](https://huggingface.co/datasets/mteb/CodeSearchNetRetrieval) supplies the fixed candidate pools and qrels. [GitHub CodeSearchNet](https://github.com/github/CodeSearchNet) distinguishes docstring-derived proxy data from its separate human-annotated 99-query evaluation. This report uses the proxy task.
