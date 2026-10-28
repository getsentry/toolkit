import type { Envelope } from "@sentry/core";
import { parseBrowserFromUserAgent } from "./userAgent.ts";

export const SOURCE_TYPES = ["browser", "mobile", "server"] as const;
export type SourceType = (typeof SOURCE_TYPES)[number];

/**
 * Helper to detect if a User-Agent string is from a browser
 */
function isBrowserUserAgent(userAgent: string): boolean {
  const parsed = parseBrowserFromUserAgent(userAgent);
  return (
    parsed !== "unknown" &&
    (parsed.includes("Chrome") ||
      parsed.includes("Firefox") ||
      parsed.includes("Safari") ||
      parsed.includes("Edge"))
  );
}

/**
 * Check if a platform string indicates a server environment
 */
function isServerPlatform(platform: string | undefined): boolean {
  return (
    platform === "node" ||
    platform === "python" ||
    platform === "ruby" ||
    platform === "php" ||
    platform === "java" ||
    platform === "go" ||
    platform === "rust" ||
    platform === "perl" ||
    platform === "elixir" ||
    platform === "csharp" ||
    platform === "dotnet"
  );
}

/**
 * Try to infer source from a single event's properties
 * Returns the source if deterministically detected, null otherwise
 */
function inferSourceFromEvent(event: any): SourceType | null {
  if (!event) return null;

  // Runtime tags check - deterministic browser
  if (event.tags?.runtime === "browser") {
    return "browser";
  }

  // Runtime context indicates server
  if (event.contexts?.runtime?.name) {
    return "server";
  }

  // server_name is a server-specific field
  if (event.server_name) {
    return "server";
  }

  // Platform check
  if (isServerPlatform(event.platform)) {
    return "server";
  }

  return null;
}

/**
 * Infer the source of an envelope as browser, mobile, or server using multiple signals
 * Priority order:
 * 1. SDK name (mobile detection)
 * 2. Sender User-Agent (from HTTP request header)
 * 3. Platform & Runtime tags (from event payloads - scans all events)
 * 4. SDK name (browser/server fallback)
 *
 * Rules based on https://release-registry.services.sentry.io/sdks
 *
 * @param envelopeHeader The envelope header containing SDK info and spotlight extensions
 * @param eventsOrEvent Single event or array of events to scan for source signals (scans until deterministic match)
 */
export function inferEnvelopeSource(
  envelopeHeader: Envelope[0],
  eventsOrEvent?: unknown,
): SourceType {
  // Normalize to array for consistent handling
  const events = eventsOrEvent
    ? Array.isArray(eventsOrEvent)
      ? eventsOrEvent
      : [eventsOrEvent]
    : [];
  const sdkName = envelopeHeader?.sdk?.name || "";

  // 1. Mobile check (unchanged - already reliable from SDK name)
  // Mobile: Native mobile platforms and frameworks
  if (
    sdkName.includes("cocoa") ||
    sdkName.includes("android") ||
    sdkName.includes("react-native") ||
    sdkName.includes("flutter") ||
    sdkName.includes("capacitor") ||
    sdkName.includes("cordova") ||
    sdkName.includes("xamarin") ||
    sdkName.includes("maui") ||
    sdkName.includes("unity") ||
    sdkName.includes("kotlin.kmp")
  ) {
    return "mobile";
  }

  // 2. Sender User-Agent check
  const senderUserAgent = (envelopeHeader as any).__spotlight_sender_user_agent;
  if (senderUserAgent && typeof senderUserAgent === "string") {
    if (isBrowserUserAgent(senderUserAgent)) {
      return "browser";
    }
    // Server SDKs send server UAs like "Node.js/*", "Python-urllib/*", etc.
    // If we have a non-browser UA, we continue to further checks
  }

  // 3. Scan all events for deterministic source signals
  for (const event of events) {
    const source = inferSourceFromEvent(event);
    if (source) {
      return source;
    }
  }

  // 4. SDK name check (existing logic as fallback)
  // Browser: JavaScript frameworks/libraries (excluding server/native runtimes and meta-frameworks)
  if (
    sdkName.startsWith("sentry.javascript.") &&
    !sdkName.includes("node") &&
    !sdkName.includes("bun") &&
    !sdkName.includes("deno") &&
    !sdkName.includes("electron") &&
    !sdkName.includes("serverless") &&
    !sdkName.includes("cloudflare") &&
    !sdkName.includes("vercel-edge") &&
    !sdkName.includes("wasm") &&
    !sdkName.includes("opentelemetry") &&
    !sdkName.includes("nextjs") &&
    !sdkName.includes("remix") &&
    !sdkName.includes("gatsby") &&
    !sdkName.includes("astro") &&
    !sdkName.includes("nuxt") &&
    !sdkName.includes("sveltekit") &&
    !sdkName.includes("solidstart") &&
    !sdkName.includes("nestjs") &&
    !sdkName.includes("tanstackstart")
  ) {
    return "browser";
  }

  // Special case: Blazor WebAssembly runs in browser
  if (sdkName.includes("blazor.webassembly")) {
    return "browser";
  }

  // Server: Everything else (node, python, ruby, go, php, java, dotnet, etc.)
  return "server";
}
