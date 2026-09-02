# omp-web

**`@pgmi-builds/omp-web`** — OMP provider for DeepSeek Harness ([dsh](https://www.npmjs.com/package/@deepseek-ai/dsh)).

Mounts OMP ([oh-my-pi](https://omp.ai)) as a dsh agent backend: an `AgentFactory` on `ctx.agents` spawns `omp --mode rpc` and bridges OMP's RPC surface (prompt / follow_up / steer / abort / get_state / get_messages / set_model / resume) into Dash Agent/Session contracts, so the standard DSH Web UI drives OMP sessions. Model selection is served by an OMP-backed `LlmAdapter` tracking OMP's `config.yml` (`modelRoles`).

## Install

```bash
dsh plugin --profile omp-web add @pgmi-builds/omp-web
```

The bundle patch ships inside the package — mounting the provider and disabling the native components OMP replaces (agent-loop, native llm routes) needs zero profile file edits. Profile-specific values (`webserver.port`, `settings.path`) belong to your profile's `cordis.patch.yml`.

## Repository layout

- `apps/omp-web/` — the npm package (`dist` via plain `tsc`; `@deepseek-ai/*` harness deps are optional peers supplied by the dsh host; vendored `types/` keeps typecheck portable)
- `openspec/` — change records and specs (driven via the `opsx-*` OMP commands in `.omp/`)
- `docs/` — design plans (as-built notes) and runtime probe/smoke scripts
- `archived/` — deprecated apps, kept on disk for reference (untracked)

## Develop

```bash
cd apps/omp-web
npm run build          # tsc → dist
node --test test/*.test.mjs   # node:test suites (import ../dist)
```

Run a live instance from the harness sources under `./upstream/dsh` (tag `dsh-v0.1.2-alpha.3`) on port 4999 with the `omp-web-test` profile — see `AGENTS.md` for the full topology and dev/test contract.

## License

MIT
