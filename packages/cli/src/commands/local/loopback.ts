/** Browser-safe hostname normalization and shared Local loopback policy. */
export function normalizeLocalHostname(host: string): string {
  return host.replace(/^\[|\]$/g, "").toLowerCase();
}

/** Whether a hostname identifies one of Local's supported loopback interfaces. */
export function isLoopbackHost(host: string): boolean {
  return ["localhost", "127.0.0.1", "::1"].includes(
    normalizeLocalHostname(host),
  );
}
