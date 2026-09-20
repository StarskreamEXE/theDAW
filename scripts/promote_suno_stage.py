"""Promote a staged Suno catalog into theDAW's library.

Thin CLI over ``backend.modules.library.suno_promote``. The staged catalog
(built by ``scripts/stage_suno_cache.py``) is only ever read; the source cache
and the media it points at are never opened at all. Audio is REFERENCED in
place -- a song's entry points at the file where it already lives.

Usage:
    python scripts/promote_suno_stage.py --stage-root DIR
        [--library-root DIR] [--batch-size 1000] [--dry-run] [--no-backup]
        [--progress-seconds 5]

What it guarantees, and what each one costs you if you skip it:

* **Updates, never duplicates.** A song already in the library -- including one
  the old ``ingest_suno_cache.py`` wrote -- is matched by provider id and
  updated in place.
* **Your edits survive.** Favourite, rating, notes, your tags and a title you
  renamed are carried through the update untouched.
* **Resumable.** Every promoted song leaves a receipt in the staging database.
  Ctrl+C finishes the batch in flight, commits it, and exits 130; re-running
  carries on from there, and a run with nothing left to do reports
  ``created=0, updated=0``.
* **Reversible-ish.** Before the first batch the library database is copied,
  through SQLite's backup API, into ``<library>/backups/``. Skipped when the
  library is empty, and by ``--no-backup``.
* **--dry-run** opens the staging database read-only and writes nothing
  anywhere, while still producing the full report.

Prints the report as JSON on stdout; progress goes to stderr, so the two can be
redirected apart. Exit codes: 0 done, 1 refused (bad path, not a staging
database, not enough free space), 130 interrupted with a resumable checkpoint.
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

from backend.lib import paths  # noqa: E402
from backend.modules.library import suno_promote  # noqa: E402

INTERRUPTED_EXIT_CODE = 130
REFUSED_EXIT_CODE = 1


class StopRequest:
    """Cooperative interrupt: stop at the next batch boundary, not mid-batch.

    Killing a long promotion inside a batch would throw that batch away;
    stopping at a boundary keeps every committed entry and its receipts. The
    *second* interrupt restores the default handler, so a user who wants out
    immediately gets out immediately.

    Callable, because that is what ``promote_stage`` polls.
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
        if self.requested:
            self.restore()
            raise KeyboardInterrupt
        self.request()
        print(
            "Interrupt received: finishing the current batch and committing its "
            "receipts. Press Ctrl+C again to stop now.",
            file=self._stream,
            flush=True,
        )

    def install(self) -> None:
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


def format_progress(progress: suno_promote.PromotionProgress) -> str:
    parts = [
        f"promoted {progress.seen:,}",
        f"+{progress.created:,} new",
        f"~{progress.updated:,} updated",
        f"={progress.unchanged:,} unchanged",
        f"{progress.deferred_no_media:,} deferred",
        f"{progress.records_per_second:,.0f} songs/s",
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

    def __call__(self, progress: suno_promote.PromotionProgress) -> None:
        if self.every <= 0:
            return
        now = time.monotonic()
        if self._last and now - self._last < self.every:
            return
        self._last = now
        print(format_progress(progress), file=self._stream, flush=True)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Promote a staged Suno catalog into theDAW's library.",
    )
    parser.add_argument(
        "--stage-root",
        required=True,
        type=Path,
        help="Folder holding the staging database written by stage_suno_cache.py.",
    )
    parser.add_argument(
        "--library-root",
        type=Path,
        default=None,
        help="Library root to write (default: the app's own, theDAW_GENERATIONS_DIR).",
    )
    parser.add_argument(
        "--batch-size",
        type=int,
        default=suno_promote.DEFAULT_BATCH_SIZE,
        help="Songs per library transaction (default: %(default)s).",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Report what would happen and write nothing, anywhere.",
    )
    parser.add_argument(
        "--no-backup",
        action="store_true",
        help="Skip the pre-import copy of the library database. Not advised.",
    )
    parser.add_argument(
        "--progress-seconds",
        type=float,
        default=5.0,
        help="Seconds between stderr progress lines; 0 silences them.",
    )
    return parser


def main(
    argv: Optional[Sequence[str]] = None,
    *,
    should_stop: Optional[StopRequest] = None,
) -> int:
    args = build_parser().parse_args(argv)
    root = args.library_root if args.library_root else paths.library_root()

    stop = should_stop if should_stop is not None else StopRequest()
    installed = should_stop is None
    if installed:
        stop.install()
    store = None
    try:
        # L1: a --dry-run opens the library read-only (mode=ro) and never
        # creates or migrates it; only a real run opens a writable store.
        try:
            store = suno_promote.open_promotion_target(
                Path(root), dry_run=bool(args.dry_run)
            )
        except OSError as exc:
            # Follow-up item 3: a real run's LibraryStore mkdir's its root;
            # a drive that does not exist at all raises OSError there. Same
            # clean refusal (exit 1) as any other PromotionRefused, not a
            # traceback.
            raise suno_promote.PromotionRefused(
                f"cannot open library at {root}: {exc}"
            ) from exc
        report = suno_promote.promote_stage(
            args.stage_root,
            store,
            batch_size=max(1, int(args.batch_size)),
            dry_run=bool(args.dry_run),
            backup=not args.no_backup,
            on_batch=ProgressPrinter(args.progress_seconds),
            should_stop=stop,
        )
    except suno_promote.PromotionRefused as exc:
        print(f"Refused: {exc}", file=sys.stderr, flush=True)
        return REFUSED_EXIT_CODE
    except KeyboardInterrupt:
        print("Stopped. Re-run the same command to carry on.", file=sys.stderr)
        return INTERRUPTED_EXIT_CODE
    finally:
        if installed:
            stop.restore()
        # Follow-up item 3: close whichever target we opened -- a
        # ReadOnlyLibraryTarget (dry run) has its own close(); a real,
        # writable LibraryStore only exposes close() on its .db.
        if store is not None:
            if hasattr(store, "close"):
                store.close()
            elif store.db is not None:
                store.db.close()

    print(json.dumps(report.to_dict(), indent=2, ensure_ascii=False))
    if report.status == "cancelled":
        print(
            "Interrupted at a batch boundary; re-run the same command to carry on.",
            file=sys.stderr,
            flush=True,
        )
        return INTERRUPTED_EXIT_CODE
    return 0


if __name__ == "__main__":  # pragma: no cover - CLI entry point
    raise SystemExit(main())
