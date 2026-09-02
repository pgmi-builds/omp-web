/**
 * `BridgeStore` — the bridge's centralized session index over SQLite.
 *
 * Owns the schema, the query interface (list / byDshId / byOmpId / byFile /
 * upsert / prune + UI setters), and the connection lifecycle (WAL, integrity
 * check). The driver behind it is abstracted by `./adapter.js`; this class
 * only talks to the normalized `SqliteDb` surface.
 */
import { openDb, type SqliteDb } from "./adapter.js";
import { SCHEMA_SQL } from "./schema.js";

/** One row of the `sessions` table (snake_case, matching SQL columns 1:1). */
export interface SessionRow {
  omp_session_id: string;
  dsh_session_id: string;
  session_file: string;
  cwd: string | null;
  title: string | null;
  created_at: number;
  last_modified_at: number;
  transcript_size: number;
  model_provider: string | null;
  model_id: string | null;
  agent_preset: string | null;
  permission_preset: string | null;
  forked_from: string | null;
  archived: number;
  last_visited_at: number | null;
}

/** One row of the `workspaces` table. */
export interface WorkspaceRow {
  workspace_id: string;
  title: string | null;
  manual_order: string | null;
}

/** The fallback workspace id for sessions whose cwd is missing/corrupt (D8). */
export const UNGROUPED_WORKSPACE = "ungrouped";

const SESSIONS_COLUMNS = [
  "omp_session_id",
  "dsh_session_id",
  "session_file",
  "cwd",
  "title",
  "created_at",
  "last_modified_at",
  "transcript_size",
  "model_provider",
  "model_id",
  "agent_preset",
  "permission_preset",
  "forked_from",
  "archived",
  "last_visited_at",
] as const;

const UPSERT_SQL = `INSERT INTO sessions (${SESSIONS_COLUMNS.join(", ")})
VALUES (${SESSIONS_COLUMNS.map(() => "?").join(", ")})
ON CONFLICT(omp_session_id) DO UPDATE SET
  dsh_session_id   = excluded.dsh_session_id,
  session_file     = excluded.session_file,
  cwd              = excluded.cwd,
  title            = excluded.title,
  created_at       = excluded.created_at,
  last_modified_at = excluded.last_modified_at,
  transcript_size  = excluded.transcript_size,
  model_provider   = excluded.model_provider,
  model_id         = excluded.model_id,
  agent_preset     = excluded.agent_preset,
  permission_preset = excluded.permission_preset,
  forked_from      = excluded.forked_from,
  archived         = excluded.archived,
  last_visited_at  = excluded.last_visited_at`;

/** Parse a stored JSON array, failing soft to `undefined`. */
function parseOrder(raw: string | null): string[] | undefined {
  if (raw === null) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? (value as string[]) : undefined;
  } catch {
    return undefined;
  }
}

/** Order a flat row list per workspace under manual mode (D9). */
function orderManual(rows: SessionRow[], workspaces: WorkspaceRow[]): SessionRow[] {
  const byCwd = new Map<string, SessionRow[]>();
  for (const row of rows) {
    const key = row.cwd ?? UNGROUPED_WORKSPACE;
    const group = byCwd.get(key);
    if (group === undefined) byCwd.set(key, [row]);
    else group.push(row);
  }
  const orderFor = new Map(workspaces.map((w) => [w.workspace_id, parseOrder(w.manual_order)]));
  const ordered: SessionRow[] = [];
  for (const [cwd, group] of byCwd) {
    const manual = orderFor.get(cwd);
    if (manual !== undefined && manual.length > 0) {
      const rank = new Map(manual.map((id, index) => [id, index]));
      group.sort((a, b) => {
        const ai = rank.get(a.dsh_session_id) ?? Number.MAX_SAFE_INTEGER;
        const bi = rank.get(b.dsh_session_id) ?? Number.MAX_SAFE_INTEGER;
        return ai !== bi ? ai - bi : b.last_modified_at - a.last_modified_at;
      });
    } else {
      group.sort((a, b) => b.last_modified_at - a.last_modified_at);
    }
    ordered.push(...group);
  }
  return ordered;
}

export class BridgeStore {
  private readonly db: SqliteDb;

  private constructor(db: SqliteDb) {
    this.db = db;
  }

  /** Open (WAL + schema + integrity check). Throws on a corrupt/invalid database. */
  static open(path: string): BridgeStore {
    const db = openDb(path);
    db.exec("PRAGMA journal_mode=WAL");
    db.exec(SCHEMA_SQL);
    const check = db.prepare("PRAGMA integrity_check").all();
    const ok = check.length === 1 && (check[0] as Record<string, unknown> | undefined)?.["integrity_check"] === "ok";
    if (!ok) {
      db.close();
      throw new Error(`bridge-store integrity check failed: ${JSON.stringify(check)}`);
    }
    return new BridgeStore(db);
  }

  close(): void {
    this.db.close();
  }

  private all<T>(sql: string, ...params: unknown[]): T[] {
    return this.db.prepare(sql).all(...params) as unknown as T[];
  }

  private get<T>(sql: string, ...params: unknown[]): T | undefined {
    return this.db.prepare(sql).get(...params) as unknown as T | undefined;
  }

  private run(sql: string, ...params: unknown[]): void {
    this.db.prepare(sql).run(...params);
  }

