"""Original render-lineage helpers, not a DSP renderer.

Input graph must come from the SAME compiled render plan that produces audio.
Its enabled flags must already resolve routing, folder/bus mute and solo policy.
History is retained as immutable manifest data; final encoded-file SHA belongs
in an external receipt to avoid a self-referential embedded-file hash.
"""
from __future__ import annotations
import hashlib
import json
from collections import defaultdict, deque
from dataclasses import asdict, dataclass
from typing import Any, Iterable


@dataclass(frozen=True)
class Node:
    id: str
    enabled: bool = True


@dataclass(frozen=True)
class Edge:
    source: str
    target: str
    role: str = "audio"  # audio or sidechain
    enabled: bool = True


@dataclass(frozen=True)
class ClipUse:
    clip_id: str
    asset_version_id: str
    track_id: str
    source_node_id: str
    start_frame: int
    end_frame: int
    source_offset_frame: int = 0
    muted: bool = False


def trace_roles(nodes: Iterable[Node], edges: Iterable[Edge], output_id: str) -> dict[str, set[str]]:
    """Reverse dependency traversal. Input must be a finite feed-forward graph.

    Sidechain ancestry is retained as control provenance and never falsely
    described as an audible stem. Nodes reachable by both roles retain both.
    Explicit feedback routing needs a different compiler and is rejected here.
    """
    nodes = list(nodes); edges = list(edges)
    by_id = {node.id: node for node in nodes}
    if len(by_id) != len(nodes) or output_id not in by_id:
        raise ValueError("duplicate node or missing output")
    incoming: dict[str, list[Edge]] = defaultdict(list)
    outgoing: dict[str, list[str]] = defaultdict(list)
    indegree = {node.id: 0 for node in nodes}
    for edge in edges:
        if edge.source not in by_id or edge.target not in by_id or edge.role not in {"audio", "sidechain"}:
            raise ValueError("invalid graph edge")
        if edge.enabled and by_id[edge.source].enabled and by_id[edge.target].enabled:
            incoming[edge.target].append(edge)
            outgoing[edge.source].append(edge.target)
            indegree[edge.target] += 1
    pending = deque(node for node, degree in indegree.items() if degree == 0)
    count = 0
    while pending:
        node = pending.popleft(); count += 1
        for target in outgoing[node]:
            indegree[target] -= 1
            if indegree[target] == 0: pending.append(target)
    if count != len(nodes):
        raise ValueError("feedback/cyclic graph requires an explicit feedback compiler")
    roles: dict[str, set[str]] = defaultdict(set)
    todo = [(output_id, "audio")]
    while todo:
        current, role = todo.pop()
        if not by_id[current].enabled or role in roles[current]: continue
        roles[current].add(role)
        for edge in incoming[current]:
            upstream_role = "control" if role == "control" or edge.role == "sidechain" else "audio"
            todo.append((edge.source, upstream_role))
    return dict(roles)


def contributors(
    clips: Iterable[ClipUse], roles: dict[str, set[str]],
    start_frame: int, end_frame: int, preroll_start_frame: int | None = None,
) -> list[dict[str, Any]]:
    """Structural dependencies, NOT measured nonzero-audio detection.

    Handles unit-rate clips for source-frame projection. Warped/reversed clips
    need the engine's segment time mapper rather than this offset calculation.
    A clip ending at selection start is excluded unless included as preroll.
    """
    pre = start_frame if preroll_start_frame is None else preroll_start_frame
    if not all(isinstance(x, int) and not isinstance(x, bool) for x in (pre, start_frame, end_frame)):
        raise ValueError("integer frame bounds required")
    if not (0 <= pre <= start_frame < end_frame):
        raise ValueError("invalid render range")
    result = []
    for clip in clips:
        if clip.end_frame <= clip.start_frame or clip.source_offset_frame < 0:
            raise ValueError("invalid clip bounds")
        clip_roles = roles.get(clip.source_node_id)
        if clip.muted or not clip_roles: continue
        a, b = max(clip.start_frame, pre), min(clip.end_frame, end_frame)
        if a >= b: continue
        result.append({
            "clip_id": clip.clip_id, "asset_version_id": clip.asset_version_id,
            "track_id": clip.track_id, "roles": sorted(clip_roles),
            "timeline_frames": [a, b],
            "source_frames": [clip.source_offset_frame + a - clip.start_frame,
                              clip.source_offset_frame + b - clip.start_frame],
            "relevance": "preroll" if b <= start_frame else "direct",
        })
    return sorted(result, key=lambda row: (row["clip_id"], row["timeline_frames"][0]))


def canonical_bytes(value: Any) -> bytes:
    """Deterministic within the Python encoder contract. Use one encoder on both
    sides, or RFC 8785 for cross-language signatures; don't assume JS floats match.
    """
    return json.dumps(value, sort_keys=True, separators=(",", ":"), ensure_ascii=False,
                      allow_nan=False).encode("utf-8")


def make_manifest(
    *, render_id: str, project_id: str, revision_id: str, sample_rate: int,
    start_frame: int, end_frame: int, uses: list[dict[str, Any]],
    render_settings: dict[str, Any],
) -> dict[str, Any]:
    if sample_rate <= 0 or end_frame <= start_frame or start_frame < 0:
        raise ValueError("invalid sample rate or frame bounds")
    document = {
        "schema": "thedaw.render-lineage/1", "render_id": render_id,
        "project_id": project_id, "project_revision_id": revision_id,
        "sample_rate": sample_rate, "range_frames": [start_frame, end_frame],
        "participants": uses, "settings": render_settings,
    }
    return {"manifest": document, "manifest_sha256": hashlib.sha256(canonical_bytes(document)).hexdigest()}


def make_receipt(envelope: dict[str, Any], encoded_file_sha256: str, byte_count: int) -> dict[str, Any]:
    if len(encoded_file_sha256) != 64 or any(c not in "0123456789abcdef" for c in encoded_file_sha256):
        raise ValueError("expected lowercase SHA-256")
    if byte_count < 0: raise ValueError("invalid byte count")
    return {"render_id": envelope["manifest"]["render_id"],
            "manifest_sha256": envelope["manifest_sha256"],
            "encoded_file_sha256": encoded_file_sha256, "bytes": byte_count}
