"""Measure a full-size Suno promotion: stage 200,000 synthetic songs, promote
them into a throwaway library, then prove that library is still fast.

Two questions, one run:

1. **Does the promotion finish?** ~200,000 songs is the size of the real
   archive. This times the pass end to end, per batch, and reports throughput,
   peak resident memory, bytes on disk per entry and the size the library
   database ends up at. It also runs the pass a SECOND time, which must be a
   no-op -- that is the resumability guarantee measured rather than asserted.
2. **Is the library still usable afterwards?** A promotion that leaves the
   listing slow has failed. The same budgets ``tests/test_library_paging.py``
   pins (page < 250 ms, search < 300 ms, count < 150 ms) are re-run here
   against the PROMOTED library, which -- unlike the synthetic rows that test
   builds -- carries kilobytes of raw provider record per row.

Everything is synthetic and everything is temporary. The generator is the one
``scripts/bench_suno_stage.py`` already uses, so the corpus has the shapes that
matter: ids that are not titles, duplicate records, extra revisions, malformed
rows, songs sharing a title, lineage that points forwards, backwards and at
songs that are not in the cache at all. **No real cache is ever read and no
real library is ever written.**

Usage:
    python scripts/bench_suno_promote.py --work-dir D:/tmp/t47-bench
        [--count 200000] [--seed N] [--batch-size 1000]
        [--media-share 0.5] [--keep] [--skip-budgets]

``--work-dir`` must have room and must not be the system drive by accident:
the script measures free space first and refuses rather than filling a disk.
Everything it writes lives under that directory and is deleted at the end
unless ``--keep`` is given.
"""

from __future__ import annotations

import argparse
import json
import shutil
import sys
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

import bench_suno_stage as stage_bench  # noqa: E402
from backend.modules.library import suno_promote, suno_stage  # noqa: E402
from backend.modules.library.db import SORTS, EntryFilters, LibraryDB  # noqa: E402
from backend.modules.library.store import LibraryStore  # noqa: E402

DEFAULT_COUNT = 200_000
DEFAULT_SEED = 20260918

#: The budgets T30 pinned for a 200,000-row library, in milliseconds.
PAGE_BUDGET_MS = 250.0
SEARCH_BUDGET_MS = 300.0
COUNT_BUDGET_MS = 150.0

#: Roughly what one staged + promoted song costs on disk across the cache file,
#: the staging database and the library together. Only used to refuse a run
#: that would fill the drive; the real numbers are measured and reported.
ESTIMATED_TOTAL_BYTES_PER_SONG = 22_000


def human_bytes(value: Optional[int]) -> str:
    return stage_bench.human_bytes(value)


@dataclass
class PhaseResult:
    seconds: float = 0.0
    rate: float = 0.0
    peak_rss_bytes: int = 0
    peak_rss_source: str = "unavailable"
    report: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["peak_rss"] = human_bytes(self.peak_rss_bytes)
        return payload


def _check_space(work_dir: Path, count: int) -> Optional[str]:
    needed = int(count * ESTIMATED_TOTAL_BYTES_PER_SONG * 1.15)
    work_dir.mkdir(parents=True, exist_ok=True)
    free = shutil.disk_usage(work_dir).free
    if free < needed:
        return (
            f"{work_dir} has {human_bytes(free)} free; this run needs about "
            f"{human_bytes(needed)}. Point --work-dir at a drive with room."
        )
    return None


def _progress_line(progress: suno_promote.PromotionProgress) -> str:
    eta = progress.eta_seconds
    return (
        f"  promoted {progress.seen:,}/{progress.total or 0:,} "
        f"(+{progress.created:,} new, ~{progress.updated:,} updated, "
        f"={progress.unchanged:,} unchanged, {progress.deferred_no_media:,} deferred) "
        f"{progress.records_per_second:,.0f} songs/s"
        + (f" ETA {eta:,.0f}s" if eta is not None else "")
    )


