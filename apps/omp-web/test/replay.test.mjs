#!/usr/bin/env node
/**
 * Replay time synthesis — the replayed log must preserve the OMP transcript's
 * real chronology (each message's own epoch-ms `timestamp`), not collapse every
 * event onto the replay instant. Covers: real-timestamp seeding, monotonicity,
 * and the no-timestamp fallback.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { replayOmpMessages, replayOmpTranscript } = await import("../dist/replay.js");

function msg(role, timestamp, text = "") {
  return { role, timestamp, content: text ? [{ type: "text", text }] : [] };
}

test("replayed events carry their OMP message timestamps", () => {
  const t0 = 1788120868478; // 2026-08-30T20:14:28Z
  const events = replayOmpMessages([
    msg("user", t0, "hi"),
    msg("assistant", t0 + 3000),
    msg("toolResult", t0 + 3001),
  ]);
  // First user turn's events land at the message timestamp, not Date.now()
  // (which would be ~months later in epoch ms).
  const userEvent = events.find((e) => e.type === "user/message");
  assert.ok(userEvent !== undefined);
  assert.ok(userEvent.time >= t0 && userEvent.time < t0 + 10, `user time ${userEvent.time} not near ${t0}`);
  // Chronological: assistant events sit after the user turn, near t0+3000.
  const assistant = events.find((e) => e.type === "assistant/message");
  assert.ok(assistant !== undefined);
  assert.ok(assistant.time >= t0 + 3000 && assistant.time < t0 + 3010, `assistant time ${assistant.time} not near ${t0 + 3000}`);
  // Strictly monotonic time across the whole log.
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].time >= events[i - 1].time, `time regressed at event ${i}`);
  }
});

test("missing timestamps fall back to a monotonic now-base", () => {
  const events = replayOmpMessages([msg("user", undefined, "hi"), msg("assistant", undefined)]);
  for (let i = 1; i < events.length; i += 1) {
    assert.ok(events[i].time >= events[i - 1].time);
  }
  assert.ok(events[0].time > 0);
});

test("replayOmpTranscript emits no system prompt node (cold replay is JSONL-faithful)", () => {
  const modelChanges = [{ model: "deepseek/deepseek-v4-pro", role: "default" }];
  const events = replayOmpTranscript([], undefined, undefined, modelChanges);
  // Cold replay must contain NO system/message — the OMP JSONL records no
  // system prompt, so the static replay line emits none (RPC is the only emitter).
  assert.equal(events.find((e) => e.type === "system/message"), undefined, "no system/message in cold replay");
  const header = events.find((e) => e.type === "request/header");
  assert.ok(header !== undefined, "request/header present");
  assert.equal(header.data.reason, "resume");
  assert.equal(header.data.header.system, undefined, "header must omit system (0.1.5 contract)");
});
