#!/usr/bin/env node
/**
 * P3 "shadow merge" (T11–T15) — parsed-transcript ownership moves from the
 * supervisor to the shared SessionCacheEntry. Covers, in-sandbox (temp dirs
 * only, no ~/.omp):
 *
 *   1. the ingest cursor lives on the cache entry (not the supervisor),
 *   2. the async incremental ingest replays only the delta on growth, and
 *      foreign-writer detection runs on the LENIENT delta even when the entry
 *      validation fails (Important-1 mechanism),
 *   3. parse count: exactly one parse per file change, zero on re-open, and
 *      zero across the growth → no-change re-open → cold-read cycle (T13).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import {
  eventsForSessionCache,
  getParseCount,
  ingestSessionFileGrowth,
  sessionCacheEntryOf,
} from "../dist/session-persistence-omp.js";
import { readOmpTranscript } from "../dist/omp-store.js";

const logger = { warn: () => {} };
// Inject a JSONL reader so tests exercise the shared fill/ingest without the
// SDK sidecar (the sidecar cannot read these minimal temp fixtures).
const reader = async (file) => readOmpTranscript(file);

function header(id) {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, agentPreset: "omp" };
}

function userLine(text, ts) {
  return JSON.stringify({ type: "message", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
}
function assistantLine(text, ts, withModel = true) {
  const message = withModel
    ? { role: "assistant", provider: "deepseek", model: "deepseek-v4-pro", timestamp: ts, content: [{ type: "text", text }] }
    : { role: "assistant", timestamp: ts, content: [{ type: "text", text }] };
  return JSON.stringify({ type: "message", message });
}

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "omp-shadow-"));
  const file = join(dir, name);
  writeFileSync(file, contents);
  return { dir, file };
}

function fill(file, id = "sess-a") {
  return { file, preset: null, title: undefined, createdAt: 0, header: header(id), logger, readTranscript: reader };
}

test("fill: the cache entry (not the supervisor) owns the cursor", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    const before = getParseCount();
    const events = await eventsForSessionCache(fill(file));
    assert.ok(events.length > 0, "filled a real transcript");
    const entry = sessionCacheEntryOf(file);
    assert.ok(entry !== undefined, "entry exists after the fill");
    assert.equal(entry.cursor.lastSeq, events.length, "cursor.lastSeq == replayed length");
    assert.ok(entry.cursor.size > 0, "cursor.size reflects the file");
    assert.equal(getParseCount(), before + 1, "exactly one parse for the fill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("growth: ingest replays only the delta and parses once per change", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    const events = await eventsForSessionCache(fill(file));
    const before = getParseCount();
    appendFileSync(file, `${userLine("foreign", 3000)}\n`);
    const { foreign, shadow } = await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    assert.ok(foreign.length > 0, "growth produced a lenient delta");
    assert.ok(foreign.some((event) => event.type === "user/message"), "delta carries the new user turn");
    assert.ok(shadow.length > 0, "validated delta mirrors the lenient delta for a valid transcript");
    const entry = sessionCacheEntryOf(file);
    assert.equal(entry.cursor.lastSeq, events.length + foreign.length, "cursor advanced past the delta");
    assert.equal(getParseCount(), before + 1, "exactly one parse for the growth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-growth: re-open parses zero times", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    await eventsForSessionCache(fill(file));
    const before = getParseCount();
    const { foreign } = await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    assert.equal(foreign.length, 0, "no file change → no delta");
    assert.equal(getParseCount(), before, "no-growth ingest parses zero times");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("growth-free rewrite: mtime bump re-baselines without a delta", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    await eventsForSessionCache(fill(file));
    // Same-size title-slot rewrite: bump mtime only (in-place header rewrite).
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const { foreign } = await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    assert.equal(foreign.length, 0, "same-size rewrite produces no delta");
    const before = getParseCount();
    const again = await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    assert.equal(again.foreign.length, 0);
    assert.equal(getParseCount(), before, "re-baselined stat: no further parse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validation-failed growth still yields the lenient delta for detection", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    await eventsForSessionCache(fill(file));
    // A malformed assistant (no model) makes validateStoredEvents fail-soft to
    // an empty log; the foreign user record must STILL surface in the lenient delta.
    appendFileSync(file, `${assistantLine("bad", 3000, false)}\n${userLine("foreign", 4000)}\n`);
    const { foreign, shadow } = await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    assert.ok(foreign.some((event) => event.type === "user/message"), "lenient delta still carries the foreign user record");
    assert.equal(shadow.length, 0, "validated delta is empty on validation failure");
    assert.equal(sessionCacheEntryOf(file).events.length, 0, "entry fails soft to an empty log");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("teardown cycle: growth → no-change re-open → cold read parses zero (T13)", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    await eventsForSessionCache(fill(file)); // live fill (parse 1)
    appendFileSync(file, `${userLine("again", 3000)}\n`);
    const { foreign } = await ingestSessionFileGrowth(file, "sess-a", logger, reader); // growth (parse 2)
    assert.ok(foreign.length > 0);
    const before = getParseCount();
    // no-change cold read (re-open) → cache hit, zero additional parses.
    await eventsForSessionCache(fill(file));
    assert.equal(getParseCount(), before, "cold read after ingest parses zero times");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
