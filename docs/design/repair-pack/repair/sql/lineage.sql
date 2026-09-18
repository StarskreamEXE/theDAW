-- Proposed sidecar schema. Integrate with theDAW's existing library IDs/migrations.
-- No original audio file is mutated to maintain reverse references.
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS project_usage (
 project_id TEXT NOT NULL, revision_id TEXT NOT NULL, clip_id TEXT NOT NULL,
 asset_id TEXT NOT NULL, muted INTEGER NOT NULL CHECK(muted IN (0,1)),
 PRIMARY KEY(project_id,revision_id,clip_id,asset_id)
);
CREATE INDEX IF NOT EXISTS usage_asset ON project_usage(asset_id);
CREATE TABLE IF NOT EXISTS completed_renders (
 render_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, revision_id TEXT NOT NULL,
 output_sha256 TEXT NOT NULL, output_path TEXT NOT NULL, core_sha256 TEXT NOT NULL,
 core_json TEXT NOT NULL, completed_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS render_usage (
 render_id TEXT NOT NULL REFERENCES completed_renders(render_id), clip_id TEXT NOT NULL,
 asset_id TEXT NOT NULL, track_id TEXT NOT NULL, take_id TEXT,
 role TEXT NOT NULL CHECK(role IN ('audible','sidechain','dependency')),
 contribution_index INTEGER NOT NULL, span_index INTEGER NOT NULL, start_frame INTEGER NOT NULL, end_frame INTEGER NOT NULL,
 PRIMARY KEY(render_id,contribution_index,span_index), CHECK(end_frame > start_frame)
);
CREATE INDEX IF NOT EXISTS renders_by_asset ON render_usage(asset_id,role,render_id);
