#!/usr/bin/env node
/** docs/probe-omp-idle-signals.mjs — S3: do get_state/get_subagents respond
 *  cleanly on an IDLE `omp --mode rpc` child (the five-fold check's RPC calls)? */
import { spawn } from "node:child_process";

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

const shape = (v) => {
  if (v === undefined) return "undefined";
  if (Array.isArray(v)) return `array[${v.length}]`;
  if (v && typeof v === "object") return `object{${Object.keys(v).join(",")}}`;
  return `${typeof v}:${JSON.stringify(v)}`;
};

let ready = false;
function handle(rec) {
  if (rec.type === "ready" && !ready) {
    ready = true;
    log("READY — querying idle signals");
    send({ type: "get_state" });
    send({ type: "get_subagents" });
    send({ type: "get_session_stats" });
    return;
  }
  if (rec.type === "response") {
    log(`response RAW: ${JSON.stringify(rec).slice(0, 500)}`);
    return;
  }
  if (rec.type === "error") {
    log(`ERROR ${JSON.stringify(rec)}`);
  }
}

setTimeout(() => {
  log("DONE");
  child.kill("SIGTERM");
  process.exit(0);
}, 12000);
