/**
 * Fixture factories for testing.
 *
 * Provides baseline event and issue fixtures with factory functions for creating
 * customized objects with type-safe overrides.
 *
 * @example
 * ```typescript
 * import { createDefaultEvent, createPerformanceIssue } from "@sentry/mcp-server-mocks";
 *
 * // Create with overrides
 * const customEvent = createDefaultEvent({
 *   id: "custom-123",
 *   message: "Custom error message"
 * });
 *
 * const customIssue = createPerformanceIssue({
 *   shortId: "PERF-123",
 *   count: "50"
 * });
 * ```
 */

import defaultEventFixtureJson from "./fixtures/default-event.json" with { type: "json" };
import genericEventFixtureJson from "./fixtures/generic-event.json" with { type: "json" };
import unknownEventFixtureJson from "./fixtures/unknown-event.json" with { type: "json" };
import performanceIssueFixtureJson from "./fixtures/performance-issue.json" with { type: "json" };
import regressedIssueFixtureJson from "./fixtures/regressed-issue.json" with { type: "json" };
import unsupportedIssueFixtureJson from "./fixtures/unsupported-issue.json" with { type: "json" };
import performanceEventFixtureJson from "./fixtures/performance-event.json" with { type: "json" };
import cspIssueFixtureJson from "./fixtures/csp-issue.json" with { type: "json" };
import cspEventFixtureJson from "./fixtures/csp-event.json" with { type: "json" };
import feedbackIssueFixtureJson from "./fixtures/feedback-issue.json" with { type: "json" };

// Type helper for deep partial overrides
type DeepPartial<T> = T extends object
  ? {
      [P in keyof T]?: DeepPartial<T[P]>;
    }
  : T;

// Internal baseline fixtures (not exported - use factory functions instead)
const defaultEventFixture = defaultEventFixtureJson as any;
const genericEventFixture = genericEventFixtureJson as any;
const unknownEventFixture = unknownEventFixtureJson as any;
const performanceIssueFixture = performanceIssueFixtureJson as any;
const regressedIssueFixture = regressedIssueFixtureJson as any;
const unsupportedIssueFixture = unsupportedIssueFixtureJson as any;
const performanceEventFixture = performanceEventFixtureJson as any;
const cspIssueFixture = cspIssueFixtureJson as any;
const cspEventFixture = cspEventFixtureJson as any;
const feedbackIssueFixture = feedbackIssueFixtureJson as any;

/**
 * Deep merge helper that recursively merges objects.
 * Arrays are replaced, not merged.
 */
function deepMerge<T>(target: T, source: DeepPartial<T>): T {
  const output = { ...target } as any;

  if (isObject(target) && isObject(source)) {
    for (const key of Object.keys(source)) {
      const sourceValue = (source as any)[key];
      const targetValue = (output as any)[key];

      if (
        isObject(sourceValue) &&
        isObject(targetValue) &&
        !Array.isArray(sourceValue)
      ) {
        output[key] = deepMerge(targetValue, sourceValue);
      } else {
        output[key] = sourceValue;
      }
    }
  }

  return output;
}

function isObject(item: any): boolean {
  return item && typeof item === "object" && !Array.isArray(item);
}

/**
 * Create a DefaultEvent with optional overrides.
 *
 * @param overrides - Partial event properties to override
 * @returns A complete DefaultEvent object
 *
 * @example
 * ```typescript
 * const event = createDefaultEvent({
 *   id: "test-123",
 *   message: "Custom error",
 *   tags: [{ key: "env", value: "staging" }]
 * });
 * ```
 */
export function createDefaultEvent(
  overrides: DeepPartial<typeof defaultEventFixture> = {},
): typeof defaultEventFixture {
  return deepMerge(JSON.parse(JSON.stringify(defaultEventFixture)), overrides);
}

/**
 * Create a GenericEvent with optional overrides.
 *
 * @param overrides - Partial event properties to override
 * @returns A complete GenericEvent object
 *
 * @example
 * ```typescript
 * const event = createGenericEvent({
 *   occurrence: {
 *     evidenceData: {
 *       transaction: "GET /api/users"
 *     }
 *   }
 * });
 * ```
 */
export function createGenericEvent(
  overrides: DeepPartial<typeof genericEventFixture> = {},
): typeof genericEventFixture {
  return deepMerge(JSON.parse(JSON.stringify(genericEventFixture)), overrides);
}

/**
 * Create an UnknownEvent with optional overrides.
 * Useful for testing graceful handling of unsupported event types.
 *
 * @param overrides - Partial event properties to override
 * @returns A complete UnknownEvent object
 *
 * @example
 * ```typescript
 * const event = createUnknownEvent({
 *   type: "ai_agent_trace_v2",
 *   title: "Future AI Event"
 * });
 * ```
 */
export function createUnknownEvent(
  overrides: DeepPartial<typeof unknownEventFixture> = {},
): typeof unknownEventFixture {
  return deepMerge(JSON.parse(JSON.stringify(unknownEventFixture)), overrides);
}

