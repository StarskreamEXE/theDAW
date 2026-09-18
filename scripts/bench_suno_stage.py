"""Synthetic-cache generator and benchmark for the Suno staging importer.

This script exists to prove ``backend.modules.library.suno_stage`` at the scale
the user's real archive actually has (~200,000 songs in one file) *without ever
touching the real archive*. Everything it reads it wrote itself, under a work
directory you name; nothing outside that directory is opened, and the directory
is deleted again unless ``--keep`` is given.

What it generates, per the shape of a Suno/Harvester cache record:

* long lyrics and a nested ``metadata`` block (history, concat_history, signed
  media URLs), so per-record JSON is kilobytes rather than bytes;
* ~25% of records drawing their title from a small hot pool, so the
  "ten songs called Neon Rain" case is the common case, not a curiosity;
* 5% exact duplicate records and 2% same-id-different-content revisions;
* 1% malformed lines (truncated JSON, arrays, objects with no id);
* explicit lineage hints, including parents that only appear *later* in the
  file and parents that never appear at all.

It emits the same logical corpus as BOTH ``.jsonl`` and ``{"songs": [...]}``
``.json`` so the two source paths are compared on identical content.

Reported per run: wall time, records/sec, peak RSS, staging database size, the
source digest cost, the MediaIndex build cost, and the reconciled
:class:`~backend.modules.library.suno_stage.StageReport`.

Usage::

    uv run python scripts/bench_suno_stage.py --work-dir E:/tmp/suno-bench
    uv run python scripts/bench_suno_stage.py --count 20000 --media-files 20000 \
        --work-dir E:/tmp/suno-bench

The ``.json`` source needs ``ijson``. When ``ijson`` is not importable the JSON
run is skipped and says so; ``--json-stdlib-shim`` instead exercises the JSON
code path through a throwaway stdlib stand-in that parses the whole file in
memory. That stand-in measures the *wiring* (prefix selection, non-string record
handling, checkpointing) at whatever scale fits in RAM — it is NOT a streaming
parser and its throughput is not a measurement of ijson.
"""

from __future__ import annotations

import argparse
import json
import os
import random
import shutil
import sys
import tempfile
import threading
import time
import uuid
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Any, Optional, Sequence

PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT_ROOT))

from backend.modules.library import suno_stage  # noqa: E402

DEFAULT_COUNT = 200_000
DEFAULT_SEED = 20260918
#: Bytes of JSONL a single generated record costs, measured over the default
#: shape. Used only to size the free-space guard before anything is written.
ESTIMATED_RECORD_BYTES = 5_500

MALFORMED_SHARE = 0.01
DUPLICATE_SHARE = 0.05
REVISION_SHARE = 0.02
HOT_TITLE_SHARE = 0.25
LINEAGE_FORWARD_SHARE = 0.12
LINEAGE_BACKWARD_SHARE = 0.06
LINEAGE_DANGLING_SHARE = 0.02

WORDS = (
    "neon",
    "rain",
    "midnight",
    "chrome",
    "ember",
    "static",
    "velvet",
    "harbor",
    "glass",
    "fever",
    "lantern",
    "cinder",
    "murmur",
    "hollow",
    "sable",
    "drift",
    "aurora",
    "quartz",
    "tundra",
    "salt",
    "echo",
    "pulse",
    "orbit",
    "paper",
    "wire",
    "smoke",
    "copper",
    "winter",
    "tide",
    "lantern",
    "shiver",
    "marrow",
    "signal",
    "cathedral",
    "asphalt",
    "gravity",
    "feral",
    "silver",
    "hazard",
    "bloom",
)
SECTIONS = ("[Intro]", "[Verse]", "[Pre-Chorus]", "[Chorus]", "[Bridge]", "[Outro]")
STYLES = (
    "synthwave, driving, analog",
    "lo-fi hip hop, dusty, warm",
    "orchestral cinematic, swelling",
    "dark techno, industrial, relentless",
    "indie folk, fingerpicked, intimate",
    "drum and bass, liquid, euphoric",
    "shoegaze, washed out, reverb heavy",
)
MODELS = ("chirp-v3-5", "chirp-v4", "chirp-v4-5-plus", "chirp-bluejay", "chirp-v5")
STATUSES = ("complete", "complete", "complete", "complete", "streaming", "submitted")
RELATION_FIELDS = (
    "cover_audio_id",
    "continue_clip_id",
    "extend_clip_id",
    "stem_from_id",
    "edited_clip_id",
)


