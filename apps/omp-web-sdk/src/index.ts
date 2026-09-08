/**
 * @pgmi-builds/omp-web-sdk — SDK line of the OMP Web bridge.
 *
 * Status: sidecar skeleton. The dsh provider/adapter port (from apps/omp-web)
 * lands next; this entry currently exports the sidecar client for smoke tests.
 */
export { OmpSdkSidecar, type SidecarOptions } from "./sidecar-client.js";
export * from "./protocol.js";
