/**
 * Read-only scanner over OMP's native session store
 * (`$OMP_HOME/agent/sessions/<cwd-dashed>/<timestamp>_<uuid>.jsonl`).
 *
 * OMP owns the transcript format; this module extracts only what the Dash
 * surfaces need per session — identity, cwd, creation time, and a display
 * title — by reading a bounded HEAD of each JSONL file (never the full
 * transcript). Parsed entries are memoized per file keyed on (size, mtime),
 * so repeated `list()` calls re-stat but re-parse only changed files.
 */
import { closeSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { OmpMessage } from "./rpc.js";

/** One OMP-native session discovered by {@link scanOmpSessions}. */
export interface OmpNativeSession {
  /** OMP's session id (the `session` header record's `id`). */
  readonly ompSessionId: string;
  /** Absolute path to the OMP session file (the transcript of record). */
  readonly ompSessionFile: string;
  /** Working directory recorded in the session header, if any. */
  readonly cwd?: string;
  /** Creation epoch ms (session header `timestamp`, filename fallback). */
  readonly createdAt: number;
  /** Display title: the title record, else the first user message, else absent. */
  readonly title?: string;
  /** Opaque change token (stat-derived), for persistence snapshot revisions. */
  readonly revision: string;
}

/** Root of OMP's native session store. */
export const OMP_SESSIONS_ROOT =
  process.env.OMP_SESSIONS_ROOT ?? join(process.env.OMP_HOME ?? join(homedir(), ".omp"), "agent", "sessions");

/** How many head bytes of one session file the scanner will read. */
const HEAD_BUDGET_BYTES = 256 * 1024;

/** Title fallback budget (characters of the first user message). */
const FALLBACK_TITLE_CHARS = 80;

/** Memoized parse results, keyed by session file path. */
const entryCache = new Map<string, { size: number; mtimeMs: number; entry: OmpNativeSession | undefined }>();

/** Epoch ms from a `<YYYY>-<MM>-<DD>T<HH>-<MM>-<SS>-<mmm>Z` filename prefix. */
function createdAtFromFileName(name: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/.exec(name);
  if (match === null) return undefined;
  const [year, month, day, hour, minute, second, ms] = match.slice(1).map(Number);
  const epoch = Date.UTC(year, month - 1, day, hour, minute, second, ms);
  return Number.isSafeInteger(epoch) ? epoch : undefined;
}

/** One normalized display-title fallback from a first user message. */
function fallbackTitle(text: string): string | undefined {
  const firstLine = text.split("\n", 1)[0] ?? "";
  const collapsed = firstLine.replaceAll(/\s+/gu, " ").trim();
  return collapsed.length === 0 ? undefined : collapsed.slice(0, FALLBACK_TITLE_CHARS);
}

/**
 * Read one OMP session transcript's full message list (`{"type":"message"}`
 * records, in file order). This is the same shape `get_messages` returns for
 * a live session; cold history replay consumes it directly.
 */
export function readOmpMessages(path: string): OmpMessage[] {
  const messages: OmpMessage[] = [];
  let buffer: string;
  try {
    buffer = readFileSync(path, "utf8");
  } catch {
    return messages;
  }
  for (const line of buffer.split("\n")) {
    if (line === "") continue;
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const rec = record as Record<string, unknown>;
    if (rec["type"] !== "message") continue;
    const message = rec["message"];
    if (message === null || typeof message !== "object") continue;
    const msg = message as Record<string, unknown>;
    const role = msg["role"];
    if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
    messages.push({ ...msg, role } as OmpMessage);
  }
  return messages;
}

/**
 * Derive the working directory a session ran in from its location in OMP's
 * store: the parent directory name is the cwd with every "/" flattened to
 * "-" (leading "/" → leading "-"). Literal dashes in path segments are
 * ambiguous, so segments are re-joined greedily longest-first against the
 * filesystem and the candidate is accepted only as an existing directory
 * (realpath'd). This is the trusted resume cwd — the omp-sessions.json
 * mapping's verbatim `cwd` is user-writable and never consulted.
 */
export function cwdFromSessionFile(path: string): string | undefined {
  const dashed = basename(dirname(path));
  if (!dashed.startsWith("-")) return undefined;
  const tokens = dashed.slice(1).split("-").filter((token: string) => token !== "");
  if (tokens.length === 0) return undefined;
  // OMP flattens the cwd's "/" separators to "-"; home-relative cwds lose
  // their "~/" prefix entirely ("-workspaces-x" ≡ ~/workspaces/x), absolute
  // ones keep the leading slash ("-tmp-x" ≡ /tmp/x). Try the absolute base
  // first, then home; literal dashes in segment names are ambiguous, so each
  // walk consumes the LONGEST run of remaining tokens that names an existing
  // directory (dash-joined), which resolves the common cases exactly.
  for (const base of ["/", homedir()]) {
    let current = base === "/" ? "" : base;
    let consumed = 0;
    let complete = true;
    while (consumed < tokens.length) {
      let stepped = false;
      for (let take = tokens.length - consumed; take >= 1; take--) {
        const candidate = `${current}/${tokens.slice(consumed, consumed + take).join("-")}`;
        try {
          if (!statSync(candidate).isDirectory()) continue;
        } catch {
          continue;
        }
        current = candidate;
        consumed += take;
        stepped = true;
        break;
      }
      if (!stepped) {
        complete = false;
        break;
      }
    }
    if (complete) {
      try {
        return realpathSync(current);
      } catch {
        // try the next base
      }
    }
  }
  return undefined;
}

interface HeadScan {
  title?: string;
  ompSessionId?: string;
  cwd?: string;
  createdAt?: number;
  firstUserText?: string;
}

/** Parse the interesting head records of one OMP session file. */
function scanHead(path: string): HeadScan {
  const out: HeadScan = {};
  let buffer = "";
  let remaining = HEAD_BUDGET_BYTES;
  const chunks: Buffer[] = [];
  const fd = openSync(path, "r");
  try {
    while (remaining > 0) {
      const chunk = Buffer.allocUnsafe(Math.min(remaining, 64 * 1024));
      const read = readSync(fd, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      remaining -= read;
    }
  } finally {
    closeSync(fd);
  }
  buffer = Buffer.concat(chunks).toString("utf8");
  for (const line of buffer.split("\n")) {
    let record: unknown;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record === null || typeof record !== "object") continue;
    const rec = record as Record<string, unknown>;
    if (rec["type"] === "title" || rec["type"] === "title_change") {
      // Latest wins: OMP renames titles over a session's life (replans), and
      // the scan must surface the name the TUI shows today, not the first.
      const title = rec["title"];
      if (typeof title === "string" && title.trim().length > 0) out.title = title.trim();
    } else if (rec["type"] === "session" && out.ompSessionId === undefined) {
      const id = rec["id"];
      const timestamp = rec["timestamp"];
      const cwd = rec["cwd"];
      if (typeof id === "string" && id.length > 0) out.ompSessionId = id;
      if (typeof timestamp === "string") {
        const epoch = Date.parse(timestamp);
        if (Number.isSafeInteger(epoch)) out.createdAt = epoch;
      }
      if (typeof cwd === "string" && cwd.length > 0) out.cwd = cwd;
    } else if (rec["type"] === "message" && out.firstUserText === undefined) {
      const message = rec["message"];
      if (message === null || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;
      if (msg["role"] !== "user" || (msg["attribution"] !== undefined && msg["attribution"] !== "user")) continue;
      const content = msg["content"];
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (block === null || typeof block !== "object") continue;
        const b = block as Record<string, unknown>;
        if (b["type"] === "text" && typeof b["text"] === "string" && b["text"].trim().length > 0) {
          out.firstUserText = b["text"];
          break;
        }
      }
    }
  }
  return out;
}

/**
 * Scan OMP's native store. Returns sessions keyed by OMP session id; files
 * without a parsable `session` header record are skipped (corrupt/foreign).
 */
export function scanOmpSessions(): Map<string, OmpNativeSession> {
  const sessions = new Map<string, OmpNativeSession>();
  let workspaceDirs: string[];
  try {
    workspaceDirs = readdirSync(OMP_SESSIONS_ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return sessions;
  }
  for (const dirName of workspaceDirs) {
    let files: string[];
    try {
      files = readdirSync(join(OMP_SESSIONS_ROOT, dirName));
    } catch {
      continue;
    }
    for (const fileName of files) {
      if (!fileName.endsWith(".jsonl")) continue;
      const path = join(OMP_SESSIONS_ROOT, dirName, fileName);
      let size: number;
      let mtimeMs: number;
      try {
        const stats = statSync(path);
        size = stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        entryCache.delete(path);
        continue;
      }
      let cached = entryCache.get(path);
      if (cached === undefined || cached.size !== size || cached.mtimeMs !== mtimeMs) {
        const head = scanHead(path);
        const entry: OmpNativeSession | undefined =
          head.ompSessionId === undefined
            ? undefined
            : {
                ompSessionId: head.ompSessionId,
                ompSessionFile: path,
                ...(head.cwd === undefined ? {} : { cwd: head.cwd }),
                createdAt: head.createdAt ?? createdAtFromFileName(fileName) ?? 0,
                ...(head.title !== undefined
                  ? { title: head.title }
                  : head.firstUserText !== undefined
                    ? { title: fallbackTitle(head.firstUserText) }
                    : {}),
                revision: `omp:${size}:${mtimeMs}`,
              };
        cached = { size, mtimeMs, entry };
        entryCache.set(path, cached);
      }
      if (cached.entry !== undefined && !sessions.has(cached.entry.ompSessionId)) {
        sessions.set(cached.entry.ompSessionId, cached.entry);
      }
    }
  }
  return sessions;
}
