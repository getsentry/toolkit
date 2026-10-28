import { record, finite } from "../internal/wireValues.ts";
export const WEB_VITALS = {
  lcp: { label: "LCP", unit: "ms", good: 2500, poor: 4000 },
  inp: { label: "INP", unit: "ms", good: 200, poor: 500 },
  cls: { label: "CLS", unit: "", good: 0.1, poor: 0.25 },
  fcp: { label: "FCP", unit: "ms", good: 1800, poor: 3000 },
  ttfb: { label: "TTFB", unit: "ms", good: 800, poor: 1800 },
  fid: { label: "FID (legacy)", unit: "ms", good: 100, poor: 300 },
} as const;
export type VitalName = keyof typeof WEB_VITALS;
export type VitalMeasurement = {
  value: number;
  rating: "Good" | "Needs improvement" | "Poor";
};
export type VitalVisit = {
  eventId: string;
  metrics: Partial<Record<VitalName, VitalMeasurement>>;
};
export type VitalPage = { name: string; visits: VitalVisit[] };
export type WebVitalEvent = {
  id: string;
  transaction?: string;
  measurements?: unknown;
};
export function groupWebVitalPages(
  events: readonly WebVitalEvent[],
): VitalPage[] {
  const pages = new Map<string, VitalPage>();
  for (const event of events) {
    const measurements = record(event.measurements);
    if (!Object.keys(measurements).length) continue;
    const metrics: VitalVisit["metrics"] = {};
    for (const name of Object.keys(WEB_VITALS) as VitalName[]) {
      const metric = record(measurements[name]),
        value = finite(metric.value);
      if (value === undefined || value < 0) continue;
      const config = WEB_VITALS[name];
      // SDK measurements normally use milliseconds; honor seconds when explicitly supplied.
      const normalized =
        config.unit === "ms" && metric.unit === "second" ? value * 1000 : value;
      metrics[name] = {
        value: normalized,
        rating:
          normalized <= config.good
            ? "Good"
            : normalized <= config.poor
              ? "Needs improvement"
              : "Poor",
      };
    }
    if (!Object.keys(metrics).length) continue;
    const name = event.transaction ?? "Unknown page";
    const page = pages.get(name) ?? { name, visits: [] };
    page.visits.push({ eventId: event.id, metrics });
    pages.set(name, page);
  }
  return [...pages.values()].sort((a, b) => a.name.localeCompare(b.name));
}
