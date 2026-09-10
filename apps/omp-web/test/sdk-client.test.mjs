import test from "node:test";
import assert from "node:assert/strict";
import { OmpSdkClient } from "../dist/sdk-client.js";

test("OmpSdkClient surface parity over shared sidecar", async (t) => {
  const a = await OmpSdkClient.spawn(["--approval-mode", "yolo"]);
  t.after(() => a.close());
  const b = await OmpSdkClient.spawn();
  t.after(() => b.close());

  const stateA = await a.getState();
  assert.equal(typeof stateA.isStreaming, "boolean");
  assert.ok(stateA.sessionId, "omp session id present");
  assert.ok(stateA.sessionFile, "file-backed session");

  // isolation: two clients hold different sessions
  const stateB = await b.getState();
  assert.notEqual(stateA.sessionId, stateB.sessionId);

  assert.deepEqual(await a.getMessages(), []);
  assert.deepEqual(await a.getSubagents(), []);
  assert.equal(typeof (await a.getSessionStats()).contextUsage, "object");

  // raw send compatibility path
  const resp = await a.send({ type: "get_state" });
  assert.equal(resp.success, true);
  assert.equal(resp.data.sessionId, stateA.sessionId);

  // sendRaw (extension_ui_response) must not throw
  a.sendRaw({ type: "extension_ui_response", id: "x", value: "Deny" });

  // unsupported arg fails loudly
  await assert.rejects(() => OmpSdkClient.spawn(["--unknown-flag"]));
});
