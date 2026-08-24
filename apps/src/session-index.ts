/**
 * OmpSessionIndex — the plugin's Dash↔OMP session bridge bookkeeping.
 *
 * OMP owns the agent transcript (it persists its own `sessionFile`); Dash owns
 * the live session identity (`SessionId`). The two are unrelated, so the plugin
 * persists a small mapping `dashSessionId → OmpSessionRecord` under the Dash
 * home (`$DSH_HOME` or `~/.dsh`) to make `AgentFactory.resume` able to recover
 * the OMP session a Dash id belongs to. Session listing itself needs no plugin
 * support: Dash's own session persistence serves `session.list` and cold
 * history, and `session.prompt` on a cold session reaches the factory's
 * `resume` through the standard cold-resume path.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

/** What we remember about one OMP session, keyed by the Dash session id. */
export interface OmpSessionRecord {
  /** Absolute path to OMP's session file (the source of truth transcript). */
  readonly ompSessionFile: string;
  /** OMP's session id (the `session` header `id`). */
  readonly ompSessionId: string;
  /** Working directory the OMP session runs in (spawn `cwd`), if any. */
  readonly cwd?: string;
  /** OMP session creation epoch ms (the `session` header `timestamp`). */
  readonly createdAt: number;
}

type IndexFile = Record<string, OmpSessionRecord>;

const DASH_HOME = process.env.DSH_HOME ?? join(homedir(), ".dsh");
const INDEX_PATH = join(DASH_HOME, "omp-sessions.json");

/** Read a JSON file to a value, tolerating absence and corruption. */
function readJson<T>(path: string): T | undefined {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T;
  } catch {
    return undefined;
  }
}

/**
 * Serializes index mutations. `put()` is a read-modify-write over a shared
 * JSON file: without serialization, two concurrent `createAgent` calls could
 * both read the pre-write snapshot and each rename a full copy over the
 * other, silently dropping one Dash→OMP entry. Every mutation runs inside
 * this lock so each write observes the latest on-disk state.
 */
let writeTail: Promise<unknown> = Promise.resolve();

function withWriteLock<T>(fn: () => T | Promise<T>): Promise<T> {
  const run = writeTail.then(fn, fn);
  // Keep the chain advancing even when an individual write fails.
  writeTail = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** Per-process monotonic suffix so concurrent temp files never collide. */
let tmpSeq = 0;

/** Atomically write a JSON file (unique temp + rename). */
function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${tmpSeq++}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2));
  renameSync(tmp, path);
}

export class OmpSessionIndex {
  /** Load the persisted Dash→OMP mapping. */
  load(): IndexFile {
    const data = readJson<IndexFile>(INDEX_PATH);
    return data !== undefined && typeof data === "object" && !Array.isArray(data) ? data : {};
  }

  /** Record (or update) the OMP identity behind one Dash session id. */
  async put(dashSessionId: string, record: OmpSessionRecord): Promise<void> {
    await withWriteLock(() => {
      const index = this.load();
      index[dashSessionId] = record;
      writeJson(INDEX_PATH, index);
    });
  }

  /** Look up the OMP session identity for a Dash session id. */
  get(dashSessionId: string): OmpSessionRecord | undefined {
    return this.load()[dashSessionId];
  }
}

/** The shared singleton used by the provider. */
export const sessionIndex = new OmpSessionIndex();