# ---------------------------------------------------------------------------
# Measurement helpers
# ---------------------------------------------------------------------------


def human_bytes(value: Optional[int]) -> str:
    if value is None:
        return "n/a"
    size = float(value)
    for unit in ("B", "KiB", "MiB", "GiB", "TiB"):
        if abs(size) < 1024 or unit == "TiB":
            return f"{size:,.1f} {unit}" if unit != "B" else f"{int(size):,} B"
        size /= 1024
    return f"{size:,.1f} TiB"


class PeakMemory:
    """Peak resident set of *this* process while the block runs.

    ``psutil`` is already a project dependency (``pyproject.toml``), so no new
    package is introduced. A sampler thread is the measurement; Windows'
    kernel-tracked ``peak_wset`` is only believed when it *rose* while the block
    ran, because it is a process-lifetime high-water mark that never resets —
    charging this block for a spike that happened before it started (generating
    a gigabyte of synthetic cache, say) would be a lie. ``tracemalloc`` is
    deliberately not used: it only sees Python allocations, and the interesting
    memory here (SQLite's page cache, the parser's buffers) is not one of those.
    """

    def __init__(self, interval: float = 0.05) -> None:
        self.interval = interval
        self.peak_bytes = 0
        self.sampled_peak_bytes = 0
        self.process_peak_bytes = 0
        self._entry_peak = 0
        self.source = "unavailable"
        self._stop = threading.Event()
        self._thread: Optional[threading.Thread] = None
        try:
            import psutil

            self._process: Any = psutil.Process()
        except Exception:  # pragma: no cover - psutil is a declared dependency
            self._process = None

    def _sample(self) -> None:
        while not self._stop.is_set():
            try:
                rss = int(self._process.memory_info().rss)
            except Exception:  # pragma: no cover - process introspection failure
                return
            self.sampled_peak_bytes = max(self.sampled_peak_bytes, rss)
            self._stop.wait(self.interval)

    def __enter__(self) -> PeakMemory:
        if self._process is not None:
            info = self._process.memory_info()
            self._entry_peak = int(getattr(info, "peak_wset", 0) or 0)
            self.sampled_peak_bytes = int(getattr(info, "rss", 0) or 0)
            self._thread = threading.Thread(target=self._sample, daemon=True)
            self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=2.0)
        if self._process is None:
            return
        info = self._process.memory_info()
        self.process_peak_bytes = int(getattr(info, "peak_wset", 0) or 0)
        self.sampled_peak_bytes = max(
            self.sampled_peak_bytes, int(getattr(info, "rss", 0) or 0)
        )
        self.peak_bytes = self.sampled_peak_bytes
        self.source = f"psutil.rss sampled every {self.interval}s"
        if self.process_peak_bytes > self._entry_peak:
            # The high-water mark moved during the block, so it is ours.
            self.peak_bytes = max(self.peak_bytes, self.process_peak_bytes)
            self.source = "psutil.peak_wset (rose during the run)"


def database_bytes(stage_root: Path) -> int:
    """Staging database size including its WAL sidecars."""
    database = suno_stage.stage_db_path(stage_root)
    total = 0
    for suffix in ("", "-wal", "-shm"):
        candidate = Path(str(database) + suffix)
        if candidate.exists():
            total += candidate.stat().st_size
    return total


def directory_bytes(root: Path) -> int:
    total = 0
    for directory, _dirnames, filenames in os.walk(root):
        for name in filenames:
            try:
                total += (Path(directory) / name).stat().st_size
            except OSError:
                continue
    return total


