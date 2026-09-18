"""Read a Suno/Harvester cache into a NEW staging database. Never writes to theDAW.
JSONL uses only the standard library. Large JSON requires the project's ijson dependency.
Preserves same-title/different-ID records, all raw JSON values, revisions and edge proposals.
Artwork/audio URLs are indexed; media downloading and app promotion are integration work.
"""
from __future__ import annotations
import argparse
from datetime import datetime, timezone
import hashlib
import json
import math
from pathlib import Path
import sqlite3
from typing import Any, Iterator
import uuid

NAMESPACE = uuid.UUID('9762ec61-2c5b-449b-922f-44944bb141b0')
SCHEMA = """
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS import_runs(
 id TEXT PRIMARY KEY, source_path TEXT NOT NULL, source_sha256 TEXT NOT NULL,
 provider TEXT NOT NULL, status TEXT NOT NULL, checkpoint INTEGER NOT NULL DEFAULT 0,
 processed INTEGER NOT NULL DEFAULT 0, quarantined INTEGER NOT NULL DEFAULT 0, error TEXT);
CREATE TABLE IF NOT EXISTS staged_assets(
 id TEXT PRIMARY KEY, provider TEXT NOT NULL, external_id TEXT NOT NULL,
 title TEXT NOT NULL, media_status TEXT NOT NULL, duration REAL,
 audio_url TEXT, artwork_json TEXT NOT NULL, selected_record_hash TEXT NOT NULL,
 observed_at TEXT NOT NULL, UNIQUE(provider,external_id));
CREATE TABLE IF NOT EXISTS raw_records(
 provider TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 raw_json TEXT NOT NULL, PRIMARY KEY(provider,external_id,content_hash));
CREATE TABLE IF NOT EXISTS run_records(
 run_id TEXT NOT NULL REFERENCES import_runs(id), ordinal INTEGER NOT NULL,
 provider TEXT NOT NULL, external_id TEXT NOT NULL, content_hash TEXT NOT NULL,
 PRIMARY KEY(run_id,ordinal));
CREATE TABLE IF NOT EXISTS edge_proposals(
 provider TEXT NOT NULL, child_external_id TEXT NOT NULL, parent_external_id TEXT NOT NULL,
 relation TEXT NOT NULL, evidence_path TEXT NOT NULL, record_hash TEXT NOT NULL,
 PRIMARY KEY(provider,child_external_id,parent_external_id,relation,evidence_path,record_hash));
CREATE INDEX IF NOT EXISTS edge_parent ON edge_proposals(provider,parent_external_id);
CREATE TABLE IF NOT EXISTS quarantine(
 run_id TEXT NOT NULL, ordinal INTEGER NOT NULL, error TEXT NOT NULL, raw_json TEXT NOT NULL,
 PRIMARY KEY(run_id,ordinal));
"""

def dump(value: Any) -> str:
    return json.dumps(value, ensure_ascii=False, sort_keys=True, separators=(',', ':'), allow_nan=False)

def stable_asset_id(provider: str, external_id: str) -> str:
    return str(uuid.uuid5(NAMESPACE, f'{provider}:{external_id}'))

def digest_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open('rb') as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b''):
            digest.update(chunk)
    return digest.hexdigest()

def normalized_timestamp(value: Any) -> str:
    if not isinstance(value, str) or not value:
        return ''
    try:
        dt = datetime.fromisoformat(value.replace('Z', '+00:00'))
        if dt.tzinfo is None:
            dt = dt.replace(tzinfo=timezone.utc)
        return dt.astimezone(timezone.utc).isoformat()
    except ValueError:
        return ''

