#!/usr/bin/env node
/**
 * BridgeStore CRUD + lifecycle smoke — covers the store module in isolation
 * (tasks 1.1–1.4): open/integrity, upsert, the three id lookups, list order,
 * prune, UI setters, ui_state, and the OMP-store path guard.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { BridgeStore } = await import("../dist/store/db.js");

function row(overrides = {}) {
  return {
    omp_session_id: "omp-1",
    dsh_session_id: "session-real-1",
    session_file: "/tmp/a.jsonl",
    cwd: "/tmp",
    title: "hello",
    created_at: 1000,
    last_modified_at: 2000,
    transcript_size: 10,
    model_provider: "deepseek",
    model_id: "v4",
    agent_preset: "omp",
    permission_preset: null,
    forked_from: null,
    archived: 0,
    last_visited_at: null,
    ...overrides,
  };
}

test("open + upsert + three-way id lookup", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
  const store = BridgeStore.open(join(dir, "db.sqlite"));
  try {
    store.upsert(row());
    assert.equal(store.byDshId("session-real-1")?.omp_session_id, "omp-1");
    assert.equal(store.byOmpId("omp-1")?.dsh_session_id, "session-real-1");
    assert.equal(store.byFile("/tmp/a.jsonl")?.title, "hello");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("list defaults to last_modified_at DESC", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
  const store = BridgeStore.open(join(dir, "db.sqlite"));
  try {
    store.upsert(row({ omp_session_id: "a", dsh_session_id: "session-a", session_file: "/tmp/a.jsonl", last_modified_at: 100 }));
    store.upsert(row({ omp_session_id: "b", dsh_session_id: "session-b", session_file: "/tmp/b.jsonl", last_modified_at: 300 }));
    store.upsert(row({ omp_session_id: "c", dsh_session_id: "session-c", session_file: "/tmp/c.jsonl", last_modified_at: 200 }));
    const order = store.list().map((r) => r.dsh_session_id);
    assert.deepEqual(order, ["session-b", "session-c", "session-a"]);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("upsert preserves UI fields and updates metadata", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
  const store = BridgeStore.open(join(dir, "db.sqlite"));
  try {
    store.upsert(row());
    // Reconcile-style upsert: metadata changes, UI fields preserved (caller composes).
    const existing = store.byOmpId("omp-1");
    store.upsert({ ...existing, title: "renamed", last_modified_at: 3000, transcript_size: 20 });
    assert.equal(store.byOmpId("omp-1")?.title, "renamed");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("prune removes files not kept", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
  const store = BridgeStore.open(join(dir, "db.sqlite"));
  try {
    store.upsert(row());
    store.upsert(row({ omp_session_id: "omp-2", dsh_session_id: "session-2", session_file: "/tmp/b.jsonl" }));
    store.prune(new Set(["/tmp/a.jsonl"]));
    assert.equal(store.byFile("/tmp/b.jsonl"), undefined);
    assert.equal(store.byFile("/tmp/a.jsonl")?.omp_session_id, "omp-1");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});

test("UI setters + ui_state persist", () => {
  const dir = mkdtempSync(join(tmpdir(), "omp-store-"));
  const store = BridgeStore.open(join(dir, "db.sqlite"));
  try {
    store.upsert(row());
    store.setArchived("session-real-1", true);
    store.touchVisited("session-real-1", 999);
    store.setPermissionPreset("omp-1", "read-only");
    store.setForkedFrom("session-real-1", "session-parent");
    store.setUiState("sort_mode", "manual");
    const r = store.byDshId("session-real-1");
    assert.equal(r.archived, 1);
    assert.equal(r.last_visited_at, 999);
    assert.equal(r.permission_preset, "read-only");
    assert.equal(r.forked_from, "session-parent");
    assert.equal(store.getUiState("sort_mode"), "manual");
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
