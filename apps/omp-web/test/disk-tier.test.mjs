#!/usr/bin/env node
/**
 * P4 "disk tier + LRU" (T16–T21) — fail-soft persistence of the derived replay
 * cache under `<DSH_HOME>/cache/replay`, bounded by an in-memory LRU. Covers,
 * in-sandbox (temp dirs only, no ~/.omp):
 *
 *   1. disk adoption — a matching, valid disk replay is adopted (zero re-parse),
 *   2. fingerprint-mismatch fallback — a changed transcript re-reads + rewrites,
 *   3. corrupt file fail-soft — a garbage disk file degrades to a normal fill,
 *   4. ompVersion-change invalidation — a version bump refuses the stale replay,
 *   5. LRU evict/refill — coldest entries are evicted (flush-before-evict) and
 *      refill on next access,
 *   6. disk-off switch — zero filesystem writes outside memory.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";
import { readOmpTranscript } from "../dist/omp-store.js";
import {
  _clearSessionCacheForTest,
  _flushDiskForTest,
  _setCachePolicyForTest,
  _sweepReplayCacheDirForTest,
  eventsForSessionCache,
  getParseCount,
  ingestSessionFileGrowth,
  sessionCacheEntryOf,
  touchSessionCacheEntry,
} from "../dist/session-persistence-omp.js";

const logger = { warn: () => {} };
const reader = async (file) => readOmpTranscript(file);

function header(id) {
  return { version: SESSION_FORMAT_VERSION, id: SessionId(id), createdAt: 0, isSeeded: false, agentPreset: "omp" };
}

function userLine(text, ts) {
  return JSON.stringify({ type: "message", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
}

function tempDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function tempFile(dir, name, contents) {
  const file = join(dir, name);
  writeFileSync(file, contents);
  return file;
}

function fill(file, id, counting) {
  return {
    file,
    preset: null,
    title: undefined,
    createdAt: 0,
    header: header(id),
    logger,
    readTranscript: counting,
  };
}

/** A counting reader wrapping the JSONL parser (sidecar-free). */
function countingReader(state) {
  return async (file) => {
    state.reads += 1;
    return readOmpTranscript(file);
  };
}

function diskFile(cacheDir, id) {
  return join(cacheDir, `${id}.json`);
}

function readDisk(cacheDir, id) {
  return JSON.parse(readFileSync(diskFile(cacheDir, id), "utf8"));
}

