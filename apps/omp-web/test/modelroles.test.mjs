#!/usr/bin/env node
/**
 * modelRoles get/set roundtrip over the bun sidecar + the omp-cli.ts surface.
 *
 * Both tests redirect the sidecar's agent dir to a scratch home via
 * PI_CODING_AGENT_DIR / PI_CONFIG_DIR (the env the SDK's `getAgentDir()` reads —
 * NOT OMP_HOME), so the whole-object write never touches the operator's real
 * ~/.omp/agent/config.yml.
 *
 * The "echo" assertion is the loop-protection regression guard: the shadow-key
 * sync in OmpProvider.#syncModelDefaultTick depends on (a) a fresh read after a
 * write returning the written value (so the echo is detected as a no-op) and
 * (b) the write returning `true` only when it durably landed (so the shadow key
 * only advances on a real write).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OmpSdkSidecar } from "../dist/sidecar-client.js";
import { ompModelRoles, ompSetModelRoles } from "../dist/omp-cli.js";

function scratchHome(seed) {
  const home = mkdtempSync(join(tmpdir(), "omp-sdk-mr-"));
  const agentDir = join(home, "agent");
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(join(agentDir, "config.yml"), seed);
  return { home, agentDir };
}

test("sidecar modelRoles get/set roundtrip (atomic whole-object write)", async (t) => {
  const { home, agentDir } = scratchHome("modelRoles:\n  default: deepseek/deepseek-v4-pro\n  plan: zai-plan/glm-4.7\n");

  const sidecar = new OmpSdkSidecar({ env: { PI_CONFIG_DIR: home, PI_CODING_AGENT_DIR: agentDir } });
  t.after(async () => {
    await sidecar.stop();
    rmSync(home, { recursive: true, force: true });
  });

  const ready = await sidecar.start();
  assert.equal(ready.protocol, 0);

  // get: seed roles roundtrip from config.yml
  const seeded = await sidecar.call("settings.modelRoles.get");
  assert.deepEqual(seeded.modelRoles, {
    default: "deepseek/deepseek-v4-pro",
    plan: "zai-plan/glm-4.7",
  });

  // set: whole-object replace — drop `plan`, add `codeReview`, change default
  const wrote = await sidecar.call("settings.modelRoles.set", {
    modelRoles: { default: "deepseek/deepseek-v4-flash", codeReview: "deepseek/deepseek-v4-pro" },
  });
  assert.equal(wrote.ok, true);

  // echo: a fresh get reflects the write (the property that breaks the shadow-key loop)
  const echoed = await sidecar.call("settings.modelRoles.get");
  assert.deepEqual(echoed.modelRoles, {
    default: "deepseek/deepseek-v4-flash",
    codeReview: "deepseek/deepseek-v4-pro",
  });

  // on-disk: the whole object was replaced atomically (plan gone, codeReview present)
  const onDisk = readFileSync(join(agentDir, "config.yml"), "utf8");
  assert.match(onDisk, /default: deepseek\/deepseek-v4-flash/);
  assert.doesNotMatch(onDisk, /plan: zai-plan\/glm-4.7/);

  // a non-record must be rejected loudly (guards the whole-object contract)
  await assert.rejects(() => sidecar.call("settings.modelRoles.set", { modelRoles: ["not", "a", "record"] }));
});

test("omp-cli modelRoles roundtrip + echo preserves the loop-protection invariant", async (t) => {
  const { home, agentDir } = scratchHome("modelRoles:\n  default: deepseek/deepseek-v4-pro\n");

  const prevConfigDir = process.env.PI_CONFIG_DIR;
  const prevAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CONFIG_DIR = home;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  t.after(() => {
    if (prevConfigDir === undefined) delete process.env.PI_CONFIG_DIR;
    else process.env.PI_CONFIG_DIR = prevConfigDir;
    if (prevAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    rmSync(home, { recursive: true, force: true });
  });

  // Boot-time read goes through the shared sidecar singleton (callShared).
  const seeded = await ompModelRoles();
  assert.deepEqual(seeded, { default: "deepseek/deepseek-v4-pro" });

  // DSH side moves: push a new default into OMP (whole-object write).
  const ok = await ompSetModelRoles({ default: "deepseek/deepseek-v4-flash" });
  assert.equal(ok, true);

  // Echo: the next fresh read returns the written value. This is exactly what
  // makes OmpProvider.#syncModelDefaultTick a no-op on the following tick —
  // OMP's `default` now matches the shadow key it just advanced, so neither the
  // "OMP moved" nor the "DSH moved" branch fires.
  const echoed = await ompModelRoles();
  assert.deepEqual(echoed, { default: "deepseek/deepseek-v4-flash" });
});
