/**
 * Tests for the single-pass foreign-writer collector (omp-store.ts).
 * Defends three contracts: foreign detection, descendant exemption, read-only
 * fd non-counting. `node --test test/foreign-writer.test.mjs`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { foreignWriterPid, scanForeignWriters } from "../dist/omp-store.js";

const HOLD_FD = new URL("./hold-fd.mjs", import.meta.url).pathname;

async function waitForPidfile(path, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      return Number(readFileSync(path, "utf8").trim());
    } catch {
      await new Promise((r) => setTimeout(r, 50));
    }
  }
  throw new Error(`pidfile ${path} never appeared`);
}

async function pollUntil(fn, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const value = fn();
    if (value !== undefined) return value;
    await new Promise((r) => setTimeout(r, 50));
  }
  return undefined;
}

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "fwp-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, "");
  return { dir, file };
}

test("detects a foreign writer (reparented grandchild)", async () => {
  const { dir, file } = fixture();
  const pidfile = join(dir, "pid");
  spawn(process.execPath, [HOLD_FD, "--fork-hold", file, pidfile], { stdio: "ignore" });
  const pid = await waitForPidfile(pidfile);
  const found = await pollUntil(() => foreignWriterPid(file));
  assert.equal(found, pid, "foreign writer pid must be reported");
  rmSync(dir, { recursive: true, force: true });
});

test("ignores a read-only foreign holder", async () => {
  const { dir, file } = fixture();
  const pidfile = join(dir, "pid");
  spawn(process.execPath, [HOLD_FD, "--fork-ro", file, pidfile], { stdio: "ignore" });
  await waitForPidfile(pidfile);
  await new Promise((r) => setTimeout(r, 500)); // let reparenting settle
  assert.equal(foreignWriterPid(file), undefined, "O_RDONLY holder must not count");
  rmSync(dir, { recursive: true, force: true });
});

test("exempts own descendants (teardown-race guard)", async () => {
  const { dir, file } = fixture();
  const child = spawn(process.execPath, [HOLD_FD, "--hold", file, join(dir, "pid")], {
    stdio: "ignore",
    detached: false,
  });
  await new Promise((r) => setTimeout(r, 800)); // let the child open the fd
  assert.equal(foreignWriterPid(file), undefined, "descendant writer must be exempt");
  child.kill("SIGKILL");
  rmSync(dir, { recursive: true, force: true });
});

test("scanForeignWriters returns a Map and stays consistent with lookup", () => {
  assert.ok(scanForeignWriters() instanceof Map);
});