def run_stage_phase(
    cache: Path, stage_root: Path, media_root: Optional[Path], batch_size: int
) -> PhaseResult:
    result = PhaseResult()
    last = [0.0]

    def on_commit(progress: suno_stage.StageProgress) -> None:
        now = time.monotonic()
        if now - last[0] < 5.0:
            return
        last[0] = now
        print(
            f"  staged {progress.seen:,} ({progress.records_per_second:,.0f} rec/s)",
            file=sys.stderr,
            flush=True,
        )

    started = time.perf_counter()
    with stage_bench.PeakMemory() as memory:
        report = suno_stage.stage_cache(
            cache,
            stage_root,
            media_root=media_root,
            batch_size=batch_size,
            on_commit=on_commit,
        )
    result.seconds = time.perf_counter() - started
    result.rate = report.seen / result.seconds if result.seconds else 0.0
    result.peak_rss_bytes = memory.peak_bytes
    result.peak_rss_source = memory.source
    result.report = report.to_dict()
    return result


def run_promote_phase(
    stage_root: Path, library_root: Path, batch_size: int, *, label: str
) -> PhaseResult:
    result = PhaseResult()
    last = [0.0]

    def on_batch(progress: suno_promote.PromotionProgress) -> None:
        now = time.monotonic()
        if now - last[0] < 5.0:
            return
        last[0] = now
        print(_progress_line(progress), file=sys.stderr, flush=True)

    print(f"\n[{label}] promoting into {library_root}", file=sys.stderr, flush=True)
    started = time.perf_counter()
    with stage_bench.PeakMemory() as memory:
        store = LibraryStore(library_root)
        report = suno_promote.promote_stage(
            stage_root, store, batch_size=batch_size, on_batch=on_batch
        )
        if store.db is not None:
            store.db.close()
    result.seconds = time.perf_counter() - started
    result.rate = report.seen / result.seconds if result.seconds else 0.0
    result.peak_rss_bytes = memory.peak_bytes
    result.peak_rss_source = memory.source
    result.report = report.to_dict()
    return result


