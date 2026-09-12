#!/usr/bin/env node
/**
 * SessionCacheEntry unification (T8–T10) — the single per-file cache that
 * merged `transcriptSdkCache` + `logCache` into one L1/L2 staged store behind a
 * single-flight fill. Covers the three P2 acceptance behaviors in-sandbox
 * (temp dirs only, no `~/.omp`):
 *
 *   1. single-flight dedupe — concurrent fills of the SAME file parse once,
 *   2. invalidation refill — a (size, mtime) change re-reads and refills,
 *   3. validate-failure fail-soft — a malformed replay degrades to [] + warn.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { eventsForSessionCache } from "../dist/session-persistence-omp.js";
import { readOmpTranscript } from "../dist/omp-store.js";
import { SESSION_FORMAT_VERSION, SessionId } from "@deepseek-ai/dsh-session";

function header(id = "session-cache-test") {
  return {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    isSeeded: false,
    agentPreset: "omp",
  };
}

/** One valid OMP transcript line (a user turn). */
function userLine(text, ts) {
  return JSON.stringify({ type: "message", message: { role: "user", timestamp: ts, content: [{ type: "text", text }] } });
}

function tempFile(name, contents) {
  const dir = mkdtempSync(join(tmpdir(), "omp-session-cache-"));
  const file = join(dir, name);
  writeFileSync(file, contents);
  return { dir, file };
}

test("single-flight: concurrent fills of the same file parse once and share one array", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n`);
  try {
    let reads = 0;
    const reader = async (f) => {
      reads += 1;
      return readOmpTranscript(f);
    };
    const make = () => ({
      file,
      preset: null,
      createdAt: 0,
      header: header(),
      logger: { warn: () => {} },
      readTranscript: reader,
    });

    const [a, b] = await Promise.all([eventsForSessionCache(make()), eventsForSessionCache(make())]);

    assert.equal(reads, 1, "one parse for two concurrent fills");
    assert.equal(a, b, "both callers share the same (frozen) events array");
    assert.ok(a.length > 0, "replayed a real transcript");

    // A later sequential call hits the cache without re-reading.
    const c = await eventsForSessionCache(make());
    assert.equal(reads, 1, "cache hit performs no additional parse");
    assert.equal(c, a);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("invalidation: a (size, mtime) change re-reads and refills the entry", async () => {
  const { dir, file } = tempFile("a.jsonl", `${userLine("hi", 1000)}\n`);
  try {
    let reads = 0;
    const reader = async (f) => {
      reads += 1;
      return readOmpTranscript(f);
    };
    const make = () => ({
      file,
      preset: null,
      createdAt: 0,
      header: header(),
      logger: { warn: () => {} },
      readTranscript: reader,
    });

    const first = await eventsForSessionCache(make());
    assert.equal(reads, 1);

    // Grow the file (new size AND mtime) → the entry is stale → refill.
    writeFileSync(file, `${userLine("hi", 1000)}\n${userLine("again", 2000)}\n`);
    const second = await eventsForSessionCache(make());

    assert.equal(reads, 2, "file growth triggered a re-read");
    assert.notEqual(second, first, "refill produces a fresh array");
    assert.ok(second.length > first.length, "refill reflects the appended turn");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("validate-failure: a malformed replay degrades to [] and warns (fail-soft preserved)", async () => {
  const { dir, file } = tempFile("bad.jsonl", "");
  try {
    const warns = [];
    // A toolResult message with no toolCallId replays to a tool/result whose
    // source.callId is "" — validateStoredEvents refuses it.
    const reader = async () => ({ messages: [{ role: "toolResult", content: [] }], modelChanges: [] });
    const events = await eventsForSessionCache({
      file,
      preset: null,
      createdAt: 0,
      header: header(),
      logger: { warn: (msg) => warns.push(msg) },
      readTranscript: reader,
    });

    assert.deepEqual(events, [], "serves an empty log on validation failure");
    assert.equal(warns.length, 1, "exactly one logger.warn");
    assert.match(warns[0], /failed storage validation/, "warn names the validation failure");

    // The empty result is cached: a repeat call does not re-read (fail-soft held).
    let reads = 0;
    const counting = async () => {
      reads += 1;
      return { messages: [{ role: "toolResult", content: [] }], modelChanges: [] };
    };
    const again = await eventsForSessionCache({
      file,
      preset: null,
      createdAt: 0,
      header: header(),
      logger: { warn: () => {} },
      readTranscript: counting,
    });
    assert.equal(reads, 0, "cached empty log is served without a re-read");
    assert.deepEqual(again, []);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("single-flight map is keyed by file: distinct files fill independently", async () => {
  const { dir, file: fileA } = tempFile("a.jsonl", `${userLine("a", 1000)}\n`);
  const fileB = join(dir, "b.jsonl");
  writeFileSync(fileB, `${userLine("b", 1000)}\n`);
  try {
    let reads = 0;
    const reader = async (f) => {
      reads += 1;
      return readOmpTranscript(f);
    };
    const make = (file) => ({
      file,
      preset: null,
      createdAt: 0,
      header: header(),
      logger: { warn: () => {} },
      readTranscript: reader,
    });

    const [a, b] = await Promise.all([eventsForSessionCache(make(fileA)), eventsForSessionCache(make(fileB))]);
    assert.equal(reads, 2, "two different files each parse once (no cross-file dedupe)");
    assert.notEqual(a, b);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
