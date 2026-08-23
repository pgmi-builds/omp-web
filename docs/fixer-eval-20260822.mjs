
const BASE = "http://127.0.0.1:3081/api";
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

const created = await call("session.create", {});
const sessionId = created.result.value.sessionId;
console.log("sessionId:", sessionId);

const t0 = Date.now();
const p1 = await call("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "List the first 10 prime numbers, one per line." }],
});
console.log("prompt1 accepted:", JSON.stringify(p1.result), "t+", Date.now() - t0, "ms");

// wait ~2s while turn 1 streams
await new Promise((r) => setTimeout(r, 2000));
console.log("sending prompt2 at t+", Date.now() - t0, "ms");

const p2 = await call("session.prompt", {
  sessionId,
  mode: "queue",
  content: [{ type: "text", text: "Reply with exactly: pong2" }],
});
console.log("prompt2 accepted:", JSON.stringify(p2.result), "t+", Date.now() - t0, "ms");

// wait ~20s for both turns to settle
await new Promise((r) => setTimeout(r, 20000));
console.log("fetching history at t+", Date.now() - t0, "ms");

const hist = await call("session.history", { sessionId });
const events = hist.result?.value?.events ?? [];
console.log("TOTAL_EVENTS:", events.length);
for (const e of events) {
  const ev = e.event ?? e;
  const data = ev.data ?? {};
  const line = `${ev.type}` + (data.turn !== undefined ? ` turn=${data.turn}` : "") + (data.step !== undefined ? ` step=${data.step}` : "") + (data.reason !== undefined ? ` reason=${data.reason}` : "");
  console.log(line);
}
