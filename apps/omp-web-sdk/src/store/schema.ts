/**
 * SQLite schema for the bridge's centralized session index.
 *
 * One `sessions` table carries mapping + metadata + UI fields 1:1 (D2); two
 * aux tables carry workspace grouping/ordering and singleton UI state. The
 * schema is idempotent (`IF NOT EXISTS`), applied on every open.
 */
export const SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS sessions (
  omp_session_id    TEXT PRIMARY KEY,           -- OMP uuidv7 (session header id)
  dsh_session_id    TEXT NOT NULL UNIQUE,       -- DSH-facing id (real or derived)
  session_file      TEXT NOT NULL UNIQUE,       -- transcript absolute path
  cwd               TEXT,                       -- working directory (NULL → ungrouped)
  title             TEXT,                       -- display title (latest wins)
  created_at        INTEGER NOT NULL,           -- epoch ms
  last_modified_at  INTEGER NOT NULL,           -- transcript mtime (default sort key)
  transcript_size   INTEGER NOT NULL,           -- bytes (reconcile change detection)
  model_provider    TEXT,                       -- last model provider (complete, D6)
  model_id          TEXT,                       -- last model id
  agent_preset      TEXT,                       -- DSH composition id (always "omp")
  permission_preset TEXT,                       -- approval preset (danger-full-access/workspace-write/read-only)
  forked_from       TEXT,                       -- fork source dsh_session_id (NULL = not a fork)
  archived          INTEGER NOT NULL DEFAULT 0, -- archive flag (default list excludes)
  last_visited_at   INTEGER                     -- last view epoch ms (refresh priority, D10)
);
CREATE INDEX IF NOT EXISTS sessions_cwd   ON sessions(cwd);
CREATE INDEX IF NOT EXISTS sessions_mtime ON sessions(last_modified_at DESC);
CREATE INDEX IF NOT EXISTS sessions_visit ON sessions(last_visited_at DESC);

CREATE TABLE IF NOT EXISTS workspaces (
  workspace_id  TEXT PRIMARY KEY,               -- = cwd path; 'ungrouped' sentinel (D8)
  title         TEXT,
  manual_order  TEXT                            -- JSON array of dsh_session_id (manual mode, D9)
);

CREATE TABLE IF NOT EXISTS ui_state (
  key   TEXT PRIMARY KEY,
  value TEXT                                    -- e.g. sort_mode = 'last_updated' | 'manual'
);
`;
