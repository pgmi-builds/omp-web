#!/usr/bin/env node
/**
 * dev/smoke-resume.mjs — Phase 3 resume/persistence regression smoke.
 *
 * Scenario: phase1 creates a session and completes two turns; the operator
 * then fully STOPS and restarts the dsh instance (hub: `stop` + `start` on
 * `dsh-omp-smoke`); phase2 proves the cold surface:
 *   1. session.list still finds the session (cold listing),
 *   2. its history renders the old turns (≥2 user/message, ≥2
 *      assistant/message, turns 1..2 numbered correctly, no turn 3),
 *   3. a follow-up on the cold session RESUMES it and produces a genuine
 *      new turn (turn/start turn=3 → assistant reply → turn/end turn=3),
 *      with the old turns still intact after the resume.
 *
 * Usage:
 *   node dev/smoke-resume.mjs phase1 [base-url]   # create + converse
 *   node dev/smoke-resume.mjs phase2 [base-url]   # after dsh restart
 * Default base-url http://127.0.0.1:3081. State file: /tmp/dsh-omp-smoke-resume.json
 * (phase2 also accepts an explicit session id: `phase2 <base-url> <sessionId>`).
 */
import { readFileSync, writeFileSync, unlinkSync } from "node:fs";

const phase = process.argv[2] ?? "phase1";
const BASE = `${process.argv[3] ?? "http://127.0.0.1:3081"}/api`;
const STATE_PATH = "/tmp/dsh-omp-smoke-resume.json";
let rpcSeq = 0;

