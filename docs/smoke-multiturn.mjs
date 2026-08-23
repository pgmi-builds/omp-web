#!/usr/bin/env node
/**
 * dev/smoke-multiturn.mjs — Phase 2 multi-turn regression smoke.
 *
 * Scenario: prompt1 starts a long streaming reply; prompt2 is sent mid-stream
 * (mode "queue"). PASS requires a genuine second turn:
 *   turn/start turn=2 → user/message → step/start → assistant chunks/message
 *   → step/end → turn/end turn=2
 * and BOTH user messages present in history.
 *
 * Usage: node dev/smoke-multiturn.mjs [base-url]   (default http://127.0.0.1:3081)
 */
const BASE = `${process.argv[2] ?? "http://127.0.0.1:3081"}/api`;
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
  content: [{ type: "text", text: "List the first 30 prime numbers, one per line, then stop." }],
});
console.log("prompt1:", JSON.stringify(p1.result), `t+${Date.now() - t0}ms`);

// Prompt2 must land while turn 1 is still streaming (30 primes ≫ 2s).
await new Promise((r) => setTimeout(r, 2000));
const p2 = await call("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "Reply with exactly: pong2" }],
});
console.log("prompt2:", JSON.stringify(p2.result), `t+${Date.now() - t0}ms`);

// Poll for turn 2 completion (or 120s cap: two model turns, possibly tool-using).
let lines = [];
let sawTurn2Start = false;
let sawTurn2End = false;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const history = await call("session.history", { sessionId });
  lines = summarize(history);
  sawTurn2Start ||= lines.some((l) => l.startsWith("turn/start turn=2"));
  sawTurn2End ||= lines.some((l) => l.startsWith("turn/end turn=2"));
  if (sawTurn2End) break;
}

console.log("--- event history ---");
for (const l of lines) console.log(l);

const userMsgs = lines.filter((l) => l === "user/message").length;
const checks = [
  ["turn/start turn=2", sawTurn2Start],
  ["turn/end turn=2", sawTurn2End],
  ["two user/message events", userMsgs >= 2],
  ["assistant/message in turn 2", /assistant\/message turn=2/.test(lines.join("\n"))],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  ok &&= pass;
}
console.log(ok ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(ok ? 0 : 1);
