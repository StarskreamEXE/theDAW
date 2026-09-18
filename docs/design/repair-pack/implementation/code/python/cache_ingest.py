"""Loss-preserving Suno/Harvester import STAGING core; standard-library storage.

JSONL streams without dependencies. Huge {'songs': [...]} JSON streams through
ijson from theDAW's locked environment; this script never pip-installs packages.
This does not write to theDAW's production library. Its catalog is a resumable
staging index for preview/reconciliation before promotion through LibraryStore.
"""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import sqlite3
import tempfile
import uuid
from collections.abc import Iterator, Mapping
from decimal import Decimal
from pathlib import Path
from typing import Any
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

SECRET_KEYS = frozenset({
    "authorization", "cookie", "cookies", "access_token", "refresh_token",
    "api_key", "apikey", "password", "secret", "session_token", "jwt",
})
SECRET_QUERY_KEYS = SECRET_KEYS | {"token", "signature", "x-amz-signature", "key-pair-id", "policy"}


def sanitize(value: Any) -> Any:
    """Preserve unknown metadata, excluding recognizable authentication material.

    This is defense-in-depth, not a claim to detect every possible secret. Keep
    the original archive unchanged and private; don't attach it wholesale to AI.
    """
    if isinstance(value, Mapping):
        return {str(k): ("[REDACTED]" if str(k).lower().replace("-", "_") in SECRET_KEYS
                         else sanitize(v)) for k, v in value.items()}
    if isinstance(value, (list, tuple)):
        return [sanitize(v) for v in value]
    if isinstance(value, Decimal):
        return int(value) if value == value.to_integral_value() else float(value)
    if isinstance(value, str) and value.startswith(("https://", "http://")):
        parts = urlsplit(value)
        # URLs are catalog hints, not credentials; expired signed URLs must refresh.
        netloc = parts.netloc.rsplit("@", 1)[-1]
        query = [(k, "[REDACTED]" if k.lower() in SECRET_QUERY_KEYS else v)
                 for k, v in parse_qsl(parts.query, keep_blank_values=True)]
        return urlunsplit((parts.scheme, netloc, parts.path, urlencode(query), ""))
    return value


def stable_entry_id(namespace: str, external_id: str) -> str:
    return str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([namespace, external_id], ensure_ascii=False)))


def stream_records(path: Path) -> Iterator[dict[str, Any]]:
    """Never accumulate or sort the full cache in memory."""
    if path.suffix.lower() in {".jsonl", ".ndjson"}:
        with path.open("r", encoding="utf-8-sig") as stream:
            for line_no, line in enumerate(stream, 1):
                if not line.strip():
                    continue
                record = json.loads(line)
                if not isinstance(record, dict):
                    raise ValueError(f"JSONL row {line_no} is not an object")
                yield record
        return
    try:
        import ijson
    except ImportError as exc:
        raise RuntimeError("Large JSON needs ijson in the locked environment; alternatively export JSONL") from exc
    with path.open("rb") as stream:
        for record in ijson.items(stream, "songs.item"):
            if not isinstance(record, dict):
                raise ValueError("songs[] must contain objects")
            yield record


def source_file(root: Path, relative: str) -> Path:
    """Resolve a manifest path inside an explicitly approved import root.

    The source tree must remain stable while staging. For actively hostile trees,
    use platform-specific no-follow file handles or copy to an isolated snapshot.
    """
    relative_path = Path(relative)
    if relative_path.is_absolute() or ".." in relative_path.parts:
        raise ValueError("Only root-relative paths without '..' are accepted")
    base = root.resolve(strict=True)
    path = (base / relative_path).resolve(strict=True)
    if not path.is_relative_to(base) or not path.is_file():
        raise ValueError("Source escapes approved root or is not a file")
    return path


def hash_file(path: Path) -> tuple[str, int]:
    digest = hashlib.sha256()
    size = 0
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
            size += len(block)
    return digest.hexdigest(), size


