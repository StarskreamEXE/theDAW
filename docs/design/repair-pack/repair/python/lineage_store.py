"""Transactional reverse provenance. Call only AFTER output publication succeeds.
The render engine must supply the real contribution trace from its frozen snapshot.
This module does not guess audio contributors from mute/solo flags.
"""
from __future__ import annotations
from datetime import datetime, timezone
import hashlib
import json
from pathlib import Path
import re
import sqlite3
from typing import Any

SCHEMA = Path(__file__).resolve().parents[1] / 'sql' / 'lineage.sql'

def connect(path: Path) -> sqlite3.Connection:
    connection = sqlite3.connect(path)
    connection.executescript(SCHEMA.read_text(encoding='utf-8'))
    return connection

def record_completed(connection: sqlite3.Connection, core: dict[str, Any], output_path: str,
                     output_sha256: str, status: str = 'done') -> str:
    if status != 'done':
        raise ValueError('Failed or cancelled renders cannot become usage history')
    if not re.fullmatch(r'[0-9a-f]{64}', output_sha256):
        raise ValueError('Expected final output SHA-256')
    for key in ('renderId', 'projectId', 'projectRevision'):
        if not isinstance(core.get(key), str) or not core[key]:
            raise ValueError(f'Missing {key}')
    frame_count = core.get('frameCount')
    if not isinstance(frame_count, int) or isinstance(frame_count, bool) or frame_count <= 0:
        raise ValueError('Invalid frameCount')
    rows = []
    for contribution_index, c in enumerate(core.get('contributions', [])):
        if c.get('role') not in ('audible', 'sidechain', 'dependency'):
            raise ValueError('Invalid contribution role')
        if not all(isinstance(c.get(k), str) and c[k] for k in ('clipId', 'assetId', 'trackId')):
            raise ValueError('Missing contribution identity')
        if not c.get('spans'):
            raise ValueError('Missing contribution spans')
        for index, span in enumerate(c['spans']):
            start, end = span['outputStartFrame'], span['outputEndFrame']
            if not all(isinstance(v, int) and not isinstance(v, bool) for v in (start, end)) or not 0 <= start < end <= frame_count:
                raise ValueError('Contribution outside output bounds')
            rows.append((core['renderId'], c['clipId'], c['assetId'], c['trackId'], c.get('takeId'), c['role'], contribution_index, index, start, end))
    serialized = json.dumps(core, sort_keys=True, separators=(',', ':'), ensure_ascii=False, allow_nan=False)
    digest = hashlib.sha256(serialized.encode()).hexdigest()
    # Each function call owns one transaction. Do not invoke inside another transaction.
    if connection.in_transaction:
        raise RuntimeError('record_completed requires its own transaction boundary')
    with connection:
        old = connection.execute('SELECT core_sha256,output_sha256,output_path FROM completed_renders WHERE render_id=?', (core['renderId'],)).fetchone()
        if old:
            if old != (digest, output_sha256, output_path):
                raise ValueError('Render ID already refers to different content')
            return digest
        connection.execute('INSERT INTO completed_renders VALUES(?,?,?,?,?,?,?,?)',
                           (core['renderId'], core['projectId'], core['projectRevision'], output_sha256, output_path,
                            digest, serialized, datetime.now(timezone.utc).isoformat()))
        connection.executemany('INSERT INTO render_usage VALUES(?,?,?,?,?,?,?,?,?,?)', rows)
    return digest

def used_in(connection: sqlite3.Connection, asset_id: str, include_dependencies: bool = False) -> list[dict[str, Any]]:
    role_filter = '' if include_dependencies else "AND u.role='audible'"
    result = connection.execute(f'''SELECT DISTINCT r.render_id,r.project_id,r.output_path,r.output_sha256
        FROM completed_renders r JOIN render_usage u ON u.render_id=r.render_id
        WHERE u.asset_id=? {role_filter} ORDER BY r.completed_at,r.render_id''', (asset_id,)).fetchall()
    return [dict(zip(('render_id', 'project_id', 'output_path', 'output_sha256'), row)) for row in result]
