/**
 * Mobile responsiveness — client half entry (the first client surface of this
 * plugin). Mounts {@link setupMobileLayout}: CSS breakpoint override + the
 * document-level CAPTURE swipe gesture, both config-gated by the host half's
 * injected page global (`window.__OMP_WEB_MOBILE__`). The client half of a
 * dual-half plugin carries no loader config, so the page global IS the config
 * channel.
 *
 * The plugin shape mirrors the cordis client-plugin contract: an `inject`
 * declaration of required services plus an `apply(ctx)` that mounts the
 * feature. Only the `layout` service (the cross-plugin panel-action contract
 * provided by `@deepseek-ai/dsh-client-ui-layout`) is required — the feature
 * degrades to CSS-only when that peer is absent from the composition.
 *
 * @module omp-web/client
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { setupMobileLayout } from '../mobile/client/index.js'

/** Required services (cordis fiber inject): the panel-action face only. */
export const inject = ['layout']

/**
 * Mount the mobile feature. Inert unless the host's boot script opted the
 * page in via `window.__OMP_WEB_MOBILE__`.
 *
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  setupMobileLayout(ctx)
}
