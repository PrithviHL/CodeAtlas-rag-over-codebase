from __future__ import annotations
import json
import logging
import signal
import time
from .indexing import GitSnapshot, Indexer
from .runtime import settings, components

log = logging.getLogger(__name__)


def process(store, indexer, root, spec, job):
    started = time.perf_counter()
    snapshot = GitSnapshot(root / "mirrors", spec)
    report = indexer.update(job["repo"], snapshot)
    report.update(
        requested_commit=job["requested_commit"],
        coalesced=snapshot.commit != job["requested_commit"],
        fetch_and_index_seconds=time.perf_counter() - started,
        receipt_to_publish_seconds=time.time() - job["received"],
        searchable_at=time.time(),
    )
    store.finish(job["id"], report)
    return report


def main():
    logging.basicConfig(level=logging.INFO)
    root, catalog = settings()
    store, embedding, vectors = components(root)
    indexer = Indexer(store, embedding, vectors)
    store.recover()
    stopping = False

    def stop(*_):
        nonlocal stopping
        stopping = True

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    while not stopping:
        job = store.claim()
        if not job:
            time.sleep(1)
            continue
        try:
            report = process(store, indexer, root, catalog[job["repo"]], job)
            log.info("index_complete %s", json.dumps(report))
        except Exception as error:
            # Never log provider response bodies, Git credentials, or source text.
            store.finish(job["id"], error=type(error).__name__)
            log.error("index_failed job=%s error=%s", job["id"], type(error).__name__)


if __name__ == "__main__":
    main()
