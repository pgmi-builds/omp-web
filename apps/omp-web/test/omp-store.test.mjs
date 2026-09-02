#!/usr/bin/env node
/**
 * lastRestorableModel — the resume model must exclude fallback switches
 * (`role:"fallback"`, EPHEMERAL), mirroring OMP's getRestorableSessionModels.
 * The T1/T2/T4 cases replay the real incident transcripts from
 * docs/plans/omp-model-fallback-mechanism.md.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

const { lastRestorableModel } = await import("../dist/omp-store.js");

test("T1: fallback-only tail falls back to the primary (kimi)", () => {
  const r = lastRestorableModel([
    { model: "kimi-plan/kimi-k3" },
    { model: "deepseek/deepseek-v4-pro", role: "fallback" },
  ]);
  assert.deepEqual(r, { provider: "kimi-plan", model: "kimi-k3" });
});

test("T2: set_model then fallback falls back to the primary (kimi)", () => {
  const r = lastRestorableModel([
    { model: "kimi-plan/kimi-k3" },
    { model: "kimi-plan/kimi-k3", role: "default" },
    { model: "deepseek/deepseek-v4-pro", role: "fallback" },
  ]);
  assert.deepEqual(r, { provider: "kimi-plan", model: "kimi-k3" });
});

test("T4: set_model to default restores that default (kimi, not glm)", () => {
  const r = lastRestorableModel([
    { model: "zai/glm-4.7" },
    { model: "kimi-plan/kimi-k3", role: "default" },
  ]);
  assert.deepEqual(r, { provider: "kimi-plan", model: "kimi-k3" });
});

test("empty change list → undefined", () => {
  assert.equal(lastRestorableModel([]), undefined);
});

test("non-default last role wins over default", () => {
  const r = lastRestorableModel([
    { model: "kimi-plan/kimi-k3" },
    { model: "deepseek/deepseek-v4-pro", role: "plan" },
  ]);
  assert.deepEqual(r, { provider: "deepseek", model: "deepseek-v4-pro" });
});

test("variant suffix is dropped from the selector", () => {
  const r = lastRestorableModel([{ model: "kimi-plan/kimi-k3:high", role: "default" }]);
  assert.deepEqual(r, { provider: "kimi-plan", model: "kimi-k3" });
});
