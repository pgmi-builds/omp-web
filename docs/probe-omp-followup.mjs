#!/usr/bin/env node
/**
 * docs/probe-omp-followup.mjs — Does OMP's own RPC follow_up generate a new
 * turn after the current one ends? Drives a real `omp --mode rpc` child and
 * prints the event timeline. Decides whether a pure pass-through bridge
 * (no bridge-side buffering) yields Turn 2 natively.
 *
 * Result (2026-08-22, omp 17.4.0): YES — follow_up sent mid-stream is queued,
 * then OMP itself opens turn 2 (turn_start + message_start role=user +
 * assistant reply) inside the same agent run. The `prompt` command with
 * streamingBehavior:"followUp" does NOT do this (resumeIfIdle hardcoded false
 * on that path, true on the follow_up path — in-process-agent-connection.ts).
 */
import { spawn } from "node:child_process";

const child = spawn("/home/u1/.local/bin/omp", ["--mode", "rpc", "--approval-mode", "yolo"], {
  stdio: ["pipe", "pipe", "inherit"],
});
const t0 = Date.now();
const log = (...a) => console.log(`t+${String(Date.now() - t0).padStart(6)}ms`, ...a);

let buf = "";
child.stdout.on("data", (chunk) => {
  buf += chunk.toString("utf8");
  let idx;
  while ((idx = buf.indexOf("\n")) !== -1) {
    const line = buf.slice(0, idx).trim();
    buf = buf.slice(idx + 1);
    if (line === "") continue;
    handle(JSON.parse(line));
  }
});

function send(obj) {
  child.stdin.write(JSON.stringify(obj) + "\n");
}

let runCount = 0;
let userEcho = 0;
function handle(rec) {
  if (rec.type === "ready") {
    log("READY");
    send({ type: "prompt", id: "p1", message: "Count slowly from 1 to 30, one number per line, then stop." });
    setTimeout(() => {
      log(">>> sending follow_up mid-stream");
      send({ type: "follow_up", id: "f1", message: "Reply with exactly: pong2" });
    }, 2500);
    return;
  }
  if (rec.type === "response") {
    log(`response ${rec.command} success=${rec.success}`);
    return;
  }
  switch (rec.type) {
    case "agent_start":
      runCount += 1;
      log(`agent_start (agent run #${runCount})`);
      break;
    case "agent_end":
      log(`agent_end (run #${runCount})`);
      break;
    case "turn_start":
    case "turn_end":
      log(rec.type);
      break;
    case "message_start":
      if (rec.message?.role === "user") {
        userEcho += 1;
        log(`message_start role=user #${userEcho}: ${JSON.stringify(rec.message.content).slice(0, 60)}`);
      } else {
        log(`message_start role=${rec.message?.role}`);
      }
      break;
    case "message_end":
      if (rec.message?.role === "assistant") {
        log(`message_end assistant: ${JSON.stringify(rec.message.content).slice(0, 80)}`);
      }
      break;
    default:
      break; // deltas and tool noise silenced
  }
}

setTimeout(() => {
  log(`DONE agentRuns=${runCount} userMessages=${userEcho}`);
  child.kill("SIGTERM");
  process.exit(0);
}, 45000);
