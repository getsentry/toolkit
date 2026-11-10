import { z } from "zod";
import type { UptimeMonitor } from "../../../api-client/types";
import { formatActor } from "./api-formatting";

/** Verified against UptimeSubscription.IntervalSeconds in getsentry/sentry. */
export const UPTIME_INTERVAL_SECONDS = [
  60, 300, 600, 1200, 1800, 3600,
] as const;

/** Verified against UptimeSubscription.SupportedHTTPMethods in getsentry/sentry. */
export const UPTIME_HTTP_METHODS = [
  "GET",
  "POST",
  "HEAD",
  "PUT",
  "DELETE",
  "PATCH",
  "OPTIONS",
] as const;

export const UPTIME_MONITOR_STATUSES = ["active", "disabled"] as const;

export const ParamUptimeIntervalSeconds = z
  .number()
  .int()
  .refine(
    (value): value is (typeof UPTIME_INTERVAL_SECONDS)[number] =>
      (UPTIME_INTERVAL_SECONDS as readonly number[]).includes(value),
    {
      message: `intervalSeconds must be one of: ${UPTIME_INTERVAL_SECONDS.join(", ")}`,
    },
  )
  .describe(
    "Seconds between checks. Allowed values: 60, 300, 600, 1200, 1800, 3600.",
  );

export const ParamUptimeHttpMethod = z
  .enum(UPTIME_HTTP_METHODS)
  .describe("HTTP method used for the uptime check request.");

export const ParamUptimeMonitorStatus = z
  .enum(UPTIME_MONITOR_STATUSES)
  .describe(
    "Monitor status. `disabled` stops checks and does not count against quota.",
  );

export const ParamUptimeTimeoutMs = z
  .number()
  .int()
  .min(1000)
  .max(60_000)
  .describe("Request timeout in milliseconds (1000-60000).");

/**
 * Header pairs, matching HEADERS_LIST_SCHEMA in getsentry/sentry
 * (src/sentry/uptime/endpoints/validators.py).
 *
 * Not `z.tuple`: it emits `items: false` plus `prefixItems`, which VS Code
 * Copilot rejects at registration ("array type must have items").
 */
export const ParamUptimeHeaders = z
  .array(z.array(z.string()).length(2))
  .describe(
    'Optional HTTP headers as an array of [name, value] pairs, e.g. [["Accept","application/json"]].',
  );

export function toUptimeHeaderPairs(
  headers: string[][],
): Array<[string, string]> {
  return headers.map(([name, value]) => [name, value]);
}

/** Owner actor for create/update. Empty/whitespace rejected. */
export const ParamUptimeOwner = z
  .string()
  .trim()
  .min(1)
  .regex(
    /^(user|team):.+$/,
    "owner must use `user:ID` or `team:ID` format (e.g. `user:123` or `team:456`).",
  )
  .describe("Owner actor in `user:ID` or `team:ID` format.");

const SENSITIVE_HEADER_NAMES = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-access-token",
  "x-csrf-token",
  "x-sentry-auth",
]);

export function isSensitiveHeaderName(name: string): boolean {
  const normalized = name.trim().toLowerCase();
  if (SENSITIVE_HEADER_NAMES.has(normalized)) {
    return true;
  }
  return (
    normalized.includes("authorization") ||
    normalized.includes("api-key") ||
    normalized.includes("access-token") ||
    normalized.includes("secret") ||
    normalized.includes("password")
  );
}

export const uptimeHeaderSchema = z.object({
  name: z.string(),
  value: z.string(),
});

/**
 * Map configured headers for tool output without leaking secrets.
 * Malformed entries are skipped. Sensitive values are redacted.
 */
