/** Browser-safe hostname normalization and shared Local loopback policy. */
export function normalizeLocalHostname(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Hostnames of Local's supported loopback interfaces. */
export const LOOPBACK_HOSTS = ["localhost", "127.0.0.1", "::1"];

/** Whether a hostname identifies one of Local's supported loopback interfaces. */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK_HOSTS.includes(normalizeLocalHostname(host));
}
