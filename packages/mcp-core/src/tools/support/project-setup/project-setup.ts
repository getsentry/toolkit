import { z } from "zod";
import platforms from "./platforms.json" with { type: "json" };

export const projectSetupSchema = z
  .object({
    platform: z.string().describe("Platform display name, such as `Next.js`."),
    docsUrl: z.string().describe("Sentry setup guide for the platform."),
    signals: z
      .array(
        z.object({
          name: z.string(),
          usefulFor: z.string(),
          recommended: z
            .literal(true)
            .optional()
            .describe("Set on signals the SDK's default setup turns on."),
          docsUrl: z.string(),
        }),
      )
      .describe(
        "Core signals the platform supports and the organization has enabled.",
      ),
  })
  .nullable()
  .describe("Setup knowledge for the project's platform, or null without one.");

type ProjectSetup = z.output<typeof projectSetupSchema>;

type PlatformSignalKey = "traces" | "logs" | "metrics" | "sessionReplay";

interface PlatformSetupEntry {
  name: string;
  docsUrl: string;
  signals: Partial<Record<PlatformSignalKey, string>>;
}

const PLATFORM_SETUP: Readonly<Record<string, PlatformSetupEntry>> = platforms;

interface SignalDefinition {
  name: string;
  usefulFor: string;
  recommended: boolean;
  /** Organization feature that must be on, as Sentry's onboarding checks it. */
  feature?: string;
}

// Order is the order the result lists signals in. Errors has no key: every
// platform supports it, and its docs are the platform setup guide.
const SIGNALS: ReadonlyArray<[PlatformSignalKey | "errors", SignalDefinition]> =
  [
    [
      "errors",
      {
        name: "Errors",
        usefulFor:
          "Unhandled exceptions and crashes, grouped into issues with stack traces and the state that led to them",
        recommended: true,
      },
    ],
    [
      "traces",
      {
        name: "Traces",
        usefulFor:
          "Debugging how requests, background jobs, and AI agent runs flow across services, and where they fail or slow down",
        recommended: true,
      },
    ],
    [
      "logs",
      {
        name: "Logs",
        usefulFor:
          "Structured app logs linked to the trace and error they came from, for context a stack trace lacks",
        recommended: false,
        feature: "ourlogs-enabled",
      },
    ],
    [
      "metrics",
      {
        name: "Metrics",
        usefulFor:
          "Counters, gauges, and distributions to chart and alert on, such as signups, queue depth, or token usage",
        recommended: false,
        feature: "tracemetrics-enabled",
      },
    ],
    [
      "sessionReplay",
      {
        name: "Session Replay",
        usefulFor:
          "Understanding how users behave in a web or mobile UI: clicks, navigation, network calls, and errors in a replay, to reproduce bugs and find friction",
        recommended: false,
        feature: "session-replay",
      },
    ],
  ];

/**
 * Builds setup knowledge for a Sentry platform ID: its setup guide and the
 * core signals its SDK supports, each with a docs link.
 *
 * `organizationFeatures` drops signals the organization has not enabled. Pass
 * null when the features are unknown, and every supported signal is listed.
 * Returns null for a missing or unknown platform.
 */
export function buildProjectSetup(
  platform: string | null | undefined,
  organizationFeatures: readonly string[] | null,
): ProjectSetup {
  const entry = platform ? PLATFORM_SETUP[platform] : undefined;
  if (!entry) {
    return null;
  }

  const signals: NonNullable<ProjectSetup>["signals"] = [];
  for (const [key, definition] of SIGNALS) {
    const signalDocsUrl = key === "errors" ? entry.docsUrl : entry.signals[key];
    if (!signalDocsUrl) {
      continue;
    }
    if (
      definition.feature &&
      organizationFeatures &&
      !organizationFeatures.includes(definition.feature)
    ) {
      continue;
    }
    signals.push({
      name: definition.name,
      usefulFor: definition.usefulFor,
      ...(definition.recommended ? { recommended: true as const } : {}),
      docsUrl: signalDocsUrl,
    });
  }

  return {
    platform: entry.name,
    docsUrl: entry.docsUrl,
    signals,
  };
}
