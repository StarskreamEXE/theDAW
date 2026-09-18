"""Stage one or more Suno/Harvester cache files into a loss-free staging catalog.

Thin CLI over ``backend.modules.library.suno_stage``. It reads the cache and
writes a separate staging SQLite database under ``--stage-root``; the source
cache, any media it points at, and the production library are never written to.
Promotion of the staged catalog into the library is a separate step.

Every song survives: identity is the provider song id (never the title), each
changed record for an id is kept as a revision, malformed rows are quarantined
with their reason and the import carries on, and songs without finished audio
are kept with an availability state.

Usage:
    python scripts/stage_suno_cache.py CACHE [CACHE ...] --stage-root DIR
        [--namespace suno] [--media-root DIR] [--resume]
        [--batch-size N] [--json-prefix songs.item]
        [--progress-seconds 5] [--expect-records N]

JSONL/NDJSON needs no extra dependency. A large ``{"songs": [...]}`` JSON needs
``ijson`` (``uv add ijson``); this script never installs anything.

A 200,000-song cache takes minutes, so progress goes to stderr every
``--progress-seconds`` while the report goes to stdout at the end; the two
streams can be redirected apart. An ETA is only shown when you told it how many
records to expect, because counting them would mean reading the file twice.

Ctrl+C is cooperative: the batch in flight is finished and committed, the
checkpoint is written, and the process exits 130. Re-run with ``--resume`` to
carry on from there. A second Ctrl+C aborts immediately.

Prints the run report(s) as JSON on stdout. Exit codes: 0 staged, 1 refused
(bad path, non-staging database, partial run without --resume), 2 missing
optional dependency, 130 interrupted with a resumable checkpoint.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
import time
from pathlib import Path
from types import FrameType
from typing import Any, Optional, Sequence, TextIO

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.modules.library import suno_stage  # noqa: E402

COUNTERS = ("seen", "accepted", "duplicate", "quarantined")
INTERRUPTED_EXIT_CODE = 130


class StopRequest:
    """Cooperative interrupt: ask the stager to stop at the next batch boundary.

    Killing a multi-hour import mid-batch would throw that batch away; stopping
    at a boundary keeps everything already committed and leaves a checkpoint to
    resume from. The *second* interrupt restores the default handler, so a user
    who wants out immediately gets out immediately.

    Callable, because that is what ``suno_stage.stage_cache`` polls.
    """

    def __init__(self, stream: Optional[TextIO] = None) -> None:
        self.requested = False
        self._stream = stream if stream is not None else sys.stderr
        self._previous: dict[int, Any] = {}

    def __call__(self) -> bool:
        return self.requested

    def request(self) -> None:
        self.requested = True

    def handle(self, signum: int, frame: Optional[FrameType]) -> None:
        """Signal handler. First call asks to stop; a second one stops now."""
        if self.requested:
            self.restore()
            raise KeyboardInterrupt
        self.request()
        print(
            "Interrupt received: finishing the current batch and saving a "
            "resumable checkpoint. Press Ctrl+C again to stop now.",
            file=self._stream,
            flush=True,
        )

    def install(self) -> None:
        """Take over SIGINT (and SIGBREAK on Windows) if we are able to."""
        for name in ("SIGINT", "SIGBREAK"):
            number = getattr(signal, name, None)
            if number is None:
                continue
            try:
                self._previous[int(number)] = signal.signal(number, self.handle)
            except (ValueError, OSError):  # not the main thread, or unsupported
                continue

    def restore(self) -> None:
        for number, handler in self._previous.items():
            try:
                signal.signal(number, handler)
            except (ValueError, OSError):
                continue
        self._previous.clear()


def format_progress(progress: suno_stage.StageProgress) -> str:
    """One stderr line: what has been seen, how fast, how much was refused."""
    parts = [
        f"staged {progress.seen:,} records",
        f"{progress.records_per_second:,.0f} rec/s",
        f"{progress.quarantined:,} quarantined",
        f"{progress.elapsed_seconds:,.1f}s elapsed",
    ]
    eta = progress.eta_seconds
    if eta is not None:
        parts.append(f"ETA {eta:,.0f}s")
    return "  " + " | ".join(parts)


class ProgressPrinter:
    """Rate-limited progress on stderr. ``every <= 0`` prints nothing."""

    def __init__(self, every: float, stream: Optional[TextIO] = None) -> None:
        self.every = every
        self._stream = stream if stream is not None else sys.stderr
        self._last = 0.0

    def __call__(self, progress: suno_stage.StageProgress) -> None:
        if self.every <= 0:
            return
        now = time.monotonic()
        if self._last and now - self._last < self.every:
            return
        self._last = now
        print(format_progress(progress), file=self._stream, flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Stage a Suno/Harvester cache without losing songs",
    )
    parser.add_argument(
        "cache", type=Path, nargs="+", help="Cache file(s): .jsonl/.ndjson or .json"
    )
    parser.add_argument(
        "--stage-root",
        type=Path,
        required=True,
        help="Directory for the staging database (never the library folder)",
    )
    parser.add_argument(
        "--namespace", default="suno", help="Provider namespace (default: suno)"
    )
    parser.add_argument(
        "--media-root",
        type=Path,
        default=None,
        help="Optional local media root, referenced in place and never modified",
    )
    parser.add_argument(
        "--resume",
        action="store_true",
        help="Continue a run that stopped part-way (otherwise it is refused)",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=suno_stage.DEFAULT_BATCH_SIZE,
        help=f"Records per transaction (default: {suno_stage.DEFAULT_BATCH_SIZE})",
    )
    parser.add_argument(
        "--json-prefix",
        default=suno_stage.DEFAULT_JSON_PREFIX,
        help="ijson prefix for non-JSONL input (use 'item' for a top-level array)",
    )
    parser.add_argument(
        "--progress-seconds",
        type=float,
        default=5.0,
        help="Seconds between progress lines on stderr (0 to stay silent)",
    )
    parser.add_argument(
        "--expect-records",
        type=int,
        default=None,
        help="Records you expect per cache file; only used to show an ETA",
    )
    return parser


def main(
    argv: Optional[Sequence[str]] = None, stop: Optional[StopRequest] = None
) -> int:
    args = build_parser().parse_args(argv)
    owns_signals = stop is None
    if stop is None:
        stop = StopRequest()
        stop.install()
    reports: list[dict[str, Any]] = []
    totals = dict.fromkeys(COUNTERS, 0)
    interrupted = False
    started = time.monotonic()
    try:
        for source in args.cache:
            try:
                report = suno_stage.stage_cache(
                    source,
                    args.stage_root,
                    namespace=args.namespace,
                    media_root=args.media_root,
                    batch_size=args.batch_size,
                    json_prefix=args.json_prefix,
                    resume=args.resume,
                    on_commit=ProgressPrinter(args.progress_seconds),
                    should_stop=stop,
                    total_records=args.expect_records,
                )
            except (OSError, ValueError, suno_stage.StagingDatabaseError) as exc:
                print(f"{type(exc).__name__}: {exc}", file=sys.stderr)
                return 1
            except suno_stage.IncompleteRunError as exc:
                print(f"{exc}", file=sys.stderr)
                return 1
            except RuntimeError as exc:
                print(f"{exc}", file=sys.stderr)
                return 2 if "ijson" in str(exc) else 1
            payload = report.to_dict()
            payload["source"] = str(Path(source).resolve())
            payload["reconciles"] = report.reconciles
            reports.append(payload)
            for counter in COUNTERS:
                totals[counter] += payload[counter]
            if report.interrupted:
                interrupted = True
                print(
                    f"Stopped at record {report.seen:,} of {Path(source).name} with a "
                    "resumable checkpoint. Re-run the same command with --resume.",
                    file=sys.stderr,
                )
                break
    finally:
        if owns_signals:
            stop.restore()
    totals_out: dict[str, Any] = dict(totals)
    totals_out["reconciles"] = all(report["reconciles"] for report in reports) and (
        totals["seen"]
        == totals["accepted"] + totals["duplicate"] + totals["quarantined"]
    )
    elapsed = time.monotonic() - started
    print(
        json.dumps(
            {
                "stage_root": str(Path(args.stage_root).resolve()),
                "database": str(suno_stage.stage_db_path(args.stage_root).resolve()),
                "reports": reports,
                "totals": totals_out,
                # Kept out of "totals" on purpose: totals is the reconciliation
                # statement, and wall-clock numbers are not part of it.
                "timing": {
                    "elapsed_seconds": elapsed,
                    "records_per_second": (
                        totals["seen"] / elapsed if elapsed > 0 else 0.0
                    ),
                    "interrupted": interrupted,
                },
            },
            indent=2,
            ensure_ascii=False,
        )
    )
    return INTERRUPTED_EXIT_CODE if interrupted else 0


if __name__ == "__main__":
    raise SystemExit(main())