class ArchiveStager:
    """Single-writer, resumable staging. Duplicate titles remain distinct.

    External ID identifies the catalog item; SHA-256 identifies file bytes. A
    changed file for the same item creates a retained version, not silent reuse.
    Files are durable before rows reference them. An interrupted DB commit may
    leave an unreferenced object; recovery/GC may remove it after a grace period.
    """
    def __init__(self, stage_root: Path, source_root: Path, namespace: str = "suno") -> None:
        self.root = stage_root.resolve()
        self.source_root = source_root.resolve(strict=True)
        self.namespace = namespace
        self.root.mkdir(parents=True, exist_ok=True)
        (self.root / "objects").mkdir(exist_ok=True)
        self.db = sqlite3.connect(self.root / "stage.sqlite3")
        self.db.row_factory = sqlite3.Row
        self.db.execute("PRAGMA foreign_keys=ON")
        self.db.execute("PRAGMA journal_mode=WAL")
        self.db.executescript('''
        CREATE TABLE IF NOT EXISTS objects(
            sha256 TEXT PRIMARY KEY, relpath TEXT NOT NULL, bytes INTEGER NOT NULL);
        CREATE TABLE IF NOT EXISTS items(
            id TEXT PRIMARY KEY, namespace TEXT NOT NULL, external_id TEXT NOT NULL,
            title TEXT NOT NULL, current_version_id TEXT,
            availability TEXT NOT NULL, metadata_json TEXT NOT NULL,
            UNIQUE(namespace, external_id));
        CREATE TABLE IF NOT EXISTS versions(
            id TEXT PRIMARY KEY, item_id TEXT NOT NULL REFERENCES items(id),
            audio_sha TEXT REFERENCES objects(sha256), metadata_sha TEXT NOT NULL,
            metadata_json TEXT NOT NULL, UNIQUE(item_id, metadata_sha, audio_sha));
        CREATE TABLE IF NOT EXISTS artwork(
            item_id TEXT NOT NULL REFERENCES items(id), sha256 TEXT NOT NULL REFERENCES objects(sha256),
            role TEXT NOT NULL DEFAULT 'cover', PRIMARY KEY(item_id, sha256, role));
        CREATE TABLE IF NOT EXISTS relations(
            child_id TEXT NOT NULL REFERENCES items(id), parent_external_id TEXT NOT NULL,
            kind TEXT NOT NULL, evidence TEXT NOT NULL,
            PRIMARY KEY(child_id, parent_external_id, kind));
        CREATE TABLE IF NOT EXISTS record_errors(
            record_number INTEGER NOT NULL, external_id TEXT, error TEXT NOT NULL);
        ''')

    def close(self) -> None:
        self.db.close()

    def _store_object(self, path: Path) -> tuple[str, str, int]:
        # Hash the same bytes we write, so source changes do not mismatch filename/hash.
        fd, temp_name = tempfile.mkstemp(prefix="incoming-", dir=self.root / "objects")
        temp = Path(temp_name)
        digest = hashlib.sha256()
        size = 0
        try:
            with os.fdopen(fd, "wb") as dest, path.open("rb") as source:
                for block in iter(lambda: source.read(1024 * 1024), b""):
                    dest.write(block); digest.update(block); size += len(block)
                dest.flush(); os.fsync(dest.fileno())
            sha = digest.hexdigest()
            final = self.root / "objects" / sha[:2] / sha
            final.parent.mkdir(exist_ok=True)
            if final.exists():
                existing_hash, existing_size = hash_file(final)
                if existing_hash != sha or existing_size != size:
                    raise OSError("Corrupt content-addressed object; refusing reuse")
                temp.unlink()
            else:
                os.replace(temp, final)
            return sha, final.relative_to(self.root).as_posix(), size
        finally:
            temp.unlink(missing_ok=True)

    def stage(self, record: Mapping[str, Any]) -> dict[str, Any]:
        raw_id = record.get("id")
        if not isinstance(raw_id, str) or not raw_id.strip():
            raise ValueError("Record requires a nonempty stable string id")
        external_id = raw_id.strip()
        item_id = stable_entry_id(self.namespace, external_id)
        clean = sanitize(dict(record))
        metadata_json = json.dumps(clean, ensure_ascii=False, sort_keys=True, allow_nan=False, separators=(",", ":"))
        metadata_sha = hashlib.sha256(metadata_json.encode()).hexdigest()
        title = str(record.get("title") or f"Untitled {external_id[:8]}")
        media: list[tuple[str, tuple[str, str, int]]] = []
        # Adapter populates these fields after deterministic ID-based discovery.
        # Never guess same-title media matches and never fetch a URL here.
        for field in ("local_audio_path", "local_artwork_path"):
            relative = record.get(field)
            if relative is not None:
                if not isinstance(relative, str) or not relative:
                    raise ValueError(f"{field} must be a root-relative string")
                media.append((field, self._store_object(source_file(self.source_root, relative))))
        audio = next((obj[0] for field, obj in media if field == "local_audio_path"), None)
        availability = "local" if audio else "remote-only" if record.get("audio_url") else "metadata-only"
        version_id = str(uuid.uuid5(uuid.NAMESPACE_URL, json.dumps([item_id, audio, metadata_sha])))
        meta = record.get("metadata") or {}
        if not isinstance(meta, Mapping):
            raise ValueError("metadata must be an object")
        edges: list[tuple[str, str, str]] = []
        for field, kind in (("cover_audio_id", "cover_of"), ("continue_clip_id", "extension_of"),
                            ("stem_of", "stem_of")):
            parent = meta.get(field) or record.get(field)
            if isinstance(parent, str) and parent.strip():
                edges.append((parent, kind, f"explicit:{field}"))
        parents = meta.get("mashup_clip_ids") or []
        if not isinstance(parents, list):
            raise ValueError("mashup_clip_ids must be an array")
        for parent in parents:
            if isinstance(parent, str) and parent:
                edges.append((parent, "mashup_source", "explicit:metadata.mashup_clip_ids"))
        with self.db:
            for _, (sha, relpath, size) in media:
                self.db.execute("INSERT OR IGNORE INTO objects VALUES(?,?,?)", (sha, relpath, size))
            # Keep same-title entries; never overwrite the original cache.
            self.db.execute('''INSERT INTO items VALUES(?,?,?,?,?,?,?)
                ON CONFLICT(id) DO UPDATE SET title=excluded.title,
                current_version_id=excluded.current_version_id, availability=excluded.availability,
                metadata_json=excluded.metadata_json''',
                (item_id, self.namespace, external_id, title, version_id, availability, metadata_json))
            self.db.execute("INSERT OR IGNORE INTO versions VALUES(?,?,?,?,?)",
                            (version_id, item_id, audio, metadata_sha, metadata_json))
            for field, (sha, _, _) in media:
                if field == "local_artwork_path":
                    self.db.execute("INSERT OR IGNORE INTO artwork(item_id,sha256) VALUES(?,?)", (item_id, sha))
            for parent, kind, evidence in edges:
                if parent != external_id:
                    self.db.execute("INSERT OR IGNORE INTO relations VALUES(?,?,?,?)", (item_id, parent, kind, evidence))
        return {"id": item_id, "external_id": external_id, "version_id": version_id, "availability": availability}

    def summary(self) -> dict[str, int]:
        return {table: self.db.execute(f"SELECT COUNT(*) FROM {table}").fetchone()[0]
                for table in ("items", "versions", "objects", "artwork", "relations", "record_errors")}


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("cache", type=Path)
    parser.add_argument("--source-root", type=Path, required=True)
    parser.add_argument("--stage-root", type=Path, required=True)
    parser.add_argument("--namespace", default="suno")
    args = parser.parse_args()
    stager = ArchiveStager(args.stage_root, args.source_root, args.namespace)
    try:
        for number, record in enumerate(stream_records(args.cache), 1):
            try:
                stager.stage(record)
            except (ValueError, OSError, TypeError) as exc:
                with stager.db:
                    stager.db.execute("INSERT INTO record_errors VALUES(?,?,?)", (number, str(record.get("id", "")), str(exc)))
        print(json.dumps(stager.summary(), indent=2))
    finally:
        stager.close()


if __name__ == "__main__":
    main()