# ---------------------------------------------------------------------------
# Synthetic cache generation
# ---------------------------------------------------------------------------


def bench_id(seed: int, index: int) -> str:
    """Deterministic clip id for the ``index``-th fresh record of ``seed``.

    Deriving ids from the index instead of remembering them is what lets the
    generator emit a lineage hint pointing at a song that has not been written
    yet while staying O(1) in memory.
    """
    return str(uuid.uuid5(uuid.NAMESPACE_URL, f"suno-bench/{seed}/{index}"))


def _lyrics(rng: random.Random) -> str:
    lines: list[str] = []
    for _ in range(rng.randint(26, 58)):
        if rng.random() < 0.12:
            lines.append(rng.choice(SECTIONS))
        else:
            lines.append(
                " ".join(
                    rng.choice(WORDS) for _ in range(rng.randint(4, 9))
                ).capitalize()
            )
    return "\n".join(lines)


def _signed_url(kind: str, clip_id: str, rng: random.Random) -> str:
    token = f"{rng.getrandbits(96):024x}"
    return (
        f"https://cdn{rng.randint(1, 4)}.example.invalid/{kind}/{clip_id}"
        f"?token={token}&Expires={1800000000 + rng.randint(0, 9_000_000)}"
        f"&Key-Pair-Id=K{rng.getrandbits(40):010X}"
    )


def _title(rng: random.Random, index: int, hot_titles: Sequence[str]) -> str:
    if hot_titles and rng.random() < HOT_TITLE_SHARE:
        return rng.choice(hot_titles)
    if rng.random() < 0.01:
        return ""
    return f"{rng.choice(WORDS).capitalize()} {rng.choice(WORDS).capitalize()} {index}"


def _lineage(
    rng: random.Random, seed: int, index: int, expected_fresh: int
) -> tuple[dict[str, Any], dict[str, Any]]:
    """Explicit derivation hints for one record: ``(metadata part, root part)``."""
    meta: dict[str, Any] = {}
    root: dict[str, Any] = {}
    roll = rng.random()
    if roll < LINEAGE_FORWARD_SHARE:
        ahead = index + rng.randint(1, 5000)
        parent = bench_id(seed, min(ahead, max(expected_fresh - 1, 0)))
        meta[rng.choice(RELATION_FIELDS)] = parent
        root["ancestry"] = {"parent_id": parent, "parent_ids": [parent]}
    elif roll < LINEAGE_FORWARD_SHARE + LINEAGE_BACKWARD_SHARE and index > 0:
        behind = max(0, index - rng.randint(1, min(index, 5000)))
        meta[rng.choice(RELATION_FIELDS)] = bench_id(seed, behind)
    elif roll < LINEAGE_FORWARD_SHARE + LINEAGE_BACKWARD_SHARE + LINEAGE_DANGLING_SHARE:
        # A parent that is not in this cache at all: the edge must survive
        # unresolved and the child must never be dropped.
        meta["mashup_clip_ids"] = [
            bench_id(seed, expected_fresh + rng.randint(1, 10_000)) for _ in range(2)
        ]
    return meta, root


