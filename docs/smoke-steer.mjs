#!/usr/bin/env node
/**
 * docs/smoke-steer.mjs — Phase 2 steering regression.
 *
 * Scenario: prompt1 starts a long streaming reply; a steer-mode message is
 * sent mid-stream. PASS requires the steering message to surface as a
 * user/message inside the SAME turn (a step), the turn to keep running, and
 * exactly one turn total.
 *
 * Usage: node docs/smoke-steer.mjs [base-url]
 */
const BASE = `${process.argv[2] ?? "http://127.0.0.1:3081"}/api`;
let rpcSeq = 0;

async function call(method, payload) {
  const rpcId = `steer-${++rpcSeq}`;
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
  for (const { event: raw } of events) {
    const ev = raw?.event ?? raw;
    const data = ev?.data ?? {};
    const t = ev?.type;
    if (t === "assistant/chunk") {
      if (out.at(-1)?.startsWith("assistant/chunk")) continue;
      out.push("assistant/chunk ×n");
      continue;
    }
    const bits = [t];
    if (data.turn !== undefined) bits.push(`turn=${data.turn}`);
    if (data.step !== undefined) bits.push(`step=${data.step}`);
    out.push(bits.join(" "));
  }
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
  content: [{ type: "text", text: "Write a 200-word story about a lighthouse. Do not stop early." }],
});
console.log("prompt1:", JSON.stringify(p1.result), `t+${Date.now() - t0}ms`);

await new Promise((r) => setTimeout(r, 2500));
const s1 = await call("session.prompt", {
  sessionId,
  mode: "steer",
  content: [{ type: "text", text: "Make the lighthouse keeper a cat from now on." }],
});
console.log("steer:", JSON.stringify(s1.result), `t+${Date.now() - t0}ms`);

let lines = [];
let turnEnds = 0;
let userMsgs = 0;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, 2000));
  const history = await call("session.history", { sessionId });
  lines = summarize(history);
  turnEnds = lines.filter((l) => l.startsWith("turn/end")).length;
  userMsgs = lines.filter((l) => l === "user/message").length;
  if (turnEnds >= 1) break;
}

console.log("--- event history ---");
for (const l of lines) console.log(l);

const turnStarts = lines.filter((l) => l.startsWith("turn/start")).length;
const checks = [
  ["steering user/message present", userMsgs >= 2],
  ["single turn (steer stays inside)", turnStarts === 1 && turnEnds === 1],
];
let ok = true;
for (const [name, pass] of checks) {
  console.log(`${pass ? "PASS" : "FAIL"}: ${name}`);
  ok &&= pass;
}
console.log(ok ? "SMOKE: PASS" : "SMOKE: FAIL");
process.exit(ok ? 0 : 1);