test("disk adoption: a matching valid replay is adopted with zero re-parse", async () => {
  const cacheDir = tempDir("omp-disk-adopt-");
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-test" });
    const events = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1, "first fill parses once");
    assert.ok(events.length > 0, "replayed a real transcript");
    assert.ok(existsSync(diskFile(cacheDir, "sess-a")), "the L2 fill wrote the disk file");

    // Drop memory only; the disk file must serve the replay without a re-parse.
    _clearSessionCacheForTest();
    const before = getParseCount();
    const again = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1, "adoption performed no second parse");
    assert.equal(getParseCount(), before, "adoption did not increment the parse counter");
    assert.ok(again.length === events.length, "adopted the same event count");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("fingerprint-mismatch fallback: a changed transcript re-reads and rewrites", async () => {
  const cacheDir = tempDir("omp-disk-mismatch-");
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-test" });
    await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1);

    // Grow the transcript: its (size, mtime) no longer match the disk fingerprint.
    appendFileSync(file, `${userLine("again", 2000)}\n`);
    const before = getParseCount();
    const events = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 2, "a stale fingerprint triggers a re-read");
    assert.equal(getParseCount(), before + 1, "exactly one parse for the re-fill");
    assert.ok(events.length > 2, "re-fill reflects the appended turn");
    // The rewritten disk fingerprint now matches the grown transcript.
    const fp = readDisk(cacheDir, "sess-a").fingerprint;
    assert.ok(fp.size > 0, "rewritten fingerprint carries the new size");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("corrupt file fail-soft: a garbage disk file degrades to a normal fill", async () => {
  const cacheDir = tempDir("omp-disk-corrupt-");
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-test" });
    const { mkdirSync } = await import("node:fs");
    mkdirSync(cacheDir, { recursive: true });
    writeFileSync(diskFile(cacheDir, "sess-a"), "{ this is not valid json");

    const events = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1, "a corrupt disk file falls back to a parse");
    assert.ok(events.length > 0, "the normal fill still serves the replay");
    // The fill rewrote the disk file atomically — it is now valid JSON.
    const repaired = readDisk(cacheDir, "sess-a");
    assert.ok(Array.isArray(repaired.events), "the corrupt disk file was rewritten valid");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("ompVersion-change invalidation: a version bump refuses the stale replay", async () => {
  const cacheDir = tempDir("omp-disk-version-");
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-1" });
    await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1);

    // The process now resolves a different OMP version → the disk replay is stale.
    _clearSessionCacheForTest();
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-2" });
    const before = getParseCount();
    const events = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 2, "a version change invalidates the disk replay");
    assert.equal(getParseCount(), before + 1);
    assert.ok(events.length > 0);
    // The rewritten disk file now carries the new version.
    assert.equal(readDisk(cacheDir, "sess-a").fingerprint.ompVersion, "v-2");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("LRU evict/refill: coldest entry is evicted (flush-before-evict) and refills", async () => {
  const cacheDir = tempDir("omp-disk-lru-");
  const dir = tempDir("omp-disk-src-");
  const fa = tempFile(dir, "a.jsonl", `${userLine("a", 1000)}\n`);
  const fb = tempFile(dir, "b.jsonl", `${userLine("b", 1000)}\n`);
  const fc = tempFile(dir, "c.jsonl", `${userLine("c", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 2, maxBytes: 0, ompVersion: () => "v-test" });

    await eventsForSessionCache(fill(fa, "sess-a", countingReader(state)));
    touchSessionCacheEntry(fa); // A was viewed → not the coldest
    await eventsForSessionCache(fill(fb, "sess-b", countingReader(state)));
    // Filling C exceeds the cap of 2 → evict the coldest (B, never viewed).
    await eventsForSessionCache(fill(fc, "sess-c", countingReader(state)));

    assert.ok(sessionCacheEntryOf(fb) === undefined, "the coldest entry (B) was evicted");
    assert.ok(sessionCacheEntryOf(fa) !== undefined, "the viewed entry (A) survived");
    assert.ok(sessionCacheEntryOf(fc) !== undefined, "the just-filled entry (C) survived");
    assert.ok(existsSync(diskFile(cacheDir, "sess-b")), "eviction flushed B to disk first");

    // Refill: B returns on next access — from the disk tier, zero re-parse.
    const before = getParseCount();
    const refilled = await eventsForSessionCache(fill(fb, "sess-b", countingReader(state)));
    assert.ok(refilled.length > 0, "evicted entry refills on next access");
    assert.equal(getParseCount(), before, "refill adopted from disk without a re-parse");
    assert.ok(sessionCacheEntryOf(fb) !== undefined, "B is back in memory");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("disk-off switch: zero filesystem writes outside memory", async () => {
  const cacheRoot = tempDir("omp-disk-off-root-");
  const cacheDir = join(cacheRoot, "replay"); // never created by the disk tier
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  const state = { reads: 0 };
  try {
    _setCachePolicyForTest({ diskEnabled: false, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-test" });
    const events = await eventsForSessionCache(fill(file, "sess-a", countingReader(state)));
    assert.equal(state.reads, 1, "the fill still runs in memory");
    assert.ok(events.length > 0, "memory-only replay still served");
    assert.equal(existsSync(cacheDir), false, "no disk directory was ever created");

    // An incremental append must also write nothing to disk.
    appendFileSync(file, `${userLine("again", 2000)}\n`);
    await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    _flushDiskForTest();
    assert.equal(existsSync(cacheDir), false, "no disk writes after ingest either");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheRoot, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("debounced flush: an incremental append reaches disk after flush", async () => {
  const cacheDir = tempDir("omp-disk-debounce-");
  const dir = tempDir("omp-disk-src-");
  const file = tempFile(dir, "a.jsonl", `${userLine("hi", 1000)}\n`);
  try {
    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 0, maxBytes: 0, ompVersion: () => "v-test" });
    await eventsForSessionCache(fill(file, "sess-a", reader));
    const firstCount = readDisk(cacheDir, "sess-a").events.length;

    appendFileSync(file, `${userLine("again", 2000)}\n`);
    await ingestSessionFileGrowth(file, "sess-a", logger, reader);
    _flushDiskForTest();
    const afterCount = readDisk(cacheDir, "sess-a").events.length;
    assert.ok(afterCount > firstCount, "the debounced flush persisted the growth");
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});

test("boot sweep: atime-lazy sweep trims the disk dir to the entry cap", async () => {
  const cacheDir = tempDir("omp-disk-sweep-");
  try {
    const { mkdirSync, utimesSync } = await import("node:fs");
    mkdirSync(cacheDir, { recursive: true });
    // Pre-populate three files from a prior run, with increasing atimes so the
    // OLDEST (smallest atime) is swept first.
    const names = ["sess-old", "sess-mid", "sess-new"];
    for (let i = 0; i < names.length; i += 1) {
      const path = diskFile(cacheDir, names[i]);
      writeFileSync(path, JSON.stringify({ fingerprint: {}, events: [] }));
      utimesSync(path, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)));
    }

    _setCachePolicyForTest({ diskEnabled: true, diskDir: cacheDir, maxEntries: 1, maxBytes: 0, ompVersion: () => "v-test" });
    _sweepReplayCacheDirForTest();

    const files = readdirSync(cacheDir).filter((name) => name.endsWith(".json"));
    assert.equal(files.length, 1, "sweep trimmed the disk dir to the cap");
    assert.equal(files[0], "sess-new.json", "the newest-atime file survived");
  } finally {
    rmSync(cacheDir, { recursive: true, force: true });
    _setCachePolicyForTest(null);
    _clearSessionCacheForTest();
  }
});
