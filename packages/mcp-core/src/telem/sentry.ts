import { isPlainObject } from "../internal/type-guards";

interface ScrubPattern {
  pattern: RegExp;
  replacement: string;
  description: string;
}

// Patterns for sensitive data that should be scrubbed
// Pre-compile patterns with global flag for replacement
const SCRUB_PATTERNS: ScrubPattern[] = [
  {
    pattern: /\bsk-[a-zA-Z0-9]{48}\b/g,
    replacement: "[REDACTED_OPENAI_KEY]",
    description: "OpenAI API key",
  },
  {
    pattern: /\bBearer\s+[a-zA-Z0-9\-._~+/]+={0,}/g,
    replacement: "Bearer [REDACTED_TOKEN]",
    description: "Bearer token",
  },
  {
    pattern: /\bsntrys_[a-zA-Z0-9_]+\b/g,
    replacement: "[REDACTED_SENTRY_TOKEN]",
    description: "Sentry access token",
  },
];

// Maximum depth for recursive scrubbing to prevent stack overflow
const MAX_SCRUB_DEPTH = 20;

/**
 * Recursively scrub sensitive data from any value.
 * Returns tuple of [scrubbedValue, didScrub, descriptionsOfMatchedPatterns]
 */
function scrubValue(value: unknown, depth = 0): [unknown, boolean, string[]] {
  // Prevent stack overflow by limiting recursion depth
  if (depth >= MAX_SCRUB_DEPTH) {
    return ["[MAX_DEPTH_EXCEEDED]", false, []];
  }

  if (typeof value === "string") {
    let scrubbed = value;
    let didScrub = false;
    const matchedDescriptions: string[] = [];

    for (const { pattern, replacement, description } of SCRUB_PATTERNS) {
      // Reset lastIndex to avoid stateful regex issues
      pattern.lastIndex = 0;
      if (pattern.test(scrubbed)) {
        didScrub = true;
        matchedDescriptions.push(description);
        // Reset again before replace
        pattern.lastIndex = 0;
        scrubbed = scrubbed.replace(pattern, replacement);
      }
    }
    return [scrubbed, didScrub, matchedDescriptions];
  }

  if (Array.isArray(value)) {
    let arrayDidScrub = false;
    const arrayDescriptions: string[] = [];
    const scrubbedArray = value.map((item) => {
      const [scrubbed, didScrub, descriptions] = scrubValue(item, depth + 1);
      if (didScrub) {
        arrayDidScrub = true;
        arrayDescriptions.push(...descriptions);
      }
      return scrubbed;
    });
    return [scrubbedArray, arrayDidScrub, arrayDescriptions];
  }

  if (value && typeof value === "object") {
    let objectDidScrub = false;
    const objectDescriptions: string[] = [];
    const scrubbed: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      const [scrubbedVal, didScrub, descriptions] = scrubValue(val, depth + 1);
      if (didScrub) {
        objectDidScrub = true;
        objectDescriptions.push(...descriptions);
      }
      scrubbed[key] = scrubbedVal;
    }
    return [scrubbed, objectDidScrub, objectDescriptions];
  }

  return [value, false, []];
}

/**
 * Sentry beforeSend hook that scrubs sensitive data from events
 * and applies custom fingerprinting for specific error types.
 */
export function sentryBeforeSend<TEvent extends object>(
  event: TEvent,
  _hint: unknown,
): TEvent {
  // Custom fingerprinting for AI SDK API call errors.
  // These errors share the same stack trace but have different messages
  // (e.g., "Country, region, or territory not supported", temperature issues).
  // Without custom fingerprinting, they all get grouped into a single issue.
  const exception: unknown = "exception" in event ? event.exception : undefined;
  const exceptionValues = isPlainObject(exception)
    ? exception["values"]
    : undefined;
  const firstException: unknown = Array.isArray(exceptionValues)
    ? exceptionValues[0]
    : undefined;
  if (
    isPlainObject(firstException) &&
    firstException["type"] === "AI_APICallError" &&
    firstException["value"]
  ) {
    Object.assign(event, {
      fingerprint: ["AI_APICallError", firstException["value"]],
    });
  }

  // Always scrub the entire event
  const [scrubbedEvent, didScrub, descriptions] = scrubValue(event);

  // Log to console if we found and scrubbed sensitive data
  // (avoiding LogTape dependency for edge/browser compatibility)
  if (didScrub) {
    const uniqueDescriptions = [...new Set(descriptions)];
    console.warn(
      `[Sentry] Event contained sensitive data: ${uniqueDescriptions.join(", ")}`,
    );
  }

  // scrubValue copies objects and arrays key by key and only rewrites string
  // leaves, so the scrubbed event keeps the event's shape.
  return scrubbedEvent as TEvent;
}

// Emails in free-form text we log (search queries, error messages) are redacted
// before logging. Kept out of SCRUB_PATTERNS/sentryBeforeSend on purpose: a
// `user.email` in event context is intentional and useful.
const EMAIL_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;

/**
 * Scrub tokens (OpenAI/Bearer/Sentry) and emails from a free-form string before
 * logging it. Applied at the log call site so it covers every sink (stderr and
 * Sentry Logs).
 */
export function scrubSensitiveText(text: string): string {
  let scrubbed = text;
  for (const { pattern, replacement } of SCRUB_PATTERNS) {
    pattern.lastIndex = 0;
    scrubbed = scrubbed.replace(pattern, replacement);
  }
  return scrubbed.replace(EMAIL_PATTERN, "[REDACTED_EMAIL]");
}