export function toUptimeHeadersForOutput(
  headers: unknown,
): Array<z.infer<typeof uptimeHeaderSchema>> {
  if (!Array.isArray(headers)) {
    return [];
  }

  const output: Array<z.infer<typeof uptimeHeaderSchema>> = [];
  for (const header of headers) {
    if (!Array.isArray(header) || header.length < 2) {
      continue;
    }
    const [name, value] = header;
    if (typeof name !== "string" || typeof value !== "string") {
      continue;
    }
    output.push({
      name,
      value: isSensitiveHeaderName(name) ? "[REDACTED]" : value,
    });
  }
  return output;
}

export const uptimeStatusSchema = z.enum(["ok", "failed", "unknown"]);

/** Compact list item for discovery. Omits config detail agents rarely need in lists. */
export const uptimeMonitorListItemSchema = z.object({
  id: z.string(),
  name: z.string(),
  projectSlug: z.string(),
  status: z.string(),
  uptimeStatus: uptimeStatusSchema,
  url: z.string(),
  method: z.string().optional(),
  intervalSeconds: z.number(),
  environment: z.string().optional(),
  owner: z.string().optional(),
  webUrl: z.string().url(),
});

/**
 * Mutation/detail summary: list fields plus config knobs useful after create/update.
 * Optional fields are omitted when absent instead of returned as null.
 */
export const uptimeMonitorSummarySchema = uptimeMonitorListItemSchema.extend({
  timeoutMs: z.number(),
  recoveryThreshold: z.number().optional(),
  downtimeThreshold: z.number().optional(),
  traceSampling: z.boolean().optional(),
  responseCaptureEnabled: z.boolean().optional(),
});

export type UptimeMonitorListItem = z.infer<typeof uptimeMonitorListItemSchema>;
export type UptimeMonitorSummary = z.infer<typeof uptimeMonitorSummarySchema>;

export function getUptimeOwnerName(
  monitor: Pick<UptimeMonitor, "owner">,
): string | null {
  if (!monitor.owner) {
    return null;
  }
  const formatted = formatActor(monitor.owner);
  return formatted === "unknown" ? null : formatted;
}

export function formatUptimeStatus(
  value: unknown,
): "ok" | "failed" | "unknown" {
  if (value === 1 || value === "1" || value === "ok") {
    return "ok";
  }
  if (value === 2 || value === "2" || value === "failed") {
    return "failed";
  }
  return "unknown";
}

function optionalString(value: string | null | undefined): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function toUptimeMonitorListItem(
  monitor: UptimeMonitor,
  webUrl: string,
): UptimeMonitorListItem {
  return {
    id: String(monitor.id),
    name: monitor.name,
    projectSlug: monitor.projectSlug,
    status: monitor.status,
    uptimeStatus: formatUptimeStatus(monitor.uptimeStatus),
    url: monitor.url,
    ...(monitor.method ? { method: monitor.method } : {}),
    intervalSeconds: monitor.intervalSeconds,
    ...(optionalString(monitor.environment)
      ? { environment: optionalString(monitor.environment) }
      : {}),
    ...(getUptimeOwnerName(monitor)
      ? { owner: getUptimeOwnerName(monitor)! }
      : {}),
    webUrl,
  };
}

export function toUptimeMonitorSummary(
  monitor: UptimeMonitor,
  webUrl: string,
): UptimeMonitorSummary {
  return {
    ...toUptimeMonitorListItem(monitor, webUrl),
    timeoutMs: monitor.timeoutMs,
    ...(monitor.recoveryThreshold !== undefined &&
    monitor.recoveryThreshold !== null
      ? { recoveryThreshold: monitor.recoveryThreshold }
      : {}),
    ...(monitor.downtimeThreshold !== undefined &&
    monitor.downtimeThreshold !== null
      ? { downtimeThreshold: monitor.downtimeThreshold }
      : {}),
    ...(monitor.traceSampling !== undefined && monitor.traceSampling !== null
      ? { traceSampling: monitor.traceSampling }
      : {}),
    ...(monitor.responseCaptureEnabled !== undefined &&
    monitor.responseCaptureEnabled !== null
      ? { responseCaptureEnabled: monitor.responseCaptureEnabled }
      : {}),
  };
}