async function call(method, payload) {
  const rpcId = `smoke-${++rpcSeq}`;
  const res = await fetch(`${BASE}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ type: "client-request", rpcId, method, payload }),
  });
  return res.json();
}

function summarize(history) {
  const events = history.result?.value?.events ?? [];
  const out = [];
  let chunks = 0;
  const flushChunks = () => {
    if (chunks > 0) out.push(`assistant/chunk ×${chunks}`);
    chunks = 0;
  };
  for (const { event: raw } of events) {
    const ev = raw?.event ?? raw;
    const data = ev?.data ?? {};
    const t = ev?.type;
    if (t === "assistant/chunk") {
      chunks += 1;
      continue;
    }
    flushChunks();
    const bits = [t];
    if (data.turn !== undefined) bits.push(`turn=${data.turn}`);
    if (data.step !== undefined) bits.push(`step=${data.step}`);
    if (data.reason !== undefined) bits.push(`reason=${data.reason.kind ?? JSON.stringify(data.reason)}`);
    out.push(bits.join(" "));
  }
  flushChunks();
  return out;
}

async function historyLines(sessionId) {
  return summarize(await call("session.history", { sessionId }));
}

/** Poll history until `done(lines)` holds or the cap elapses. Returns last lines. */
async function waitFor(sessionId, done, capPolls = 60) {
  let lines = [];
  for (let i = 0; i < capPolls; i++) {
    await new Promise((r) => setTimeout(r, 2000));
    lines = await historyLines(sessionId);
    if (done(lines)) return lines;
  }
  return lines;
}

// ── phase1: create + two completed turns ───────────────────────────────────
if (phase === "phase1") {
  const created = await call("session.create", {});
  const sessionId = created.result?.value?.sessionId;
  if (!sessionId) {
    console.error("FAIL: session.create returned", JSON.stringify(created));
    process.exit(1);
  }
  console.log("sessionId:", sessionId);

  const t0 = Date.now();
  const p1 = await call("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "Reply with exactly: ping1" }],
  });
  console.log("prompt1:", JSON.stringify(p1.result), `t+${Date.now() - t0}ms`);
  let lines = await waitFor(sessionId, (ls) => ls.some((l) => l.startsWith("turn/end turn=1")));
  if (!lines.some((l) => l.startsWith("turn/end turn=1"))) {
    console.error("FAIL: turn 1 never completed. History:");
    for (const l of lines) console.error(l);
    process.exit(1);
  }

  const p2 = await call("session.prompt", {
    sessionId,
    mode: "queue",
    content: [{ type: "text", text: "Reply with exactly: pong2" }],
  });
  console.log("prompt2:", JSON.stringify(p2.result), `t+${Date.now() - t0}ms`);
  lines = await waitFor(sessionId, (ls) => ls.some((l) => l.startsWith("turn/end turn=2")));
  if (!lines.some((l) => l.startsWith("turn/end turn=2"))) {
    console.error("FAIL: turn 2 never completed. History:");
    for (const l of lines) console.error(l);
    process.exit(1);
  }

  console.log("--- pre-restart history ---");
  for (const l of lines) console.log(l);
  writeFileSync(STATE_PATH, JSON.stringify({ sessionId, base: BASE }, null, 2));
  console.log(`\nphase1 done. Now fully STOP and restart dsh (hub stop/start on the smoke instance), then run:`);
  console.log(`  node docs/smoke-resume.mjs phase2`);
  process.exit(0);
}

// ── phase2: post-restart list → resume → follow-up ─────────────────────────
if (phase !== "phase2") {
  console.error(`unknown phase "${phase}" (expected phase1|phase2)`);
  process.exit(1);
}

let sessionId = process.argv[4];
if (!sessionId) {
  const state = JSON.parse(readFileSync(STATE_PATH, "utf8"));
  sessionId = state.sessionId;
}

// The instance may still be booting after the restart: poll session.list.
let listed;
for (let i = 0; i < 60; i++) {
  try {
    listed = await call("session.list", {});
    if (listed.result?.value?.items) break;
  } catch {
    /* fetch refused: not up yet */
  }
  await new Promise((r) => setTimeout(r, 2000));
}
const items = listed?.result?.value?.items ?? [];

// dev_0.0.3 §11: the Dash session id IS the durable key. The pairing
// (webui.json twin-embedding) makes it resumable across restarts — this is
// the exact stale-tab scenario that used to fail with "Cannot find Session
// ID", now the primary assertion.
const row = items.find((item) => item.sessionId === sessionId);
console.log(`session.list: ${items.length} item(s); dash id row ${row ? "FOUND" : "MISSING"}`);

let lines = await historyLines(sessionId);
console.log("--- cold history (pre-resume, by Dash id) ---");
for (const l of lines) console.log(l);

const p3 = await call("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "Reply with exactly: resumed3" }],
});
console.log("prompt3 (by Dash id, post-restart):", JSON.stringify(p3.result));

const final = await waitFor(sessionId, (ls) => ls.some((l) => l.startsWith("turn/end turn=3")));
console.log("--- post-resume history (by Dash id) ---");
for (const l of final) console.log(l);



const count = (prefix) => final.filter((l) => l.startsWith(prefix)).length;
const userMsgs = final.filter((l) => l === "user/message").length;
const assistantMsgs = final.filter((l) => l.startsWith("assistant/message")).length;
const checks = [
  ["session.list carries the Dash id row (durable pairing)", row !== undefined],
  ["cold history has ≥2 user/message", lines.filter((l) => l === "user/message").length >= 2],
  ["cold history has ≥2 assistant/message", lines.filter((l) => l.startsWith("assistant/message")).length >= 2],
  ["cold history numbers turns 1..2", lines.some((l) => l.startsWith("turn/start turn=1")) && lines.some((l) => l.startsWith("turn/start turn=2"))],
  ["cold history has no turn 3 yet", !lines.some((l) => l.startsWith("turn/start turn=3"))],
  ["follow-up accepted", p3.result?.value?.accepted === true],
  ["resumed follow-up opens turn 3", final.some((l) => l.startsWith("turn/start turn=3"))],
  ["turn 3 has an assistant reply", /assistant\/message turn=3/.test(final.join("\n"))],
  ["turn 3 completes", final.some((l) => l.startsWith("turn/end turn=3"))],
  ["old turns intact after resume", count("turn/start turn=1") === 1 && count("turn/start turn=2") === 1],
  ["three user messages total", userMsgs >= 3],
  ["three assistant messages total", assistantMsgs >= 3],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  ok &&= pass;
}
if (ok) {
  try { unlinkSync(STATE_PATH); } catch { /* already gone */ }
}
console.log(ok ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(ok ? 0 : 1);