def normalize_record(raw: Any, provider: str = 'suno') -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise ValueError('Record is not an object')
    external_id = raw.get('id')
    if not isinstance(external_id, str) or not external_id.strip():
        raise ValueError('Missing stable provider ID; title matching is forbidden')
    meta = raw.get('metadata') if isinstance(raw.get('metadata'), dict) else {}
    duration = meta.get('duration', raw.get('duration'))
    if isinstance(duration, bool) or not isinstance(duration, (int, float)) or not math.isfinite(duration) or duration < 0:
        duration = None
    artwork = {key: raw[key] for key in ('image_url', 'image_large_url', 'video_cover_url', 'preview_url') if raw.get(key)}
    title = raw.get('title') if isinstance(raw.get('title'), str) else ''
    audio_url = raw.get('audio_url') if isinstance(raw.get('audio_url'), str) else None
    raw_json = dump(raw)
    record_hash = hashlib.sha256(raw_json.encode('utf-8')).hexdigest()
    observed = next((stamp for key in ('last_updated', '_enriched_at', 'created_at')
                     if (stamp := normalized_timestamp(raw.get(key)))), '')
    return dict(id=stable_asset_id(provider, external_id), provider=provider, external_id=external_id,
                title=title, media_status='remote-unverified' if audio_url else 'missing', duration=duration,
                audio_url=audio_url, artwork_json=dump(artwork), selected_record_hash=record_hash,
                observed_at=observed, raw_json=raw_json)

RELATION_FIELDS = {
    'cover_clip_id': 'cover-of', 'edited_clip_id': 'edit-of', 'upsample_clip_id': 'upsample-of',
    'overpainting_clip_id': 'overpaint-of', 'underpainting_clip_id': 'underpaint-of',
    'stem_from_id': 'stem-of', 'speed_clip_id': 'speed-change-of',
}

def relationship_proposals(raw: dict[str, Any]) -> Iterator[tuple[str, str, str]]:
    """Yield parent ID, relation, evidence path. Ancestor chains are NOT direct parents.
    Artist/persona/style references are not assumed to be audio derivations.
    """
    meta = raw.get('metadata') if isinstance(raw.get('metadata'), dict) else {}
    for key, relation in RELATION_FIELDS.items():
        parent = meta.get(key)
        if isinstance(parent, str) and parent:
            yield parent, relation, f'metadata.{key}'
    ancestry = raw.get('ancestry') if isinstance(raw.get('ancestry'), dict) else {}
    parent = ancestry.get('parent_id')
    if isinstance(parent, str) and parent:
        yield parent, 'derived-from-unspecified', 'ancestry.parent_id'
    parents = ancestry.get('parent_ids', [])
    if isinstance(parents, list):
        for index, value in enumerate(parents):
            parent = value if isinstance(value, str) else (value.get('parent_id') or value.get('clip_id')) if isinstance(value, dict) else None
            if isinstance(parent, str) and parent:
                yield parent, 'derived-from-unspecified', f'ancestry.parent_ids[{index}]'


def iter_records(path: Path, prefix: str = 'songs.item') -> Iterator[tuple[int, Any]]:
    if path.suffix.lower() in ('.jsonl', '.ndjson'):
        with path.open('r', encoding='utf-8-sig') as handle:
            for ordinal, line in enumerate(handle, 1):
                if line.strip():
                    yield ordinal, line
        return
    try:
        import ijson
    except ImportError as exc:
        raise RuntimeError('Large JSON requires ijson in your reviewed project environment; this script never installs packages.') from exc
    with path.open('rb') as handle:
        for ordinal, value in enumerate(ijson.items(handle, prefix, use_float=True), 1):
            yield ordinal, value


