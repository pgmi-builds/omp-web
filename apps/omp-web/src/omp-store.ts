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
import { closeSync, openSync, readFileSync, readSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
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
  /** Transcript byte size (reconcile change detection). */
  readonly size: number;
  /** Transcript mtime, epoch ms (reconcile change detection + default sort). */
  readonly mtimeMs: number;
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

/** One OMP `model_change` entry from a session transcript. */
export interface OmpModelChange {
  /** `provider/model` selector string. */
  readonly model: string;
  /** The role this change records (absent on the initial restore). */
  readonly role?: string;
}

/** The two record families cold replay needs from one transcript read. */
export interface OmpTranscript {
  messages: OmpMessage[];
  modelChanges: OmpModelChange[];
}

/**
 * Read one OMP session transcript in a single pass, extracting both the
 * `message` records and the `model_change` records.
 */
export function readOmpTranscript(path: string): OmpTranscript {
  const messages: OmpMessage[] = [];
  const modelChanges: OmpModelChange[] = [];
  let buffer: string;
  try {
    buffer = readFileSync(path, "utf8");
  } catch {
    return { messages, modelChanges };
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
    if (rec["type"] === "message") {
      const message = rec["message"];
      if (message === null || typeof message !== "object") continue;
      const msg = message as Record<string, unknown>;
      const role = msg["role"];
      if (role !== "user" && role !== "assistant" && role !== "toolResult") continue;
      messages.push({ ...msg, role } as OmpMessage);
    } else if (rec["type"] === "model_change") {
      const model = rec["model"];
      if (typeof model !== "string" || model === "") continue;
      modelChanges.push({ model, role: typeof rec["role"] === "string" ? rec["role"] : undefined });
    }
  }
  return { messages, modelChanges };
}

/**
 * Legacy fallback: the last assistant message that names a provider/model
 * pair. Used only for transcripts without any `model_change` record; newer
 * sessions derive their resume model from {@link lastRestorableModel}.
 */
export function lastModelCall(messages: OmpMessage[]): { provider: string; model: string } | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.role !== "assistant") continue;
    const provider = typeof message.provider === "string" ? message.provider : "";
    const model = typeof message.model === "string" ? message.model : "";
    if (provider !== "" && model !== "") return { provider, model };
  }
  return undefined;
}

/** Split a `provider/model[:variant]` selector into provider/model, dropping the variant suffix. */
export function parseSelector(selector: string | undefined): { provider: string; model: string } | undefined {
  if (selector === undefined) return undefined;
  const slash = selector.indexOf("/");
  if (slash <= 0) return undefined;
  let model = selector.slice(slash + 1);
  const colon = model.indexOf(":");
  if (colon > 0) model = model.slice(0, colon);
  return { provider: selector.slice(0, slash), model };
}

/**
 * The model OMP restores on `--resume`: the last non-fallback `model_change`.
 * Mirrors OMP's `getRestorableSessionModels` (`session-context.ts`): a
 * fallback switch is recorded under `role:"fallback"` (EPHEMERAL) and never
 * restores — the last such switch falls back to the role's primary.
 */
export function lastRestorableModel(modelChanges: OmpModelChange[]): { provider: string; model: string } | undefined {
  const models: Record<string, string> = {};
  let lastRole: string | undefined;
  for (const change of modelChanges) {
    const role = change.role ?? "default";
    models[role] = change.model;
    lastRole = change.role;
  }
  const selector =
    lastRole === undefined || lastRole === "default" || lastRole === "fallback"
      ? models["default"]
      : (models[lastRole] ?? models["default"]);
  return parseSelector(selector);
}

/**
 * Path to OMP's per-user agent config (`$OMP_HOME/agent/config.yml`).
 *
 * This is the OMP layer's own config, distinct from dsh's settings layer:
 * upstream dsh keeps a home-level singleton settings document
 * (`$DSH_HOME/settings.yaml`); the profile only composes bundles and has no
 * per-profile settings isolation of its own. This bridge never reads that
 * settings.yaml — OMP data lives under `$OMP_HOME`, and the bridge's own
 * index under `$DSH_HOME/bridge-store.sqlite` (see store/index.ts).
 */
function ompConfigPath(): string {
  return join(process.env.OMP_HOME ?? join(homedir(), ".omp"), "agent", "config.yml");
}

/**
 * Read the configured default role model (`modelRoles.default`) from OMP's
 * config.yml. Returns the provider/model pair (variant suffix dropped), or
 * undefined when unset or unreadable. A deliberately minimal YAML scan — the
 * bridge has no YAML dependency and only needs this one value.
 */
