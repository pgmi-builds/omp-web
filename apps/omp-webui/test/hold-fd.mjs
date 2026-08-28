/**
 * Hold a file descriptor in a process OUTSIDE the caller's process tree.
 * `--fork-hold` / `--fork-ro` double-fork: a detached grandchild holds
 * <path> (O_WRONLY / O_RDONLY), writes its pid to <pidfile>, sleeps; the
 * middle exits so the grandchild reparents away from the caller. `--hold` /
 * `--ro` hold directly in the spawned process (a caller descendant) — used
 * to exercise the descendant-exemption path.
 */
import { openSync, writeFileSync, writeSync } from "node:fs";
import { spawn } from "node:child_process";

const [, , mode, path, pidfile] = process.argv;

if (mode === "--hold" || mode === "--ro") {
  const fd = openSync(path, mode === "--ro" ? "r" : "a");
  writeFileSync(pidfile, String(process.pid));
  if (mode !== "--ro") writeSync(fd, "\n");
  setTimeout(() => process.exit(0), 15_000);
} else if (mode === "--fork-hold" || mode === "--fork-ro") {
  const holder = spawn(process.execPath, [import.meta.filename, mode === "--fork-hold" ? "--hold" : "--ro", path, pidfile], {
    detached: true,
    stdio: "ignore",
  });
  holder.unref();
  process.exit(0);
}