def measure_budgets(library_root: Path) -> dict[str, Any]:
    """Re-run T30's budgets against the promoted library."""
    db = LibraryDB(library_root / "library.db")
    try:
        audio = EntryFilters(kinds=frozenset({"audio"}))
        started = time.perf_counter()
        total = db.count_entries_filtered(audio)
        count_ms = (time.perf_counter() - started) * 1000

        deep = max(0, total - 50_000)
        pages: dict[str, float] = {}
        for sort in SORTS:
            started = time.perf_counter()
            page = db.list_entries_page(audio, sort=sort, limit=200, offset=deep)
            pages[sort] = (time.perf_counter() - started) * 1000
            if len(page) != 200:
                pages[f"{sort}:rows"] = float(len(page))

        started = time.perf_counter()
        hits = db.list_entries_page(
            EntryFilters(kinds=frozenset({"audio"}), q="neon drift"), limit=200
        )
        search_ms = (time.perf_counter() - started) * 1000

        started = time.perf_counter()
        capped = db.list_entry_ids(audio, cap=50_000)
        ids_ms = (time.perf_counter() - started) * 1000
    finally:
        db.close()

    worst_page = max(pages[sort] for sort in SORTS)
    return {
        "rows": total,
        "deep_offset": deep,
        "count_ms": round(count_ms, 1),
        "search_ms": round(search_ms, 1),
        "search_hits": len(hits),
        "entry_ids_ms": round(ids_ms, 1),
        "page_ms": {sort: round(pages[sort], 1) for sort in SORTS},
        "worst_page_ms": round(worst_page, 1),
        "entry_ids_returned": len(capped),
        "within_budget": bool(
            count_ms < COUNT_BUDGET_MS
            and search_ms < SEARCH_BUDGET_MS
            and worst_page < PAGE_BUDGET_MS
        ),
        "budgets_ms": {
            "page": PAGE_BUDGET_MS,
            "search": SEARCH_BUDGET_MS,
            "count": COUNT_BUDGET_MS,
        },
    }


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Benchmark promoting a staged Suno catalog into a library."
    )
    parser.add_argument("--count", type=int, default=DEFAULT_COUNT)
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--work-dir",
        type=Path,
        required=True,
        help="Scratch directory on a drive with room. Everything lives here.",
    )
    parser.add_argument(
        "--batch-size", type=int, default=suno_promote.DEFAULT_BATCH_SIZE
    )
    parser.add_argument(
        "--media-share",
        type=float,
        default=0.0,
        help="Fraction of songs given a local id-named audio file to reference.",
    )
    parser.add_argument(
        "--keep", action="store_true", help="Leave the scratch directory behind."
    )
    parser.add_argument(
        "--skip-budgets",
        action="store_true",
        help="Skip the post-promotion listing budgets.",
    )
    parser.add_argument(
        "--skip-second-run",
        action="store_true",
        help="Skip the second pass that proves a re-run is a no-op.",
    )
    return parser


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    if args.count <= 0:
        print("--count must be positive", file=sys.stderr)
        return 2
    work_dir: Path = args.work_dir.expanduser().resolve()
    refusal = _check_space(work_dir, args.count)
    if refusal:
        print(refusal, file=sys.stderr)
        return 1

    cache = work_dir / "cache.jsonl"
    stage_root = work_dir / "stage"
    library_root = work_dir / "library"
    media_root: Optional[Path] = None
    summary: dict[str, Any] = {
        "count": args.count,
        "seed": args.seed,
        "work_dir": str(work_dir),
        "batch_size": args.batch_size,
    }

    try:
        print(f"[1/5] generating {args.count:,} records", file=sys.stderr, flush=True)
        generated = stage_bench.generate_jsonl(cache, args.count, args.seed)
        summary["cache"] = generated.to_dict()

        media_count = int(args.count * max(0.0, min(1.0, args.media_share)))
        if media_count:
            media_root = work_dir / "media"
            print(f"[2/5] {media_count:,} media files", file=sys.stderr, flush=True)
            summary["media_seconds"] = stage_bench.make_media_files(
                media_root, media_count, args.seed
            )

        print("[3/5] staging", file=sys.stderr, flush=True)
        staged = run_stage_phase(cache, stage_root, media_root, args.batch_size)
        summary["stage"] = staged.to_dict()
        summary["stage_db_bytes"] = stage_bench.database_bytes(stage_root)

        print("[4/5] promoting", file=sys.stderr, flush=True)
        first = run_promote_phase(
            stage_root, library_root, args.batch_size, label="first run"
        )
        summary["promote"] = first.to_dict()

        entries = int(first.report.get("created", 0))
        library_bytes = stage_bench.directory_bytes(library_root)
        db_bytes = sum(
            path.stat().st_size
            for name in ("library.db", "library.db-wal", "library.db-shm")
            for path in [library_root / name]
            if path.exists()
        )
        summary["library_bytes"] = library_bytes
        summary["library_db_bytes"] = db_bytes
        summary["bytes_per_entry"] = int(library_bytes / entries) if entries else 0
        summary["human"] = {
            "library": human_bytes(library_bytes),
            "library_db": human_bytes(db_bytes),
            "staging_db": human_bytes(summary["stage_db_bytes"]),
            "cache": human_bytes(generated.bytes),
            "peak_rss_promote": human_bytes(first.peak_rss_bytes),
            "bytes_per_entry": human_bytes(summary["bytes_per_entry"]),
        }

        if not args.skip_second_run:
            second = run_promote_phase(
                stage_root, library_root, args.batch_size, label="second run"
            )
            summary["promote_again"] = second.to_dict()
            summary["second_run_is_noop"] = bool(
                second.report.get("created") == 0 and second.report.get("updated") == 0
            )

        if not args.skip_budgets:
            print("[5/5] listing budgets", file=sys.stderr, flush=True)
            summary["budgets"] = measure_budgets(library_root)
    finally:
        if not args.keep:
            shutil.rmtree(work_dir, ignore_errors=True)
            summary["cleaned_up"] = True

    print(json.dumps(summary, indent=2))
    print(_summary_line(summary), file=sys.stderr, flush=True)
    budgets = summary.get("budgets")
    if budgets is not None and not budgets["within_budget"]:
        return 1
    return 0


def _summary_line(summary: dict[str, Any]) -> str:
    promote = summary.get("promote", {})
    budgets = summary.get("budgets")
    parts = [
        f"{summary['count']:,} songs",
        f"stage {summary.get('stage', {}).get('seconds', 0):,.1f}s",
        f"promote {promote.get('seconds', 0):,.1f}s ({promote.get('rate', 0):,.0f}/s)",
        f"library {summary.get('human', {}).get('library', '?')}",
        f"{summary.get('human', {}).get('bytes_per_entry', '?')}/entry",
        f"peak RSS {summary.get('human', {}).get('peak_rss_promote', '?')}",
    ]
    if budgets is not None:
        parts.append(
            f"page {budgets['worst_page_ms']}ms / search {budgets['search_ms']}ms "
            f"/ count {budgets['count_ms']}ms"
            + ("" if budgets["within_budget"] else "  OVER BUDGET")
        )
    return "\n" + " | ".join(parts)


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