export function readOmpDefaultModelFromConfig(): { provider: string; model: string } | undefined {
  let text: string;
  try {
    text = readFileSync(ompConfigPath(), "utf8");
  } catch {
    return undefined;
  }
  let inModelRoles = false;
  for (const line of text.split("\n")) {
    if (/^modelRoles:\s*$/.test(line)) {
      inModelRoles = true;
      continue;
    }
    if (inModelRoles) {
      if (line !== "" && !/^\s/.test(line)) break; // left the modelRoles block
      const match = /^\s*default:\s*(\S+)/.exec(line);
      if (match !== null) return parseSelector(match[1]);
    }
  }
  return undefined;
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

/** Read one session file's header id (the `session` record's `id`), no full scan. */
export function sessionHeaderId(path: string): string | undefined {
  return scanHead(path).ompSessionId;
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
                size,
                mtimeMs,
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

/** Parent pid of a process, from `/proc/<pid>/stat` (undefined when unreadable). */
function parentPid(pid: number): number | undefined {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    // The comm field may contain spaces and parens; fields resume after the LAST ')'.
    const tail = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ppid = Number.parseInt(tail[1] ?? "", 10);
    return Number.isNaN(ppid) ? undefined : ppid;
  } catch {
    return undefined;
  }
}

/** Whether `pid` sits anywhere below `ancestor` in the process tree. */
function isDescendantOf(pid: number, ancestor: number): boolean {
  let current = pid;
  for (let hop = 0; hop < 32; hop += 1) {
    if (current === ancestor) return true;
    const parent = parentPid(current);
    if (parent === undefined || parent <= 1) return false;
    current = parent;
  }
  return false;
}

/**
 * One /proc pass over every foreign process's write-mode file descriptors,
 * returning `canonical path → first foreign writer pid`. Shared by every
 * session in one tick so the daemon never re-scans /proc per file.
 *
 * OMP has no session-level exclusivity: neither the TUI nor `--mode rpc`
 * locks its transcript, so two live writers interleave appends silently
 * (verified: a TUI `omp` and a bridge `omp --mode rpc --resume` coexisted on
 * one file with plain `w` descriptors and no advisory locks). The bridge
 * therefore refuses to resume a transcript another process already writes —
 * the TUI case — closing the split-brain at the only layer that can see it.
 * Own descendants (a just-torn-down bridge child whose fds linger) are
 * exempt to keep teardown races from wedging re-resume.
 */
export function scanForeignWriters(): Map<string, number> {
  const holders = new Map<string, number>();
  let procEntries: string[];
  try {
    procEntries = readdirSync("/proc");
  } catch {
    return holders;
  }
  const self = process.pid;
  for (const entry of procEntries) {
    if (!/^[0-9]+$/.test(entry)) continue;
    const pid = Number.parseInt(entry, 10);
    if (pid === self || isDescendantOf(pid, self)) continue;
    let fds: string[];
    try {
      fds = readdirSync(`/proc/${entry}/fd`);
    } catch {
      continue;
    }
    for (const fd of fds) {
      let target: string | undefined;
      try {
        target = readlinkSync(`/proc/${entry}/fd/${fd}`);
      } catch {
        continue;
      }
      // Non-path targets (socket:[…], pipe:[…], anon_inode:[…]) can never be a session file.
      if (!target.startsWith("/")) continue;
      let flags: number | undefined;
      try {
        const info = readFileSync(`/proc/${entry}/fdinfo/${fd}`, "utf8");
        const flagLine = info.split("\n").find((line) => line.startsWith("flags:"));
        const raw = flagLine?.split(":")[1]?.trim();
        flags = raw === undefined ? undefined : Number.parseInt(raw, 8);
      } catch {
        continue;
      }
      if (flags === undefined || Number.isNaN(flags)) continue;
      if ((flags & 0b11) === 0) continue; // neither O_WRONLY nor O_RDWR
      let canonical: string;
      try {
        canonical = realpathSync(target);
      } catch {
        continue;
      }
      if (!holders.has(canonical)) holders.set(canonical, pid);
    }
  }
  return holders;
}

/**
 * Pid of a FOREIGN process holding `file` open for writing, if any.
 * Convenience wrapper over {@link scanForeignWriters} for the single-file
 * resume gate; the supervisor uses the shared collector directly per tick.
 */
export function foreignWriterPid(file: string): number | undefined {
  let canonical: string;
  try {
    canonical = realpathSync(file);
  } catch {
    return undefined;
  }
  return scanForeignWriters().get(canonical);
}