  /** All session rows, default `last_modified_at DESC`, manual mode per-workspace order. */
  list(): SessionRow[] {
    const rows = this.all<SessionRow>("SELECT * FROM sessions ORDER BY last_modified_at DESC");
    if (this.getUiState("sort_mode") !== "manual") return rows;
    return orderManual(rows, this.workspaces());
  }

  /** All workspace rows. */
  workspaces(): WorkspaceRow[] {
    return this.all<WorkspaceRow>("SELECT * FROM workspaces");
  }

  byDshId(dshSessionId: string): SessionRow | undefined {
    return this.get<SessionRow>("SELECT * FROM sessions WHERE dsh_session_id = ?", dshSessionId);
  }

  byOmpId(ompSessionId: string): SessionRow | undefined {
    return this.get<SessionRow>("SELECT * FROM sessions WHERE omp_session_id = ?", ompSessionId);
  }

  byFile(sessionFile: string): SessionRow | undefined {
    return this.get<SessionRow>("SELECT * FROM sessions WHERE session_file = ?", sessionFile);
  }

  /** Full-row upsert, keyed by `omp_session_id`. */
  upsert(row: SessionRow): void {
    this.run(
      UPSERT_SQL,
      row.omp_session_id,
      row.dsh_session_id,
      row.session_file,
      row.cwd,
      row.title,
      row.created_at,
      row.last_modified_at,
      row.transcript_size,
      row.model_provider,
      row.model_id,
      row.agent_preset,
      row.permission_preset,
      row.forked_from,
      row.archived,
      row.last_visited_at,
    );
  }

  /** Drop every row whose session file is not in `keepFiles`. */
  prune(keepFiles: Set<string>): void {
    const files = this.all<{ session_file: string }>("SELECT session_file FROM sessions");
    const del = this.db.prepare("DELETE FROM sessions WHERE session_file = ?");
    for (const { session_file } of files) {
      if (!keepFiles.has(session_file)) del.run(session_file);
    }
  }

  /** Migration only: overwrite the DSH pairing for one OMP session. */
  setDshId(ompSessionId: string, dshSessionId: string): void {
    this.run("UPDATE sessions SET dsh_session_id = ? WHERE omp_session_id = ?", dshSessionId, ompSessionId);
  }

  setPermissionPreset(ompSessionId: string, preset: string | null): void {
    this.run("UPDATE sessions SET permission_preset = ? WHERE omp_session_id = ?", preset, ompSessionId);
  }

  setArchived(dshSessionId: string, archived: boolean): void {
    this.run("UPDATE sessions SET archived = ? WHERE dsh_session_id = ?", archived ? 1 : 0, dshSessionId);
  }

  setForkedFrom(dshSessionId: string, forkedFrom: string | null): void {
    this.run("UPDATE sessions SET forked_from = ? WHERE dsh_session_id = ?", forkedFrom, dshSessionId);
  }

  touchVisited(dshSessionId: string, at: number): void {
    this.run("UPDATE sessions SET last_visited_at = ? WHERE dsh_session_id = ?", at, dshSessionId);
  }

  /** Persist a workspace's manual ordering (upsert the workspace row first). */
  setWorkspaceOrder(workspaceId: string, order: string[]): void {
    this.run("INSERT INTO workspaces (workspace_id, title, manual_order) VALUES (?, NULL, ?) ON CONFLICT(workspace_id) DO UPDATE SET manual_order = excluded.manual_order", workspaceId, JSON.stringify(order));
  }

  /** Ensure the `ungrouped` sentinel workspace row exists (D8). */
  ensureUngroupedWorkspace(): void {
    this.run("INSERT INTO workspaces (workspace_id, title, manual_order) VALUES (?, NULL, NULL) ON CONFLICT(workspace_id) DO NOTHING", UNGROUPED_WORKSPACE);
  }

  getUiState(key: string): string | undefined {
    return this.get<{ value: string | null }>("SELECT value FROM ui_state WHERE key = ?", key)?.value ?? undefined;
  }

  setUiState(key: string, value: string): void {
    this.run("INSERT INTO ui_state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value", key, value);
  }

  /** The tracked OMP default model (`modelRoles.default`), or undefined when unset. */
  getOmpDefaultModel(): { provider: string; model: string } | undefined {
    const raw = this.getUiState("omp_default_model");
    if (raw === undefined) return undefined;
    try {
      const parsed = JSON.parse(raw) as { provider?: unknown; model?: unknown };
      if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
        return { provider: parsed.provider, model: parsed.model };
      }
    } catch {
      return undefined;
    }
    return undefined;
  }

  /** Persist the tracked OMP default model. */
  setOmpDefaultModel(provider: string, model: string): void {
    this.setUiState("omp_default_model", JSON.stringify({ provider, model }));
  }

  /** Event-driven model update after a live model switch (D5.3). */
  updateModel(dshSessionId: string, provider: string | null, model: string | null): void {
    this.run("UPDATE sessions SET model_provider = ?, model_id = ? WHERE dsh_session_id = ?", provider, model, dshSessionId);
  }

  /** Event-driven stat refresh on teardown/cold transition (D5.3). */
  updateStat(dshSessionId: string, size: number, mtimeMs: number): void {
    this.run("UPDATE sessions SET transcript_size = ?, last_modified_at = ? WHERE dsh_session_id = ?", size, mtimeMs, dshSessionId);
  }
}
