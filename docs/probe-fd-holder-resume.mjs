#!/usr/bin/env node
/** Who holds an OLD session file write-mode while `omp --mode rpc --resume` runs? */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

const file = process.argv[2];
const self = process.pid;
const child = spawn("/home/u1/.local/bin/omp", ["--mode", "rpc", "--approval-mode", "yolo", "--resume", file], {
  stdio: ["pipe", "pipe", "inherit"],
  cwd: process.cwd(),
});
const T0 = Date.now();
const log = (...a) => console.log(`t+${String(Date.now() - T0).padStart(6)}ms`, ...a);

function ppidOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return Number.parseInt(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1], 10);
  } catch { return undefined; }
}
function isDescendant(pid) {
  let cur = pid;
  for (let h = 0; h < 32; h++) {
    if (cur === self) return true;
    const p = ppidOf(cur);
    if (p === undefined || p <= 1) return false;
    cur = p;
  }
  return false;
}
function cmdline(pid) {
  try { return readFileSync(`/proc/${pid}/cmdline`, "utf8").replace(/\0/g, " ").slice(0, 80); } catch { return "?"; }
}

function scan(label) {
  const holders = [];
  for (const e of readdirSync("/proc")) {
    if (!/^[0-9]+$/.test(e)) continue;
    const pid = Number(e);
    let fds;
    try { fds = readdirSync(`/proc/${e}/fd`); } catch { continue; }
    for (const fd of fds) {
      let t;
      try { t = readlinkSync(`/proc/${e}/fd/${fd}`); } catch { continue; }
      if (t !== file) continue;
      let flags = 0;
      try {
        const info = readFileSync(`/proc/${e}/fdinfo/${fd}`, "utf8");
        flags = Number.parseInt(info.split("\n").find((l) => l.startsWith("flags:"))?.split(":")[1]?.trim(), 8);
      } catch {}
      if ((flags & 0b11) === 0) continue;
      holders.push({ pid, write: true, descendant: isDescendant(pid), cmd: cmdline(pid) });
    }
  }
  log(`${label}: ${JSON.stringify(holders)}`);
}

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    try {
      const rec = JSON.parse(line);
      if (rec.type === "ready") {
        log("READY");
        scan("at-ready");
        setTimeout(() => { scan("t+3s"); child.kill("SIGTERM"); setTimeout(() => process.exit(0), 500); }, 3000);
      }
    } catch {}
  }
});
setTimeout(() => process.exit(1), 20000);