/**
 * Create a PerformanceEvent with optional overrides.
 * Based on the performance-event.json fixture which includes N+1 query occurrence data.
 *
 * @param overrides - Partial event properties to override
 * @returns A complete PerformanceEvent object
 *
 * @example
 * ```typescript
 * const event = createPerformanceEvent({
 *   occurrence: {
 *     evidenceData: {
 *       offenderSpanIds: ["span1", "span2"]
 *     }
 *   }
 * });
 * ```
 */
export function createPerformanceEvent(
  overrides: DeepPartial<typeof performanceEventFixture> = {},
): typeof performanceEventFixture {
  return deepMerge(
    JSON.parse(JSON.stringify(performanceEventFixture)),
    overrides,
  );
}

/**
 * Create a PerformanceIssue with optional overrides.
 * Represents a performance issue like N+1 queries, slow DB queries, etc.
 *
 * @param overrides - Partial issue properties to override
 * @returns A complete PerformanceIssue object
 *
 * @example
 * ```typescript
 * const issue = createPerformanceIssue({
 *   shortId: "PERF-123",
 *   count: "50",
 *   metadata: {
 *     value: "SELECT * FROM products WHERE id = %s"
 *   }
 * });
 * ```
 */
export function createPerformanceIssue(
  overrides: DeepPartial<typeof performanceIssueFixture> = {},
): typeof performanceIssueFixture {
  return deepMerge(
    JSON.parse(JSON.stringify(performanceIssueFixture)),
    overrides,
  );
}

/**
 * Create a RegressedIssue with optional overrides.
 * Represents a performance regression issue (substatus: "regressed").
 *
 * @param overrides - Partial issue properties to override
 * @returns A complete RegressedIssue object
 *
 * @example
 * ```typescript
 * const issue = createRegressedIssue({
 *   shortId: "REGR-001",
 *   metadata: {
 *     value: "Increased from 100ms to 500ms (P95)"
 *   }
 * });
 * ```
 */
export function createRegressedIssue(
  overrides: DeepPartial<typeof regressedIssueFixture> = {},
): typeof regressedIssueFixture {
  return deepMerge(
    JSON.parse(JSON.stringify(regressedIssueFixture)),
    overrides,
  );
}

/**
 * Create an UnsupportedIssue with optional overrides.
 * Used for testing handling of future/unknown issue types.
 *
 * @param overrides - Partial issue properties to override
 * @returns A complete UnsupportedIssue object
 *
 * @example
 * ```typescript
 * const issue = createUnsupportedIssue({
 *   shortId: "FUTURE-001",
 *   title: "New Issue Type"
 * });
 * ```
 */
export function createUnsupportedIssue(
  overrides: DeepPartial<typeof unsupportedIssueFixture> = {},
): typeof unsupportedIssueFixture {
  return deepMerge(
    JSON.parse(JSON.stringify(unsupportedIssueFixture)),
    overrides,
  );
}

/**
 * Create a CspIssue with optional overrides.
 * Represents a Content Security Policy violation issue.
 *
 * @param overrides - Partial issue properties to override
 * @returns A complete CspIssue object
 *
 * @example
 * ```typescript
 * const issue = createCspIssue({
 *   shortId: "BLOG-CSP-123",
 *   metadata: {
 *     directive: "script-src",
 *     uri: "https://evil.com/script.js"
 *   }
 * });
 * ```
 */
export function createCspIssue(
  overrides: DeepPartial<typeof cspIssueFixture> = {},
): typeof cspIssueFixture {
  return deepMerge(JSON.parse(JSON.stringify(cspIssueFixture)), overrides);
}

/**
 * Create a CspEvent with optional overrides.
 * Represents a Content Security Policy violation event with CSP-specific entry data.
 *
 * @param overrides - Partial event properties to override
 * @returns A complete CspEvent object
 *
 * @example
 * ```typescript
 * const event = createCspEvent({
 *   id: "test-csp-123",
 *   metadata: {
 *     directive: "img-src",
 *     uri: "blob:"
 *   }
 * });
 * ```
 */
export function createCspEvent(
  overrides: DeepPartial<typeof cspEventFixture> = {},
): typeof cspEventFixture {
  return deepMerge(JSON.parse(JSON.stringify(cspEventFixture)), overrides);
}

/**
 * Create a FeedbackIssue with optional overrides.
 * Represents a user feedback submission from the User Feedback Widget.
 *
 * @param overrides - Partial issue properties to override
 * @returns A complete FeedbackIssue object
 *
 * @example
 * ```typescript
 * const issue = createFeedbackIssue({
 *   shortId: "PROJ-FEEDBACK-001",
 *   title: "User Feedback: Can't login",
 *   metadata: {
 *     value: "Login button is not responding"
 *   }
 * });
 * ```
 */
export function createFeedbackIssue(
  overrides: DeepPartial<typeof feedbackIssueFixture> = {},
): typeof feedbackIssueFixture {
  return deepMerge(JSON.parse(JSON.stringify(feedbackIssueFixture)), overrides);
}
