/**
 * SQLite driver adapter — one thin interface over whichever builtin the
 * runtime ships. Bun → `bun:sqlite`; Node (≥22.5) → `node:sqlite`. The store
 * never cares which: it sees exec / prepare→(run|get|all) / close.
 *
 * Both builtins load through `createRequire` (never a static ESM import) so
 * neither `bun:` nor `node:sqlite` is resolved at module load: under Node the
 * `bun:` branch is dead code, under Bun the `node:sqlite` branch is dead code.
 */
import { createRequire } from "node:module";
import type { DatabaseSync, SQLInputValue } from "node:sqlite";

const nodeRequire = createRequire(import.meta.url);

/** A prepared statement: run / get / all with positional params. */
export interface SqliteStatement {
  run(...params: unknown[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: unknown[]): Record<string, unknown> | undefined;
  all(...params: unknown[]): Record<string, unknown>[];
}

/** A SQLite connection, normalized across drivers. */
export interface SqliteDb {
  exec(sql: string): void;
  prepare(sql: string): SqliteStatement;
  close(): void;
}

/** Bun's `bun:sqlite` Database shape, declared locally so the Node build never resolves `bun:`. */
interface BunDatabase {
  new (path: string, options?: { create?: boolean }): {
    exec(sql: string): void;
    query(sql: string): SqliteStatement;
    close(): void;
  };
}

function openNode(path: string): SqliteDb {
  const { DatabaseSync: Driver } = nodeRequire("node:sqlite") as { DatabaseSync: typeof DatabaseSync };
  const db = new Driver(path);
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const statement = db.prepare(sql);
      return {
        run: (...params) => statement.run(...(params as SQLInputValue[])),
        get: (...params) => statement.get(...(params as SQLInputValue[])),
        all: (...params) => statement.all(...(params as SQLInputValue[])),
      };
    },
    close: () => db.close(),
  };
}

function openBun(path: string): SqliteDb {
  const { Database: Driver } = nodeRequire("bun:sqlite") as { Database: BunDatabase };
  const db = new Driver(path, { create: true });
  return {
    exec: (sql) => db.exec(sql),
    prepare: (sql) => {
      const query = db.query(sql);
      return {
        run: (...params) => query.run(...params),
        get: (...params) => query.get(...params),
        all: (...params) => query.all(...params),
      };
    },
    close: () => db.close(),
  };
}

/** Open a SQLite connection on whichever builtin the runtime provides. */
export function openDb(path: string): SqliteDb {
  return (globalThis as { Bun?: unknown }).Bun !== undefined ? openBun(path) : openNode(path);
}
