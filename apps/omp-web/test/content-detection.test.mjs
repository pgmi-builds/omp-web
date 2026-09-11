#!/usr/bin/env node
/**
 * Content-based foreign-writer detection (omp 18 model: writers open per
 * write, so detection is INCREMENTAL user records we never delivered).
 *
 * Covers the held-state watch: baseline cursor at onHeld, own delivered
 * texts exempt, foreign prompt → avoidance listener, title-rewrite-only
 * growth → re-baseline without avoidance.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, writeFileSync, appendFileSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
process.env.OMP_FILE_FOLLOW_INTERVAL_MS = "1"; // every poll() follows (0 would DISABLE the cadence)




const { Supervisor } = await import("../dist/supervisor.js");

function fixture(dir, name) {
  const file = join(dir, name);
  writeFileSync(file, [
    JSON.stringify({ type: "title", title: "t", sessionId: name }),
    JSON.stringify({ type: "session", sessionId: name, cwd: dir }),
    JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text: "history prompt" }] } }),
    JSON.stringify({ type: "message", message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-pro", content: [{ type: "text", text: "history reply" }] } }),
  ].join("\n") + "\n");
  return file;
}
const appendUser = (file, text) =>
  appendFileSync(file, JSON.stringify({ type: "message", message: { role: "user", content: [{ type: "text", text }] } }) + "\n");

async function rig(dir, name) {
  const sup = new Supervisor();
  sup.attach({}, () => {});
  const avoided = [];
  sup.onAvoidance((id) => avoided.push(id));
  const file = fixture(dir, name);
  sup.onHeld("sess-" + name, file);
  await sup.poll(); // complete the (async) hold baseline before the test appends
  return { sup, avoided, file };
}

test("held: own delivered user text is not foreign", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sup-"));
  const { sup, avoided, file } = await rig(dir, "own");
  sup.reportUserText("sess-own", "webui prompt");
  appendUser(file, "webui prompt");
  await sup.poll();
  assert.equal(avoided.length, 0);
  assert.deepEqual(sup.badge("sess-own"), {});
});

test("held: foreign user prompt triggers avoidance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sup-"));
  const { sup, avoided, file } = await rig(dir, "foreign");
  appendUser(file, "tui takeover prompt");
  await sup.poll();
  assert.deepEqual(avoided, ["sess-foreign"]);
  assert.equal(sup.badge("sess-foreign").diverged, true);
});

test("held: history before the hold is never judged", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sup-"));
  // The fixture already contains "history prompt" — baseline excludes it.
  const { sup, avoided } = await rig(dir, "hist");
  await sup.poll();
  assert.equal(avoided.length, 0);
});

test("held: growth-free rewrite (title slot) re-baselines, no avoidance", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sup-"));
  const { sup, avoided, file } = await rig(dir, "title");
  await sup.poll(); // baseline pass
  // Same-size title-slot rewrite: bump mtime only (in-place header rewrite).
  utimesSync(file, new Date(), new Date(Date.now() + 5_000));
  await sup.poll();
  assert.equal(avoided.length, 0);
});

test("held: repeated polls without growth do nothing", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "omp-sup-"));
  const { sup, avoided } = await rig(dir, "idle");
  await sup.poll();
  await sup.poll();
  await sup.poll();
  assert.equal(avoided.length, 0);
});
