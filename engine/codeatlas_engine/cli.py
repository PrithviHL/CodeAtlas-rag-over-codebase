import argparse
import json
import time
from .runtime import settings, components, search_components
from .store import Store
from .evaluation import evaluate


def main():
    parser = argparse.ArgumentParser()
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("bootstrap")
    sub.add_parser("inventory")
    retry = sub.add_parser("retry")
    retry.add_argument("job_id", type=int)
    evaluation = sub.add_parser("evaluate")
    evaluation.add_argument("--dataset", required=True)
    evaluation.add_argument("--output", required=True)
    latency = sub.add_parser("measure-push")
    for name in ("repo", "branch", "commit", "probe", "expected-path", "output"):
        latency.add_argument("--" + name, required=True)
    args = parser.parse_args()
    if args.command == "measure-push":
        from .latency import measure

        print(
            json.dumps(
                measure(
                    args.repo,
                    args.branch,
                    args.commit,
                    args.probe,
                    args.expected_path,
                    args.output,
                ),
                indent=2,
            )
        )
        return
    root, catalog = settings()
    store = Store(str(root / "metadata.sqlite3"))
    if args.command == "bootstrap":
        for repo, spec in catalog.items():
            print(
                json.dumps(
                    store.enqueue(
                        f"bootstrap-{repo}-{time.time_ns()}",
                        repo,
                        spec.get("commit") or spec["branch"],
                    )
                )
            )
    elif args.command == "inventory":
        rows = store.repos()
        print(
            json.dumps(
                {
                    "repositories": len(rows),
                    "indexed_lines": sum(r["lines"] for r in rows),
                    "snapshots": rows,
                },
                indent=2,
            )
        )
    elif args.command == "retry":
        with store.db() as db:
            db.execute(
                "UPDATE jobs SET status='queued',error=NULL WHERE id=? AND status='failed'",
                (args.job_id,),
            )
    elif args.command == "evaluate":
        store, search, _ = search_components(root)
        report = evaluate(search, store, args.dataset, args.output)
        print(json.dumps({k: v for k, v in report.items() if k != "rows"}, indent=2))
