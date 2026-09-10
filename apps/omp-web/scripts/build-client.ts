/**
 * Client bundle build: emits the closure-factory CJS artifact the dsh web
 * loader consumes — `window.__ModuleLoader__.load({ id: '@pgmi-builds/omp-web',
 * factory: (require) => { … return module.exports; } })`. Externals resolve
 * through the loader module table (platform seed entries); everything else
 * inlines.
 *
 * Build tool: `tsdown` (rolldown) — the same tool the dsh host itself uses for
 * its client bundles, run via `tsx`. `lib/client/index.js` is a build artifact
 * (gitignored like the rest of `lib/`); the matching `lib/client/index.d.ts` is
 * emitted by `tsc` (`emitDeclarationOnly`) from `src/client/index.ts`.
 *
 * The mobile client half imports no `@deepseek-ai/*` value (only the type-only
 * `@deepseek-ai/cordis` `Context`), so the emitted bundle has zero module-table
 * requests — the frozen CLIENT_EXTERNALS table still gates the inlining path
 * (mirroring the dsh `dsh-client-bundle-purity` plugin): a stray value import
 * of a non-external `@deepseek-ai/*` module throws at resolution time.
 *
 * @module omp-web/scripts/build-client
 */
import { build } from 'tsdown'
import { join } from 'node:path'
import { existsSync, readFileSync } from 'node:fs'

const ID = '@pgmi-builds/omp-web'
const ENTRY = 'src/client/index.ts'
const OUT_DIR = 'lib/client'
const OUT_FILE = 'index.js'

/**
 * Frozen loader module table (dsh mechanism-guide): the platform seed entries
 * the shell shares into the module table (`web/src/platform.ts`). The mobile
 * client requests none of them, but the table must stay frozen so a future
 * value import of any of these stays external rather than silently inlining a
 * duplicate runtime instance.
 */
export const CLIENT_EXTERNALS: readonly string[] = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-store',
]

await build({
  // `config: false` — run this config standalone, never merge a root
  // tsdown.config.ts (there is none here; the host half is pure tsc).
  config: false,
  name: `${ID}/client`,
  entry: { index: ENTRY },
  outDir: OUT_DIR,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  dts: false,
  clean: false,
  // `external` pins the loader-table entries; `noExternal` forces every
  // non-table module to inline — the browser loader cannot answer a require()
  // it does not know.
  external: [...CLIENT_EXTERNALS],
  noExternal: (id: string) => !CLIENT_EXTERNALS.includes(id),
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
  },
  outputOptions: {
    entryFileNames: OUT_FILE,
    // Closure-factory handoff (mirror of the dsh tsdown recipe): `intro`
    // lands inside the factory body (after `banner`) and declares
    // `module`/`exports` because the bundler's cjs emission assigns
    // module.exports itself; the factory returns that surface to the loader.
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
  plugins: [
    {
      // Bundle purity gate (mirror of the host's `dsh-client-bundle-purity`
      // plugin): a value import of any `@deepseek-ai/*` module outside
      // CLIENT_EXTERNALS throws at resolution time. Type-only imports are
      // erased before the module graph is built, so reaching this hook means a
      // real value import — which must not be inlined into the
      // browser-loadable artifact.
      name: 'dsh-client-bundle-purity',
      resolveId(source: string) {
        if (source.startsWith('@deepseek-ai/') && !CLIENT_EXTERNALS.includes(source)) {
          throw new Error(
            `client bundle purity: value import of ${source} is not in CLIENT_EXTERNALS — type-only peers must stay type-only (use \`import type\`)`,
          )
        }
        return null
      },
    },
  ],
})

const outFile = join(OUT_DIR, OUT_FILE)
if (!existsSync(outFile)) {
  throw new Error(`client bundle build: expected ${outFile} — check the tsdown config (entry/entryFileNames/outDir)`)
}

// Inline bundle-contract assertions: the emitted text must carry the
// closure-factory handoff, must NOT contain `import.meta` / ESM statements
// (the classic-script loader would fail to parse them), and every
// `@deepseek-ai/*` reference in the emitted text must be a documented
// CLIENT_EXTERNALS entry.
const bundleText = readFileSync(outFile, 'utf8')
if (!bundleText.includes('__ModuleLoader__')) {
  throw new Error('client bundle contract: missing window.__ModuleLoader__.load handoff — check the tsdown config (banner/footer)')
}
if (bundleText.includes('import.meta') || /(^|\n)\s*(import|export)\s/.test(bundleText)) {
  throw new Error('client bundle contract: emitted bundle contains import.meta / ESM statements — the classic-script loader would fail to parse it')
}
const deepseekTokens = [...bundleText.matchAll(/@deepseek-ai\/[\w./-]+/g)].map((match) => match[0])
const unexpected = deepseekTokens.filter((specifier) => !CLIENT_EXTERNALS.includes(specifier))
if (unexpected.length > 0) {
  throw new Error(`client bundle contract: non-external @deepseek-ai/* reference(s) survived in the emitted bundle: ${unexpected.join(', ')}`)
}

console.log(`build-client: ${ENTRY} -> ${outFile} (closure-factory CJS, tsdown)`)
