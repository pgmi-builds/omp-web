#!/usr/bin/env node
/** Who holds a fresh `omp --mode rpc` session file write-mode? The child
 *  itself (bridge descendant → exempt) or a broker (foreign → dual-hold)? */
import { spawn } from "node:child_process";
import { readdirSync, readFileSync, readlinkSync } from "node:fs";

const self = process.pid;
const child = spawn("/home/u1/.local/bin/omp", ["--mode", "rpc", "--approval-mode", "yolo"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const T0 = Date.now();
const log = (...a) => console.log(`t+${String(Date.now() - T0).padStart(6)}ms`, ...a);

let buf = "";
child.stdout.on("data", (c) => {
  buf += c.toString("utf8");
  let i;
  while ((i = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (!line) continue;
    handle(JSON.parse(line));
  }
});
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

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

let done = false;
function handle(rec) {
  if (rec.type === "ready") {
    send({ type: "get_session_stats" });
    return;
  }
  if (rec.type === "response" && rec.command === "get_session_stats" && !done) {
    done = true;
    const file = rec.data?.sessionFile;
    log(`sessionFile=${file}`);
    if (!file) return process.exit(1);
    setTimeout(() => {
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
          holders.push({ pid, write: (flags & 0b11) !== 0, descendant: isDescendant(pid), ppid: ppidOf(pid) });
        }
      }
      log("holders:", JSON.stringify(holders, null, 1));
      child.kill("SIGTERM");
      setTimeout(() => process.exit(0), 500);
    }, 1500);
  }
}
setTimeout(() => process.exit(1), 20000);