def _record(
    rng: random.Random,
    seed: int,
    index: int,
    expected_fresh: int,
    hot_titles: Sequence[str],
) -> dict[str, Any]:
    clip_id = bench_id(seed, index)
    lyrics = _lyrics(rng)
    duration = round(rng.uniform(31.0, 361.0), 2)
    meta_lineage, root_lineage = _lineage(rng, seed, index, expected_fresh)
    history = [
        {
            "id": bench_id(seed, max(0, index - step)),
            "type": rng.choice(("gen", "extend", "cover")),
            "continue_at": round(rng.uniform(0.0, duration), 2),
            "infill": False,
        }
        for step in range(1, rng.randint(1, 4))
    ]
    record: dict[str, Any] = {
        "id": clip_id,
        "video_url": _signed_url("video", clip_id, rng),
        "audio_url": _signed_url("audio", clip_id, rng),
        "image_url": _signed_url("image", clip_id, rng),
        "image_large_url": _signed_url("image-large", clip_id, rng),
        "is_video_pending": False,
        "major_model_version": rng.choice(("v3", "v4", "v5")),
        "model_name": rng.choice(MODELS),
        "metadata": {
            "tags": rng.choice(STYLES),
            "prompt": lyrics,
            "gpt_description_prompt": " ".join(
                rng.choice(WORDS) for _ in range(rng.randint(8, 20))
            ),
            "audio_prompt_id": None,
            "history": history,
            "concat_history": history[:1],
            "type": "gen",
            "duration": duration,
            "duration_formatted": f"{int(duration) // 60}:{int(duration) % 60:02d}",
            "refund_credits": False,
            "stream": True,
            "infill": False,
            "has_vocal": rng.random() < 0.85,
            "error_type": None,
            "error_message": None,
            "style": rng.choice(STYLES),
            "lyrics": lyrics,
            **meta_lineage,
        },
        "is_liked": rng.random() < 0.2,
        "user_id": bench_id(seed, -(index % 97) - 1),
        "display_name": f"user_{index % 97}",
        "handle": f"handle_{index % 97}",
        "is_handle_updated": True,
        "avatar_image_url": _signed_url("avatar", clip_id, rng),
        "is_trashed": False,
        "reaction": None,
        "created_at": (
            f"2026-{rng.randint(1, 9):02d}-{rng.randint(1, 28):02d}"
            f"T{rng.randint(0, 23):02d}:{rng.randint(0, 59):02d}:00.000Z"
        ),
        "status": rng.choice(STATUSES),
        "title": _title(rng, index, hot_titles),
        "play_count": rng.randint(0, 5000),
        "upvote_count": rng.randint(0, 900),
        "is_public": rng.random() < 0.3,
        **root_lineage,
    }
    if rng.random() < 0.03:
        # Credentials the sanitizer has to strip; they must never reach the DB.
        record["cookie"] = f"session={rng.getrandbits(128):032x}"
    return record


def _malformed(rng: random.Random, index: int) -> str:
    choice = index % 4
    if choice == 0:
        return '{"id": "' + bench_id(0, index) + '", "title": "truncated'
    if choice == 1:
        return json.dumps(["an array, not an object", index])
    if choice == 2:
        return json.dumps({"title": "no id at all", "status": "complete"})
    return json.dumps({"id": "", "title": "blank id"})


@dataclass
class GeneratedCache:
    path: Path
    lines: int
    fresh: int
    duplicates: int
    revisions: int
    malformed: int
    bytes: int
    seconds: float

    def to_dict(self) -> dict[str, Any]:
        payload = asdict(self)
        payload["path"] = str(self.path)
        return payload


