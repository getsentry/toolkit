import type { MetricMonitor } from "./api/detectors.js";

export function monitorObject(
  value: unknown,
): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Source-exact GET envelope. Write dataSources contain flat SnubaQuery fields. */
export function monitorQuery(
  monitor: MetricMonitor,
): Record<string, unknown> | undefined {
  if (monitor.dataSources?.length !== 1) return;
  const source = monitorObject(monitor.dataSources[0]);
  return monitorObject(monitorObject(source?.queryObj)?.snubaQuery);
}
