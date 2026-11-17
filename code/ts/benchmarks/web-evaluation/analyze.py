"""Derive confidence intervals and integrity checks from immutable per-query ranks."""
import argparse
import hashlib
import json
import math
from pathlib import Path
import random


def bootstrap(rows, baseline, candidate):
    deltas = [(1 / r['rank'][candidate] if r['rank'][candidate] else 0) - (1 / r['rank'][baseline] if r['rank'][baseline] else 0) for r in rows]
    rng = random.Random(20261116)
    samples = sorted(sum(deltas[rng.randrange(len(deltas))] for _ in deltas) / len(deltas) for _ in range(2000))
    return {'baseline': baseline, 'candidate': candidate, 'delta_mrr': sum(deltas) / len(deltas), 'ci95': [samples[math.ceil(.025 * len(samples)) - 1], samples[math.ceil(.975 * len(samples)) - 1]], 'resamples': 2000, 'seed': 20261116, 'rng': 'Python random.Random (MT19937)', 'unit': 'query; paired bootstrap; no multiplicity adjustment'}


def wilson(successes, total):
    z = 1.959963984540054
    p = successes / total
    center = (p + z*z/(2*total)) / (1 + z*z/total)
    half = z * math.sqrt(p*(1-p)/total + z*z/(4*total*total)) / (1 + z*z/total)
    return [center - half, center + half]


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('results_dir', type=Path)
    args = parser.parse_args()
    root = args.results_dir
    summary = json.loads((root/'summary.json').read_text())
    rows = [json.loads(line) for file in sorted(root.glob('*-queries.jsonl')) for line in file.read_text().splitlines()]
    assert len(rows) == 5000
    for language in ['python', 'javascript', 'go', 'java', 'ruby']:
        selected = [r for r in rows if r['language'] == language]
        assert len(selected) == 1000 and len({r['query_id'] for r in selected}) == 1000
        for mode in summary['retrieval'][language]['metrics']:
            mrr = sum(1/r['rank'][mode] if r['rank'][mode] else 0 for r in selected) / len(selected)
            assert abs(mrr-summary['retrieval'][language]['metrics'][mode]['mrr_at_10']) < 1e-12
    positive = json.loads((root/'exact-code.json').read_text())['positive']
    n = len(positive); passed = sum(r['pass'] for r in positive)
    old = summary['retrieval']['overall']['metrics']['window_bm25']['mrr_at_10']
    ast = summary['retrieval']['overall']['metrics']['ast_bm25']['mrr_at_10']
    result = {'integrity': '5,000 unique per-language query IDs; stored MRR independently recomputed from ranks', 'ast_lexical_relative_mrr_gain': (ast/old-1), 'ast_lexical_absolute_mrr_gain': ast-old,
              'ast_vs_window_bootstrap': bootstrap(rows, 'window_bm25', 'ast_bm25'),
              'exact_code_wilson95': wilson(passed,n), 'exact_code_n': n, 'exact_code_passed': passed,
              'indexed_lines_across_capped_snapshots': sum(r['inventory']['lines'] for r in summary['repositories']),
              'indexed_bytes_across_capped_snapshots': sum(r['inventory']['bytes'] for r in summary['repositories']),
              'indexed_files_across_capped_snapshots': sum(r['inventory']['files'] for r in summary['repositories']),
              'failed_exact_references': [{k:r[k] for k in ['repo','path','qualified_name','failure']} for r in positive if not r['pass']]}
    (root/'analysis.json').write_text(json.dumps(result,indent=2)+'\n')
    checksums = {p.name:hashlib.sha256(p.read_bytes()).hexdigest() for p in sorted(root.iterdir()) if p.is_file() and p.name != 'SHA256SUMS.json'}
    (root/'SHA256SUMS.json').write_text(json.dumps(checksums,indent=2)+'\n')
    print(json.dumps(result,indent=2))


if __name__ == '__main__': main()