def generate_jsonl(
    path: Path, count: int, seed: int, *, progress_seconds: float = 3.0
) -> GeneratedCache:
    """Write ``count`` JSONL lines of synthetic cache and describe what went in.

    Memory stays flat: ids are derived from the index and only a short ring of
    recent records is kept so duplicates and revisions have something to repeat.
    """
    if count <= 0:
        raise ValueError("count must be positive")
    rng = random.Random(seed)
    hot_titles = [
        f"{rng.choice(WORDS).capitalize()} {rng.choice(WORDS).capitalize()}"
        for _ in range(max(4, count // 400))
    ]
    expected_fresh = max(
        1, int(count * (1 - MALFORMED_SHARE - DUPLICATE_SHARE - REVISION_SHARE))
    )
    recent: list[dict[str, Any]] = []
    fresh = duplicates = revisions = malformed = 0
    index = 0
    started = time.perf_counter()
    last_report = started
    path.parent.mkdir(parents=True, exist_ok=True)
    with path.open("w", encoding="utf-8", newline="\n") as handle:
        for line_number in range(count):
            roll = rng.random()
            if roll < MALFORMED_SHARE:
                handle.write(_malformed(rng, line_number) + "\n")
                malformed += 1
            elif roll < MALFORMED_SHARE + DUPLICATE_SHARE and recent:
                handle.write(json.dumps(rng.choice(recent), ensure_ascii=False) + "\n")
                duplicates += 1
            elif roll < MALFORMED_SHARE + DUPLICATE_SHARE + REVISION_SHARE and recent:
                revised = dict(rng.choice(recent))
                revised["title"] = f"{revised.get('title', '')} (remaster)"
                revised["play_count"] = int(revised.get("play_count", 0)) + 1
                handle.write(json.dumps(revised, ensure_ascii=False) + "\n")
                revisions += 1
            else:
                record = _record(rng, seed, index, expected_fresh, hot_titles)
                index += 1
                fresh += 1
                handle.write(json.dumps(record, ensure_ascii=False) + "\n")
                recent.append(record)
                if len(recent) > 64:
                    recent.pop(0)
            now = time.perf_counter()
            if progress_seconds > 0 and now - last_report >= progress_seconds:
                last_report = now
                done = line_number + 1
                print(
                    f"  generating {done:,}/{count:,} "
                    f"({done / max(now - started, 1e-9):,.0f} rec/s)",
                    file=sys.stderr,
                )
    seconds = time.perf_counter() - started
    return GeneratedCache(
        path=path,
        lines=count,
        fresh=fresh,
        duplicates=duplicates,
        revisions=revisions,
        malformed=malformed,
        bytes=path.stat().st_size,
        seconds=seconds,
    )


def jsonl_to_json(source: Path, target: Path) -> GeneratedCache:
    """Rewrite a JSONL corpus as ``{"songs": [...]}`` without loading it.

    Malformed JSONL lines cannot be embedded in a JSON array and are replaced by
    a structurally valid object that is still unusable to the stager (no id), so
    both formats quarantine the same number of records.
    """
    started = time.perf_counter()
    lines = fresh = malformed = 0
    with (
        source.open("r", encoding="utf-8") as reader,
        target.open("w", encoding="utf-8", newline="\n") as writer,
    ):
        writer.write('{"generated_by": "bench_suno_stage", "songs": [')
        for line in reader:
            text = line.strip()
            if not text:
                continue
            try:
                json.loads(text)
            except ValueError:
                text = json.dumps({"title": "unparseable in the JSONL twin"})
                malformed += 1
            else:
                fresh += 1
            writer.write(("" if lines == 0 else ",") + text)
            lines += 1
        writer.write("]}")
    return GeneratedCache(
        path=target,
        lines=lines,
        fresh=fresh,
        duplicates=0,
        revisions=0,
        malformed=malformed,
        bytes=target.stat().st_size,
        seconds=time.perf_counter() - started,
    )


def make_media_files(root: Path, count: int, seed: int, shards: int = 256) -> float:
    """Create ``count`` tiny id-named audio files. Returns seconds taken."""
    started = time.perf_counter()
    root.mkdir(parents=True, exist_ok=True)
    made_dirs: set[str] = set()
    for index in range(count):
        clip_id = bench_id(seed, index)
        shard = clip_id[:2] if shards > 1 else ""
        directory = root / shard if shard else root
        if shard and shard not in made_dirs:
            directory.mkdir(exist_ok=True)
            made_dirs.add(shard)
        (directory / f"{clip_id}.mp3").write_bytes(b"ID3\x04\x00\x00\x00\x00\x00\x00")
    return time.perf_counter() - started


# ---------------------------------------------------------------------------
# The stdlib stand-in used only when ijson is absent
# ---------------------------------------------------------------------------

SHIM_SOURCE = '''"""Throwaway stdlib stand-in for ijson, written by bench_suno_stage.

NOT a streaming parser: it parses the whole document with ``json.load`` and then
yields the requested prefix. It exists so the ``{"songs": [...]}`` code path can
be exercised on a machine where ijson is not installed. Throughput measured
through this module says nothing about ijson.
"""

import json

backend = "bench-stdlib-shim"


def items(handle, prefix, use_float=False):
    document = json.load(handle)
    if prefix in ("", "item"):
        source = document
    else:
        source = document
        for part in prefix.split(".")[:-1]:
            source = source[part]
    for value in source:
        yield value
'''


def install_json_shim(directory: Path) -> Path:
    """Write the stand-in package into ``directory`` and put it on ``sys.path``."""
    package = directory / "ijson"
    package.mkdir(parents=True, exist_ok=True)
    (package / "__init__.py").write_text(SHIM_SOURCE, encoding="utf-8")
    backends = package / "backends"
    backends.mkdir(exist_ok=True)
    (backends / "__init__.py").write_text("", encoding="utf-8")
    (backends / "python.py").write_text(
        "from ijson import backend, items  # noqa: F401\n", encoding="utf-8"
    )
    sys.path.insert(0, str(directory))
    return package


# ---------------------------------------------------------------------------
# One staging run
# ---------------------------------------------------------------------------


@dataclass
class BenchResult:
    label: str
    source: str
    source_bytes: int
    records: int
    seconds: float
    records_per_second: float
    peak_rss_bytes: int
    peak_rss_source: str
    #: Process-lifetime high-water mark, which includes generating the corpus.
    #: Reported separately so it is never mistaken for the staging peak.
    process_peak_rss_bytes: int
    database_bytes: int
    digest_seconds: float
    #: Time to build a MediaIndex over ``media_files`` files, measured on its
    #: own. ``stage_cache`` builds its own index internally, so when this is set
    #: the staging wall time below includes a second build of the same index.
    media_index_seconds: Optional[float] = None
    media_files: int = 0
    report: dict[str, Any] = field(default_factory=dict)
    reconciles: bool = False

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


def run_stage(
    label: str,
    source: Path,
    stage_root: Path,
    *,
    batch_size: int,
    media_root: Optional[Path],
    media_files: int,
    progress_seconds: float,
    json_prefix: str,
    total_records: Optional[int] = None,
) -> BenchResult:
    digest_started = time.perf_counter()
    suno_stage.digest_file(source)
    digest_seconds = time.perf_counter() - digest_started

    media_index_seconds: Optional[float] = None
    if media_root is not None:
        index_started = time.perf_counter()
        suno_stage.MediaIndex(media_root)
        media_index_seconds = time.perf_counter() - index_started
        print(
            f"  MediaIndex over {media_files:,} files: {media_index_seconds:,.2f}s",
            file=sys.stderr,
        )

    last_print = [time.perf_counter()]

    def on_commit(progress: Any) -> None:
        now = time.perf_counter()
        if progress_seconds <= 0 or now - last_print[0] < progress_seconds:
            return
        last_print[0] = now
        print(f"  {_progress_line(progress)}", file=sys.stderr)

    started = time.perf_counter()
    with PeakMemory() as memory:
        report = suno_stage.stage_cache(
            source,
            stage_root,
            batch_size=batch_size,
            media_root=media_root,
            json_prefix=json_prefix,
            on_commit=on_commit,
            total_records=total_records,
        )
    seconds = time.perf_counter() - started
    payload = report.to_dict()
    return BenchResult(
        label=label,
        source=str(source),
        source_bytes=source.stat().st_size,
        records=report.seen,
        seconds=seconds,
        records_per_second=report.seen / seconds if seconds > 0 else 0.0,
        peak_rss_bytes=memory.peak_bytes,
        peak_rss_source=memory.source,
        process_peak_rss_bytes=memory.process_peak_bytes,
        database_bytes=database_bytes(stage_root),
        digest_seconds=digest_seconds,
        media_index_seconds=media_index_seconds,
        media_files=media_files,
        report=payload,
        reconciles=report.reconciles,
    )


def _progress_line(progress: suno_stage.StageProgress) -> str:
    parts = [
        f"{progress.seen:,} seen",
        f"{progress.records_per_second:,.0f} rec/s",
        f"{progress.quarantined:,} quarantined",
        f"{progress.elapsed_seconds:,.1f}s elapsed",
    ]
    if progress.eta_seconds is not None:
        parts.append(f"ETA {progress.eta_seconds:,.0f}s")
    return ", ".join(parts)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description="Generate a synthetic Suno cache and benchmark the stager",
    )
    parser.add_argument(
        "--count", type=int, default=DEFAULT_COUNT, help="Records to generate"
    )
    parser.add_argument("--seed", type=int, default=DEFAULT_SEED)
    parser.add_argument(
        "--work-dir",
        type=Path,
        default=None,
        help="Where the synthetic cache lives (a drive with room). "
        "Defaults to a fresh temp directory; deleted unless --keep.",
    )
    parser.add_argument(
        "--formats",
        default="jsonl",
        help="Comma-separated: jsonl, json (default: jsonl)",
    )
    parser.add_argument(
        "--media-files",
        type=int,
        default=0,
        help="Create N tiny id-named files and time the MediaIndex over them",
    )
    parser.add_argument("--batch-size", type=int, default=suno_stage.DEFAULT_BATCH_SIZE)
    parser.add_argument("--json-prefix", default=suno_stage.DEFAULT_JSON_PREFIX)
    parser.add_argument(
        "--progress-seconds",
        type=float,
        default=5.0,
        help="Seconds between progress lines on stderr (0 disables)",
    )
    parser.add_argument(
        "--json-stdlib-shim",
        action="store_true",
        help="When ijson is missing, exercise the JSON path through a "
        "non-streaming stdlib stand-in (wiring only, not a throughput number)",
    )
    parser.add_argument(
        "--keep", action="store_true", help="Keep the synthetic data afterwards"
    )
    parser.add_argument(
        "--json-out", type=Path, default=None, help="Write the results as JSON here"
    )
    return parser


def _check_space(work_dir: Path, count: int, formats: Sequence[str]) -> Optional[str]:
    needed = int(
        count * ESTIMATED_RECORD_BYTES * (len(formats) + 1.4 * len(formats)) * 1.2
    )
    probe = work_dir
    while not probe.exists() and probe != probe.parent:
        probe = probe.parent
    free = shutil.disk_usage(probe).free
    if free < needed:
        return (
            f"{work_dir} has {human_bytes(free)} free but this run needs about "
            f"{human_bytes(needed)}. Point --work-dir at a drive with room."
        )
    return None


def main(argv: Optional[Sequence[str]] = None) -> int:
    args = build_parser().parse_args(argv)
    formats = [item.strip() for item in args.formats.split(",") if item.strip()]
    unknown = [item for item in formats if item not in ("jsonl", "json")]
    if unknown:
        print(f"Unknown --formats entries: {unknown}", file=sys.stderr)
        return 1
    if args.count <= 0:
        print("--count must be positive", file=sys.stderr)
        return 1

    owned = args.work_dir is None
    work_dir = (
        Path(tempfile.mkdtemp(prefix="suno-stage-bench-"))
        if owned
        else Path(args.work_dir)
    )
    work_dir.mkdir(parents=True, exist_ok=True)
    problem = _check_space(work_dir, args.count, formats)
    if problem is not None:
        print(problem, file=sys.stderr)
        if owned:
            shutil.rmtree(work_dir, ignore_errors=True)
        return 1

    results: list[BenchResult] = []
    generated: list[dict[str, Any]] = []
    notes: list[str] = []
    try:
        print(f"Work directory: {work_dir}", file=sys.stderr)
        jsonl = work_dir / "library_cache_synthetic.jsonl"
        corpus = generate_jsonl(
            jsonl, args.count, args.seed, progress_seconds=args.progress_seconds
        )
        generated.append(corpus.to_dict())
        print(
            f"Generated {corpus.lines:,} lines "
            f"({human_bytes(corpus.bytes)}, {corpus.seconds:,.1f}s): "
            f"{corpus.fresh:,} fresh, {corpus.duplicates:,} duplicate, "
            f"{corpus.revisions:,} revision, {corpus.malformed:,} malformed",
            file=sys.stderr,
        )

        media_root: Optional[Path] = None
        if args.media_files > 0:
            media_root = work_dir / "media"
            elapsed = make_media_files(media_root, args.media_files, args.seed)
            print(
                f"Created {args.media_files:,} media files in {elapsed:,.1f}s",
                file=sys.stderr,
            )

        if "jsonl" in formats:
            print("Staging the JSONL corpus...", file=sys.stderr)
            results.append(
                run_stage(
                    "jsonl",
                    jsonl,
                    work_dir / "stage-jsonl",
                    batch_size=args.batch_size,
                    media_root=media_root,
                    media_files=args.media_files,
                    progress_seconds=args.progress_seconds,
                    json_prefix=args.json_prefix,
                    total_records=corpus.lines,
                )
            )

        if "json" in formats:
            note = _prepare_json_backend(work_dir, args.json_stdlib_shim)
            notes.append(note)
            print(note, file=sys.stderr)
            if "skipped" in note:
                pass
            else:
                json_path = work_dir / "library_cache_synthetic.json"
                twin = jsonl_to_json(jsonl, json_path)
                generated.append(twin.to_dict())
                print(
                    f"Rewrote as JSON ({human_bytes(twin.bytes)}, "
                    f"{twin.seconds:,.1f}s)",
                    file=sys.stderr,
                )
                print("Staging the JSON corpus...", file=sys.stderr)
                results.append(
                    run_stage(
                        "json",
                        json_path,
                        work_dir / "stage-json",
                        batch_size=args.batch_size,
                        media_root=media_root,
                        media_files=args.media_files,
                        progress_seconds=args.progress_seconds,
                        json_prefix=args.json_prefix,
                        total_records=twin.lines,
                    )
                )
    finally:
        if not args.keep:
            shutil.rmtree(work_dir, ignore_errors=True)
            print(f"Removed {work_dir}", file=sys.stderr)
        else:
            print(
                f"Kept {work_dir} ({human_bytes(directory_bytes(work_dir))})",
                file=sys.stderr,
            )

    payload = {
        "count": args.count,
        "seed": args.seed,
        "batch_size": args.batch_size,
        "generated": generated,
        "notes": notes,
        "results": [result.to_dict() for result in results],
    }
    text = json.dumps(payload, indent=2, ensure_ascii=False)
    if args.json_out is not None:
        args.json_out.parent.mkdir(parents=True, exist_ok=True)
        args.json_out.write_text(text, encoding="utf-8")
    print(text)
    for result in results:
        print(_summary_line(result), file=sys.stderr)
    return 0 if all(result.reconciles for result in results) else 1


def _prepare_json_backend(work_dir: Path, allow_shim: bool) -> str:
    try:
        module, backend = suno_stage.load_ijson()
    except RuntimeError as exc:
        if not allow_shim:
            return (
                f"JSON run skipped: {exc} "
                "(re-run with --json-stdlib-shim to exercise the wiring anyway)"
            )
        install_json_shim(work_dir / "_shim")
        try:
            module, backend = suno_stage.load_ijson()
        except RuntimeError as shim_exc:  # pragma: no cover - shim just written
            return f"JSON run skipped: stand-in failed to load ({shim_exc})"
        return (
            f"JSON run uses the NON-STREAMING stdlib stand-in ({backend}); its "
            "throughput is not an ijson measurement"
        )
    del module
    return f"JSON run uses ijson backend {backend!r}"


def _summary_line(result: BenchResult) -> str:
    media = (
        ""
        if result.media_index_seconds is None
        else (
            f" | MediaIndex {result.media_files:,} files "
            f"{result.media_index_seconds:,.2f}s"
        )
    )
    return (
        f"[{result.label}] {result.records:,} records in {result.seconds:,.1f}s "
        f"= {result.records_per_second:,.0f} rec/s | peak RSS "
        f"{human_bytes(result.peak_rss_bytes)} ({result.peak_rss_source}) | DB "
        f"{human_bytes(result.database_bytes)} | source digest "
        f"{result.digest_seconds:,.2f}s | reconciles={result.reconciles}{media}"
    )


if __name__ == "__main__":
    raise SystemExit(main())
