# Web evaluation protocol — frozen before scoring

Target implementation: a39bfe75f898ce616b9b25b57551ef23ac53646c.
No production tuning or relevance-label changes are permitted after viewing results.

1. Retrieval: all 1,000 corpus records and 1,000 test queries per supported Python,
   JavaScript, Go, Java and Ruby partition of mteb/CodeSearchNetRetrieval. Pin the
   dataset revision and SHA-256 of each input. Use published qrels without changing
   them. No subsampling or success-based exclusion. Evaluate each language against
   its entire 1,000-record candidate pool, then macro-average across languages.
   This is a CodeSearchNet-derived docstring proxy task, not the original full
   challenge, expert-judged 99-query task, or a production-answer evaluation.
   No model calls or learned embedding claims. Corpus fragments are stored under
   unique paths retaining their original file basename; functions are parsed as
   supplied without adding wrappers to rescue syntax failures.
2. Compare original 60-line/48-step chunks + BM25; AST chunks + BM25; AST chunks +
   production hash-vector/RRF retrieval (including its lexical gate); and current
   sourceEvidence selection after retrieval. No weight changes. Deduplicate chunk
   hits to the original source-record ID before calculating Hit@1/5/10 and MRR@10.
   This measures code-record retrieval, not full-function correctness. Retain all
   per-query ranks and stage latency. Run a fixed-seed 2,000-resample paired
   bootstrap CI for MRR differences. Report both wins and regressions.
3. Real repository performance: shallow-clone pallets/flask, honojs/hono and
   expressjs/express once into isolated directories. Record exact Git SHAs and
   clone wall time. Apply PUBLIC_DEMO=true (100 files / 1 MB / 200 KB per file).
   Five local read/parse/index/persist repetitions per repo, first parser-cold,
   later process-warm; record each trial. Exclude cloning from index-stage timing.
   Report actual indexed source lines/bytes/files/chunks/definitions, not repo
   size or configured capacity. Do not extrapolate to millions of lines or
   hosted/production latency. Cold/warm refer to parser initialization, not OS disk cache.
4. Exact code: independently extract named Python declarations with Python stdlib
   ast and TS/JS declarations with the TypeScript compiler. Eligible references
   are named functions, classes, methods with bodies, and named arrow/function
   bindings; include nested definitions and decorators. Choose the first 100 per
   repo ordered by SHA-256(path + qualified name + start line), without looking
   at production extraction or lookup successes. Ask for each qualified name and
   file. Score a pass only if returned body and start/end line span exactly equal
   the independent reference. Keep unsupported/reference disagreements as
   failures. Report denominator, coverage and failure types. Also evaluate 50
   guaranteed-nonexistent function names per repo, separately from positive
   retrieval, rather than inflating a combined accuracy metric.
5. Runtime: record Node/OS/CPU/RAM, git commit, configuration, resource use and
   timestamp. No paid APIs. No Groq answer correctness/faithfulness/availability
   claim, no concurrent-user/RPS claim, and no hosted p95 latency claim.
6. Publish protocol, scripts, manifests, per-query results, aggregate report and
   accurate resume bullets. Imported repository code is parsed only, never run.
   Retain downloaded third-party code only in ignored local scratch storage.