def import_cache(source: Path, database: Path, provider: str = 'suno', prefix: str = 'songs.item', batch_size: int = 500) -> dict[str, Any]:
    if batch_size <= 0:
        raise ValueError('batch_size must be positive')
    source = source.resolve(strict=True)
    database = database.resolve()
    if source == database:
        raise ValueError('Staging database cannot be the input file')
    initial_stat = source.stat()
    fingerprint = digest_file(source)
    run_id = hashlib.sha256(f'{provider}:{fingerprint}:{prefix}'.encode()).hexdigest()
    database.parent.mkdir(parents=True, exist_ok=True)
    connection = sqlite3.connect(database)
    connection.row_factory = sqlite3.Row
    try:
        tables = {row[0] for row in connection.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if tables and 'import_runs' not in tables:
            raise ValueError('Refusing an existing non-staging database; select a new staging path')
        connection.executescript(SCHEMA)
        connection.execute('PRAGMA journal_mode=WAL')
        connection.execute('INSERT OR IGNORE INTO import_runs(id,source_path,source_sha256,provider,status) VALUES(?,?,?,?,?)',
                           (run_id, str(source), fingerprint, provider, 'staging'))
        old = connection.execute('SELECT * FROM import_runs WHERE id=?', (run_id,)).fetchone()
        checkpoint, processed, quarantined = old['checkpoint'], old['processed'], old['quarantined']
        if old['status'] != 'complete':
            connection.execute('UPDATE import_runs SET status=?,error=NULL WHERE id=?', ('staging', run_id))
            connection.commit()
            pending = 0
            last_ordinal = checkpoint
            try:
                for ordinal, value in iter_records(source, prefix):
                    if ordinal <= checkpoint:
                        continue
                    last_ordinal = ordinal
                    try:
                        raw = json.loads(value) if isinstance(value, str) else value
                        row = normalize_record(raw, provider)
                        existing = connection.execute('SELECT observed_at,selected_record_hash FROM staged_assets WHERE id=?', (row['id'],)).fetchone()
                        if existing is None:
                            connection.execute('''INSERT INTO staged_assets VALUES(:id,:provider,:external_id,:title,:media_status,
                                :duration,:audio_url,:artwork_json,:selected_record_hash,:observed_at)''', row)
                        elif (row['observed_at'], row['selected_record_hash']) > (existing['observed_at'], existing['selected_record_hash']):
                            connection.execute('''UPDATE staged_assets SET title=:title,media_status=:media_status,duration=:duration,
                                audio_url=:audio_url,artwork_json=:artwork_json,selected_record_hash=:selected_record_hash,
                                observed_at=:observed_at WHERE id=:id''', row)
                        connection.execute('INSERT OR IGNORE INTO raw_records VALUES(?,?,?,?)',
                                           (provider, row['external_id'], row['selected_record_hash'], row['raw_json']))
                        connection.execute('INSERT OR REPLACE INTO run_records VALUES(?,?,?,?,?)',
                                           (run_id, ordinal, provider, row['external_id'], row['selected_record_hash']))
                        for parent, relation, evidence in relationship_proposals(raw):
                            connection.execute('INSERT OR IGNORE INTO edge_proposals VALUES(?,?,?,?,?,?)',
                                               (provider, row['external_id'], parent, relation, evidence, row['selected_record_hash']))
                        processed += 1
                    except (ValueError, TypeError, OverflowError) as exc:
                        serialized = value if isinstance(value, str) else repr(value)
                        connection.execute('INSERT OR REPLACE INTO quarantine VALUES(?,?,?,?)', (run_id, ordinal, str(exc), serialized))
                        quarantined += 1
                    pending += 1
                    if pending >= batch_size:
                        connection.execute('UPDATE import_runs SET checkpoint=?,processed=?,quarantined=? WHERE id=?',
                                           (ordinal, processed, quarantined, run_id))
                        connection.commit()
                        pending = 0
                final_stat = source.stat()
                if (initial_stat.st_size, initial_stat.st_mtime_ns) != (final_stat.st_size, final_stat.st_mtime_ns):
                    raise RuntimeError('Source changed during ingestion. Freeze a source snapshot before promotion.')
                if last_ordinal == 0:
                    raise RuntimeError('No records found. Check JSON prefix; no empty import will be marked complete.')
                connection.execute('UPDATE import_runs SET status=?,checkpoint=?,processed=?,quarantined=? WHERE id=?',
                                   ('complete', last_ordinal, processed, quarantined, run_id))
                connection.commit()
            except Exception as exc:
                connection.rollback()
                connection.execute('UPDATE import_runs SET status=?,error=? WHERE id=?', ('failed', str(exc), run_id))
                connection.commit()
                raise
        unresolved = connection.execute('''SELECT COUNT(*) FROM edge_proposals e LEFT JOIN staged_assets a
            ON a.provider=e.provider AND a.external_id=e.parent_external_id WHERE a.id IS NULL''').fetchone()[0]
        return dict(run_id=run_id, processed=processed, quarantined=quarantined,
                    staged_assets=connection.execute('SELECT COUNT(*) FROM staged_assets').fetchone()[0],
                    unresolved_edge_proposals=unresolved, database=str(database))
    finally:
        connection.close()


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('source', type=Path)
    parser.add_argument('--database', type=Path, required=True)
    parser.add_argument('--prefix', default='songs.item', help='Use item for a top-level array')
    args = parser.parse_args()
    print(json.dumps(import_cache(args.source, args.database, prefix=args.prefix), indent=2))

if __name__ == '__main__':
    main()
