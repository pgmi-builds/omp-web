#!/usr/bin/env node
/**
 * Mobile swipe recognition (client half pure predicates) — minimal port of
 * dashr's `test/mobile-gesture.spec.ts`. The gesture thresholds and state
 * machine live in `src/mobile/gesture.ts` (compiled to `dist/mobile/gesture.js`);
 * this file pins the start-admission gate, the fire conditions, and the
 * page-config resolution over the renamed `__OMP_WEB_MOBILE__` channel.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DEFAULT_SWIPE_THRESHOLDS,
  admitsSwipeStart,
  classifySwipeProgress,
  resolveMobileConfig,
} from "../dist/mobile/gesture.js";

const BOTH_CLOSED = { leftCollapsed: true, rightOpen: false };
const LEFT_OPEN = { leftCollapsed: false, rightOpen: false };
const RIGHT_OPEN = { leftCollapsed: true, rightOpen: true };
const sweep = (overrides = {}) => ({ dx: 180, dy: 6, dtMs: 450, ...overrides });

test("start admission keeps the center band inert while both panels are closed", () => {
  assert.equal(admitsSwipeStart(100, 800, BOTH_CLOSED, DEFAULT_SWIPE_THRESHOLDS), true);
  assert.equal(admitsSwipeStart(121, 800, BOTH_CLOSED, DEFAULT_SWIPE_THRESHOLDS), false);
  assert.equal(admitsSwipeStart(200, 800, BOTH_CLOSED, DEFAULT_SWIPE_THRESHOLDS), true);
  // Any position once a panel is open (dismiss swipes start on the body).
  assert.equal(admitsSwipeStart(400, 800, LEFT_OPEN, DEFAULT_SWIPE_THRESHOLDS), true);
});

test("firing requires distance ∧ horizontal dominance ∧ the velocity gate", () => {
  assert.equal(classifySwipeProgress(sweep({ dx: 39 }), BOTH_CLOSED, true, DEFAULT_SWIPE_THRESHOLDS), null);
  assert.equal(classifySwipeProgress(sweep({ dx: 60, dy: 50 }), BOTH_CLOSED, true, DEFAULT_SWIPE_THRESHOLDS), null);
  assert.equal(classifySwipeProgress(sweep({ dtMs: 1800 }), BOTH_CLOSED, true, DEFAULT_SWIPE_THRESHOLDS), null);
  const disarmed = { ...DEFAULT_SWIPE_THRESHOLDS, swipeVelocityPxPerMs: 0 };
  assert.equal(classifySwipeProgress(sweep({ dtMs: 1800 }), BOTH_CLOSED, true, disarmed), "open-left");
});

test("state machine maps swipes to panel actions", () => {
  assert.equal(classifySwipeProgress(sweep(), BOTH_CLOSED, false, DEFAULT_SWIPE_THRESHOLDS), "open-left");
  assert.equal(classifySwipeProgress(sweep({ dx: -180 }), LEFT_OPEN, false, DEFAULT_SWIPE_THRESHOLDS), "close-left");
  assert.equal(classifySwipeProgress(sweep({ dx: -180 }), BOTH_CLOSED, true, DEFAULT_SWIPE_THRESHOLDS), "open-right");
  assert.equal(classifySwipeProgress(sweep(), RIGHT_OPEN, true, DEFAULT_SWIPE_THRESHOLDS), "close-right");
});


test("resolveMobileConfig is inert absent/disabled and merges defaults over enabled", () => {
  assert.equal(resolveMobileConfig(undefined).enabled, false);
  assert.equal(resolveMobileConfig({ enabled: false }).enabled, false);
  const on = resolveMobileConfig({ enabled: true });
  assert.equal(on.enabled, true);
  assert.equal(on.swipeVelocityPxPerMs, DEFAULT_SWIPE_THRESHOLDS.swipeVelocityPxPerMs);
});
