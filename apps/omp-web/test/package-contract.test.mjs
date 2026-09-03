#!/usr/bin/env node
/**
 * Package & deployment contract guards — codifies the repeatable subset of the
 * archived `package-distribution` change (its tasks shipped with v0.1.2 but
 * were never checked off): package identity & shipping surface (1.1/1.2),
 * optional peers (4.1), bundle-patch self-containment (2.1/2.3), and
 * portable paths (3.1/3.2) — no absolute-path leakage in src/, env-driven
 * bridge-DB resolution with its relative-path and OMP-store guards.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

const pkgRoot = fileURLToPath(new URL("..", import.meta.url));
const pkg = JSON.parse(readFileSync(join(pkgRoot, "package.json"), "utf8"));

test("package identity and shipping surface", () => {
  assert.equal(pkg.name, "@pgmi-builds/omp-web");
  assert.equal(pkg.main, "dist/index.js");
  assert.equal(pkg.exports["."], "./dist/index.js");
  assert.deepEqual(pkg.files, ["dist", "cordis.patch.yml"]); // tarball = dist + patch + package.json + README
  assert.equal(pkg.dsh?.bundle?.patch, "./cordis.patch.yml");
  // registry distribution: zero runtime dependencies — harness deps come from the host
  assert.ok(pkg.dependencies === undefined || Object.keys(pkg.dependencies).length === 0);
});

test("all peerDependencies are optional (host-supplied, never installed into the profile tree)", () => {
  const peers = Object.keys(pkg.peerDependencies ?? {});
  assert.ok(peers.length >= 8, "expected the @deepseek-ai harness peer set");
  for (const p of peers) {
    assert.equal(pkg.peerDependenciesMeta?.[p]?.optional, true, `${p} must be optional`);
  }
});

test("bundle patch is self-contained: mounts omp-provider, disables replaced natives, keeps the 3-preset table", () => {
  const raw = readFileSync(join(pkgRoot, "cordis.patch.yml"), "utf8");
  const body = raw
    .split("\n")
    .filter((l) => !/^\s*#/.test(l))
    .join("\n");
  // mount + identity
  assert.match(body, /id:\s*omp-provider/);
  assert.match(body, /name:\s*['"]@pgmi-builds\/omp-web['"]/);
  // disable the natives OMP replaces
  for (const id of ["agent-loop", "llm-deepseek", "llm-pi-ai", "agent-presets", "session-persistence-jsonl"]) {
    assert.match(body, new RegExp(`id:\\s*${id.replace(/-/g, "-")}`), `missing disable row: ${id}`);
  }
  assert.equal((body.match(/disabled:\s*true/g) ?? []).length, 5);
  // permission row restates the full 3-preset table (partial row silently drops presets)
  for (const preset of ["read-only:", "workspace-write:", "danger-full-access:"]) {
    assert.ok(body.includes(preset), `missing preset ${preset}`);
  }
  assert.match(body, /defaultPreset:\s*danger-full-access/);
  // profile-specific values must live in the profile patch layer, never here
  for (const banned of ["webserver", "settings", "agent-default-model"]) {
    assert.ok(!body.includes(banned), `bundle patch must not carry profile-specific key: ${banned}`);
  }
});

test("src/ carries no absolute-path or machine-specific leakage (portable paths)", () => {
  const srcDir = join(pkgRoot, "src");
  const files = readdirSync(srcDir, { recursive: true }).filter((f) => String(f).endsWith(".ts"));
  assert.ok(files.length > 0, "src tree unexpectedly empty");
  for (const f of files) {
    const text = readFileSync(join(srcDir, String(f)), "utf8");
    for (const banned of ["/home/", "workspaces/dsh-omp", ".pc.randomhash.app"]) {
      assert.ok(!text.includes(banned), `${f} leaks machine-specific path: ${banned}`);
    }
  }
});

// --- env-driven bridge-DB resolution (behavioral) -------------------------------
// OMP_SESSIONS_ROOT is import-time; set fixtures before the dynamic import.
const SESSIONS_ROOT = "/tmp/omp-contract-sessions-root-fixture";
const DSH_HOME_FIX = "/tmp/omp-contract-dsh-home-fixture";
process.env.OMP_SESSIONS_ROOT = SESSIONS_ROOT;
process.env.DSH_HOME = DSH_HOME_FIX;
const { resolveBridgeDbPath } = await import("../dist/store/index.js");

const withEnv = (kv, fn) => {
  const saved = Object.fromEntries(Object.keys(kv).map((k) => [k, process.env[k]]));
  Object.assign(process.env, kv);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

test("OMP_BRIDGE_DB must be absolute — relative is rejected", () => {
  withEnv({ OMP_BRIDGE_DB: "relative/bridge.sqlite" }, () => {
    assert.throws(() => resolveBridgeDbPath(), /OMP_BRIDGE_DB must be an absolute path/);
  });
});

test("bridge DB under OMP_SESSIONS_ROOT is rejected (OMP would scan it as a foreign session)", () => {
  withEnv({ OMP_BRIDGE_DB: join(SESSIONS_ROOT, "bridge.sqlite") }, () => {
    assert.throws(() => resolveBridgeDbPath(), /must not live under OMP_SESSIONS_ROOT/);
  });
});

test("default path anchors at $DSH_HOME/bridge-store.sqlite", () => {
  withEnv({ OMP_BRIDGE_DB: "" }, () => {
    assert.equal(resolveBridgeDbPath(), join(DSH_HOME_FIX, "bridge-store.sqlite"));
  });
});

test("absolute OMP_BRIDGE_DB outside the OMP store is honored", () => {
  withEnv({ OMP_BRIDGE_DB: "/tmp/elsewhere/bridge.sqlite" }, () => {
    assert.equal(resolveBridgeDbPath(), resolve("/tmp/elsewhere/bridge.sqlite"));
  });
});
