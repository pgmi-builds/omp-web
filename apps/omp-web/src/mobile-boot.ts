/**
 * Mobile page-config boot script (host half of the mobile feature). Delivered
 * as ONE inline `<head>` script through the webserver's public
 * `webserver/index-inject` event (every index render re-emits; row data is
 * read fresh at emit time).
 *
 * The script sets `window.__OMP_WEB_MOBILE__` — the dual-half plugin's client
 * half carries no loader config, so the page global IS the config channel —
 * then appends the iOS focus auto-zoom suppression section
 * ({@link buildZoomGuardSection}). Both legs ship default-ON; there is no
 * config schema (constants only), so a bare page still carries the mobile
 * global plus the zoom-guard section.
 *
 * Fail-open: an injection failure is logged and the host keeps booting — the
 * mobile feature is additive and must never block the web composition. A
 * composition without a `webServer` service leaves the feature dormant
 * (the `ctx.inject` callback never fires).
 *
 * @module omp-web/mobile-boot
 */
import type { Context } from '@deepseek-ai/cordis'
import { buildZoomGuardSection } from './mobile/zoom-guard.js'

/** The `webserver/index-inject` row shape this feature pushes. */
export interface BootScriptRow {
  kind: 'script'
  placement: 'head'
  text: string
}

// Local Events augmentation: the `webserver/index-inject` table row this
// feature contributes. (The full host type lives in
// `@deepseek-ai/dsh-host-webserver`, whose augmentation we do not import —
// a narrower local view is enough for a single `script` row push and keeps
// the host build free of that package.)
declare module '@deepseek-ai/cordis' {
  interface Events {
    'webserver/index-inject'(table: BootScriptRow[]): void
  }
}

/**
 * Build the boot script text. Pure: same constants in, same script out — the
 * unit tests pin the shape (mobile global present, zoom-guard section present,
 * wrapped in a non-throwing IIFE).
 *
 * @returns the script text.
 */
export function buildMobileBootScript(): string {
  const parts: string[] = ['(function(){try{']
  // Ship default ON: a bare page carries the mobile global (the client's
  // `resolveMobileConfig` merges the threshold defaults over `enabled: true`).
  parts.push(`window.__OMP_WEB_MOBILE__=${JSON.stringify({ enabled: true })};`)
  // The zoom guard rides the mobile leg (default 'meta' mode): emitted always.
  parts.push(buildZoomGuardSection())
  parts.push('}catch(e){}})();')
  return parts.join('')
}

/**
 * Mount the boot-script injection: one `webserver/index-inject` listener
 * pushing the rendered row. Conditional on the webServer service, so the
 * plugin loads (with the feature dormant) in compositions without one.
 * Fail-open: a push failure is logged, never thrown.
 *
 * @param ctx - host plugin context.
 */
export function installMobileBootScript(ctx: Context): void {
  ctx.inject(['webServer'], () => {
    ctx.on('webserver/index-inject', (table) => {
      try {
        table.push({ kind: 'script', placement: 'head', text: buildMobileBootScript() })
      } catch (error) {
        ctx.logger.warn(`omp-web: mobile boot script injection failed: ${String(error)}`)
      }
    })
  })
}
