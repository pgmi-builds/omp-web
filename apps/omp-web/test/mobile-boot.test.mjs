#!/usr/bin/env node
/**
 * Mobile boot script + zoom-guard pure functions (host half, omp-web).
 * Minimal port of dashr's `test/zoom-guard.spec.ts` + `test/web-trust.spec.ts`
 * pure-function tiers, retargeted at the renamed page global
 * (`window.__OMP_WEB_MOBILE__`) and plugin identity (`omp-web`).
 *
 * No DOM stub here: the strongest tier (running the real script against a
 * stub DOM) belongs to the dashr checkout's heavier suite; this file pins the
 * decision surface and the generated-script shape.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ZOOM_GUARD_TOKENS,
  isIOSClassUA,
  mergeViewportTokens,
  shouldApplyZoomGuard,
  isStandaloneDisplay,
  buildFontFloorCss,
  buildZoomGuardSection,
} from "../dist/mobile/zoom-guard.js";
import { buildMobileBootScript } from "../dist/mobile-boot.js";

const IPHONE_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 17_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Mobile/15E148 Safari/604.1";
const MAC_DESKTOP_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Safari/605.1.15";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Mobile Safari/537.36";
const STOCK = "width=device-width, initial-scale=1";
const STOCK_GUARDED = "width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no";

test("isIOSClassUA gates on the iOS family (incl. iPadOS desktop masquerade)", () => {
  assert.equal(isIOSClassUA(IPHONE_UA, 5), true);
  assert.equal(isIOSClassUA(MAC_DESKTOP_UA, 5), true); // multi-touch digitizer
  assert.equal(isIOSClassUA(MAC_DESKTOP_UA, 0), false); // real desktop Safari
  assert.equal(isIOSClassUA(ANDROID_UA, 5), false);
  assert.equal(isIOSClassUA("", 0), false);
});

test("mergeViewportTokens appends/overrides idempotently", () => {
  assert.equal(mergeViewportTokens(STOCK, ZOOM_GUARD_TOKENS), STOCK_GUARDED);
  assert.equal(
    mergeViewportTokens("width=device-width, maximum-scale=5", ZOOM_GUARD_TOKENS),
    "width=device-width, maximum-scale=1, user-scalable=no",
  );
  const once = mergeViewportTokens(STOCK, ZOOM_GUARD_TOKENS);
  assert.equal(mergeViewportTokens(once, ZOOM_GUARD_TOKENS), once);
});

test("shouldApplyZoomGuard double-gates iOS ∧ narrow ∧ non-off", () => {
  assert.equal(shouldApplyZoomGuard(undefined, true, true), true);
  assert.equal(shouldApplyZoomGuard({ zoomGuard: "off" }, true, true), false);
  assert.equal(shouldApplyZoomGuard(undefined, false, true), false);
  assert.equal(shouldApplyZoomGuard(undefined, true, false), false);
});

test("isStandaloneDisplay strict-true ORs both sources", () => {
  assert.equal(isStandaloneDisplay(true, false), true);
  assert.equal(isStandaloneDisplay(false, true), true);
  assert.equal(isStandaloneDisplay(false, false), false);
  assert.equal(isStandaloneDisplay(undefined, undefined), false);
});

test("buildFontFloorCss derives the 768 breakpoint band byte-exact", () => {
  assert.equal(
    buildFontFloorCss(768),
    "@media (max-width:767.98px){ input,textarea,select,[contenteditable=\"true\"]{ font-size:16px !important } }",
  );
});

test("buildZoomGuardSection embeds predicates as ES5 and carries the renamed identity", () => {
  const text = buildZoomGuardSection();
  for (const fragment of ["var ZI=", "var ZM=", "var ZS=", "var ZD=", "var ZF="]) {
    assert.ok(text.includes(fragment), `missing ${fragment}`);
  }
  assert.ok(text.includes("window.__OMP_WEB_MOBILE__"), "reads the renamed page global");
  assert.ok(text.includes("omp-web/zoom-font-floor"), "carries the plugin-owned css tag id");
  assert.ok(text.includes("omp-web"), "carries the plugin identity");
  assert.ok(!text.includes("__DASHR_MOBILE__"), "no residual dashr global");
  assert.ok(!text.includes("=>"), "ES5: no arrow functions");
  assert.ok(!text.includes("`"), "ES5: no template literals");
});

test("buildMobileBootScript ships the default-ON global plus the zoom guard in a non-throwing IIFE", () => {
  const text = buildMobileBootScript();
  assert.ok(text.includes('window.__OMP_WEB_MOBILE__={"enabled":true};'));
  assert.ok(text.includes("var ZI="), "zoom-guard section present");
  assert.ok(text.startsWith("(function(){try{"));
  assert.ok(text.endsWith("}catch(e){}})();"));

  // End-to-end: evaluate the real script text; a non-iOS UA returns the
  // zoom-guard IIFE before it touches document/matchMedia, leaving only the
  // page global behind.
  const window = {};
  // eslint-disable-next-line no-new-func
  const fn = new Function("window", "navigator", text);
  fn(window, { userAgent: ANDROID_UA, maxTouchPoints: 5 });
  assert.deepEqual(window.__OMP_WEB_MOBILE__, { enabled: true });
});
