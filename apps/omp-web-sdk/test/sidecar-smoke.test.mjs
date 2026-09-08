import test from "node:test";
import assert from "node:assert/strict";
import { OmpSdkSidecar } from "../dist/index.js";

test("sidecar skeleton roundtrip", async (t) => {
  const sidecar = new OmpSdkSidecar({ ompHome: "/home/u1/.omp" });
  t.after(() => sidecar.stop());
  const ready = await sidecar.start();
  assert.equal(ready.protocol, 0);

  const ping = await sidecar.call("sys.ping");
  assert.equal(ping.pong, true);
  assert.match(ping.sdk, /^\d+\./);
  assert.match(ping.bun, /^1\./);

  const models = await sidecar.call("models.list");
  assert.ok(models.models.length > 0, "has models");
  assert.ok(models.providers.includes("deepseek"));
  console.log("models:", models.models.length, "providers:", models.providers.join(","));

  const created = await sidecar.call("session.create", { persistence: "memory" });
  assert.ok(created.sessionId);

  const info = await sidecar.call("session.info", { sessionId: created.sessionId });
  assert.equal(info.sessionId, created.sessionId);
  assert.equal(info.isStreaming, false);
  assert.equal(info.messageCount, 0);

  const disposed = await sidecar.call("session.dispose", { sessionId: created.sessionId });
  assert.equal(disposed.disposed, true);

  const listed = await sidecar.call("sessions.list", { all: true });
  assert.ok(Array.isArray(listed.sessions));
  console.log("sessions listed:", listed.sessions.length);
});
