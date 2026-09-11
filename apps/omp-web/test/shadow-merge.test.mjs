#!/usr/bin/env node
/**
 * P3 "shadow merge" (T11–T15) — parsed-transcript ownership moves from the
 * supervisor to the shared SessionCacheEntry. Covers, in-sandbox (temp dirs
 * only, no ~/.omp):
 *
 *   1. the ingest cursor lives on the cache entry (not the supervisor),
 *   2. the sync incremental ingest replays ONLY the delta on growth,
 *   3. parse count: exactly one parse per file change, zero on re-open.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  fillSessionCacheEntrySync,
  getParseCount,
  ingestSessionFileGrowthSync,
  sessionCacheEntryOf,
} from "../dist/session-persistence-omp.js";

const logger = { warn: () => {} };

function userLine(text, ts) {
  return JSON.stringify({ type: "message", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
}
function assistantLine(text, ts) {
  return JSON.stringify({
    type: "message",
    message: { role: "assistant", provider: "deepseek", model: "deepseek-v4-pro", timestamp: ts, content: [{ type: "text", text }] },
  });
}

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "omp-shadow-"));
  const file = join(dir, name);
  writeFileSync(file, contents);
  return { dir, file };
}

test("sync fill: the cache entry (not the supervisor) owns the cursor", () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    const before = getParseCount();
    const events = fillSessionCacheEntrySync(file, "sess-a", logger);
    assert.ok(events.length > 0, "filled a real transcript");
    const entry = sessionCacheEntryOf(file);
    assert.ok(entry !== undefined, "entry exists after the sync fill");
    assert.equal(entry.cursor.lastSeq, events.length, "cursor.lastSeq == replayed length");
    assert.ok(entry.cursor.size > 0, "cursor.size reflects the file");
    assert.equal(getParseCount(), before + 1, "exactly one parse for the fill");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("growth: sync ingest replays only the delta and parses once per change", () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    const events = fillSessionCacheEntrySync(file, "sess-a", logger);
    const before = getParseCount();
    appendFileSync(file, `${userLine("foreign", 3000)}\n`);
    const delta = ingestSessionFileGrowthSync(file, "sess-a", logger);
    assert.ok(delta.length > 0, "growth produced a delta");
    assert.ok(delta.some((event) => event.type === "user/message"), "delta carries the new user turn");
    const entry = sessionCacheEntryOf(file);
    assert.equal(entry.cursor.lastSeq, events.length + delta.length, "cursor advanced past the delta");
    assert.equal(getParseCount(), before + 1, "exactly one parse for the growth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no-growth: re-open parses zero times", () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    fillSessionCacheEntrySync(file, "sess-a", logger);
    const before = getParseCount();
    const delta = ingestSessionFileGrowthSync(file, "sess-a", logger);
    assert.equal(delta.length, 0, "no file change → no delta");
    assert.equal(getParseCount(), before, "no-growth ingest parses zero times");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("growth-free rewrite: mtime bump re-baselines without a delta", () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n${assistantLine("bye", 2000)}\n`);
  try {
    fillSessionCacheEntrySync(file, "sess-a", logger);
    // Same-size title-slot rewrite: bump mtime only (in-place header rewrite).
    utimesSync(file, new Date(), new Date(Date.now() + 5_000));
    const delta = ingestSessionFileGrowthSync(file, "sess-a", logger);
    assert.equal(delta.length, 0, "same-size rewrite produces no delta");
    // Re-baselined stat: a further no-change ingest parses zero times.
    const before = getParseCount();
    const again = ingestSessionFileGrowthSync(file, "sess-a", logger);
    assert.equal(again.length, 0);
    assert.equal(getParseCount(), before, "re-baselined stat: no further parse");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
