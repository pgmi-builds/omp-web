/**
 * Bridge store lifecycle: DB path resolution, open/close, and the module
 * singleton the rest of the bridge reaches through {@link getBridgeStore}.
 */
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { OMP_SESSIONS_ROOT } from "../omp-store.js";
import { BridgeStore } from "./db.js";
import { migrateWebuiJson, reconcileOnce } from "./reconcile.js";

let store: BridgeStore | undefined;

/**
 * Resolve the index path: `OMP_BRIDGE_DB` (absolute) or the profile's own
 * state dir (`$DSH_HOME/bridge-store.sqlite`). Throws on a relative/invalid
 * path, or one that falls inside OMP's native store (D7: OMP scans that dir
 * and would treat the `.sqlite` as a foreign session file).
 *
 * `$DSH_HOME` also anchors dsh's home-level singleton settings document
 * (`$DSH_HOME/settings.yaml`), which this bridge never reads; the profile
 * isolates that document via its own `settings.path` patch (settings-under-
 * profile), independent of this store.
 */
export function resolveBridgeDbPath(): string {
  const explicit = process.env.OMP_BRIDGE_DB;
  if (explicit !== undefined && explicit !== "" && !explicit.startsWith("/")) {
    throw new Error(`OMP_BRIDGE_DB must be an absolute path: ${explicit}`);
  }
  const path = resolve(
    explicit !== undefined && explicit !== ""
      ? explicit
      : join(process.env.DSH_HOME ?? join(homedir(), ".omp", "dsh"), "bridge-store.sqlite"),
  );
  const root = resolve(OMP_SESSIONS_ROOT);
  if (path === root || path.startsWith(`${root}/`)) {
    throw new Error(`bridge store must not live under OMP_SESSIONS_ROOT (${root}): ${path}`);
  }
  return path;
}

/**
 * Open the store, run the boot warm pass, then the one-time migration. The
 * warm pass must complete before the bridge serves traffic (D5.1): the first
 * landing already reads real titles/models from the index.
 */
export function initBridgeStore(path?: string): BridgeStore {
  if (store !== undefined) return store;
  const dbPath = path ?? resolveBridgeDbPath();
  mkdirSync(dirname(dbPath), { recursive: true });
  store = BridgeStore.open(dbPath);
  reconcileOnce(store);
  migrateWebuiJson(store);
  return store;
}

/** The live store, or undefined when not initialized (tests, no DB). */
export function getBridgeStore(): BridgeStore | undefined {
  return store;
}

/** Close and release the singleton (teardown). */
export function closeBridgeStore(): void {
  store?.close();
  store = undefined;
}
