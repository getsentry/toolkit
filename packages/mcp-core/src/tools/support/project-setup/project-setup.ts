import { z } from "zod";
import platforms from "./platforms.json" with { type: "json" };

const DOCS_ORIGIN = "https://docs.sentry.io";

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
  docsPath: string;
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
        usefulFor: "Exceptions and crashes, with stack traces",
        recommended: true,
      },
    ],
    [
      "traces",
      {
        name: "Traces",
        usefulFor: "Following requests, services, and agent runs end to end",
        recommended: true,
      },
    ],
    [
      "logs",
      {
        name: "Logs",
        usefulFor: "App context around failures, linked to traces",
        recommended: false,
        feature: "ourlogs-enabled",
      },
    ],
    [
      "metrics",
      {
        name: "Metrics",
        usefulFor: "Tracking and alerting on app and business health",
        recommended: false,
        feature: "tracemetrics-enabled",
      },
    ],
    [
      "sessionReplay",
      {
        name: "Session Replay",
        usefulFor: "Seeing what a user did before a bug",
        recommended: false,
        feature: "session-replay",
      },
    ],
  ];

function docsUrl(path: string): string {
  return new URL(path, DOCS_ORIGIN).toString();
}

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
    const path = key === "errors" ? entry.docsPath : entry.signals[key];
    if (!path) {
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
      docsUrl: docsUrl(path),
    });
  }

  return {
    platform: entry.name,
    docsUrl: docsUrl(entry.docsPath),
    signals,
  };
}
