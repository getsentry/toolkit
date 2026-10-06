import type { Score, ScoreFn, BaseScorerOptions } from "vitest-evals";

interface StructuredOutputScorerOptions extends BaseScorerOptions {
  expected?: Record<string, any>;
}

interface StructuredOutputScorerConfig {
  /**
   * How to match field values
   * - "strict": Exact equality required (default)
   * - "fuzzy": More flexible matching (regex patterns, type coercion)
   * - Custom function: Your own comparison logic
   * @default "strict"
   */
  match?:
    | "strict"
    | "fuzzy"
    | ((expected: any, actual: any, key: string) => boolean);

  /**
   * Whether all expected fields must be present for a passing score
   * When false: gives partial credit based on fields matched
   * @default true
   */
  requireAll?: boolean;

  /**
   * Whether to allow additional fields beyond those expected
   * @default true
   */
  allowExtras?: boolean;

  /**
   * Enable debug logging
   * @default false
   */
  debug?: boolean;
}

/**
 * A configurable scorer for evaluating structured outputs (e.g., JSON) from LLM responses.
 *
 * Similar to ToolCallScorer but for validating structured data outputs like API queries.
 *
 * @param config - Configuration options for the scorer
 * @param config.match - How to match field values: "strict", "fuzzy", or custom function
 * @param config.requireAll - Require all expected fields (vs partial credit)
 * @param config.allowExtras - Allow additional fields in output
 * @param config.debug - Enable debug logging
 *
 * @example
 * // Default: strict matching
 * describeEval("query generation", {
 *   data: async () => [{
 *     input: "Show me errors from today",
 *     expected: {
 *       dataset: "errors",
 *       query: "",
 *       sort: "-timestamp",
 *       timeRange: { statsPeriod: "24h" }
 *     }
 *   }],
 *   task: myTask,
 *   scorers: [StructuredOutputScorer()]
 * });
 *
 * @example
 * // Fuzzy matching with regex patterns
 * describeEval("flexible query matching", {
 *   data: async () => [{
 *     input: "Find slow API calls",
 *     expected: {
 *       dataset: "spans",
 *       query: /span\.duration:>1000|span\.duration:>1s/,
 *       sort: "-span.duration"
 *     }
 *   }],
 *   task: myTask,
 *   scorers: [StructuredOutputScorer({ match: "fuzzy" })]
 * });
 */
export function StructuredOutputScorer(
  config: StructuredOutputScorerConfig = {},
): ScoreFn<StructuredOutputScorerOptions> {
  const {
    match = "strict",
    requireAll = true,
    allowExtras = true,
    debug = false,
  } = config;

  return async (opts: StructuredOutputScorerOptions): Promise<Score> => {
    const { output, expected } = opts;

    // If no expected output provided, just check if we got valid JSON
    if (!expected) {
      try {
        JSON.parse(output);
        return { score: 1, metadata: { rationale: "Valid JSON output" } };
      } catch {
        return { score: 0, metadata: { rationale: "Invalid JSON output" } };
      }
    }

    let parsed: Record<string, any>;
    try {
      parsed = JSON.parse(output);
    } catch (error) {
      return {
        score: 0,
        metadata: { rationale: `Failed to parse output as JSON: ${error}` },
      };
    }

    // Check for error field in output
    if (parsed.error && parsed.error !== "" && parsed.error !== null) {
      return {
        score: 0,
        metadata: { rationale: `Output contains error: ${parsed.error}` },
      };
    }

    const matchFn = getMatchFunction(match);
    const { matches, mismatches, extras } = compareObjects(
      expected,
      parsed,
      matchFn,
    );

    if (debug) {
      console.log("StructuredOutputScorer debug:");
      console.log("Expected:", expected);
      console.log("Actual:", parsed);
      console.log("Matches:", matches);
      console.log("Mismatches:", mismatches);
      console.log("Extras:", extras);
    }

    // Calculate score
    const totalExpected = Object.keys(expected).length;
    const totalMatched = matches.length;
    const hasExtras = extras.length > 0;

    let score: number;
    let rationale: string;

    if (requireAll && mismatches.length > 0) {
      score = 0;
      rationale = `Missing required fields: ${mismatches.map((m) => m.key).join(", ")}`;
    } else if (!allowExtras && hasExtras) {
      score = 0;
      rationale = `Unexpected extra fields: ${extras.join(", ")}`;
    } else if (totalExpected === 0) {
      score = 1;
      rationale = "No expected fields to match";
    } else {
      score = totalMatched / totalExpected;
      if (score === 1) {
        rationale = "All expected fields match";
      } else {
        rationale = `Matched ${totalMatched}/${totalExpected} fields`;
      }
    }

    // Add mismatch details to rationale
    if (mismatches.length > 0 && score < 1) {
      const details = mismatches
        .map(
          (m) =>
            `${m.key}: expected ${formatValue(m.expected)}, got ${formatValue(m.actual)}`,
        )
        .join("; ");
      rationale += ` - ${details}`;
    }

    return {
      score,
      metadata: {
        rationale,
        output,
      },
    };
  };
}

function getMatchFunction(
  match: StructuredOutputScorerConfig["match"],
): (expected: any, actual: any, key: string) => boolean {
  if (typeof match === "function") {
    return match;
  }

  if (match === "fuzzy") {
    return fuzzyMatch;
  }

  return strictMatch;
}

function strictMatch(expected: any, actual: any): boolean {
  return JSON.stringify(expected) === JSON.stringify(actual);
}

function fuzzyMatch(expected: any, actual: any): boolean {
  // Handle regex patterns
  if (expected instanceof RegExp) {
    return typeof actual === "string" && expected.test(actual);
  }

  // Handle functions (custom validators)
  if (typeof expected === "function") {
    return expected(actual);
  }

  // Handle null/undefined (intentionally using == for null/undefined check)
  if (
    expected === null ||
    expected === undefined ||
    actual === null ||
    actual === undefined
  ) {
    return expected === actual;
  }

  // Handle arrays
  if (Array.isArray(expected) && Array.isArray(actual)) {
    if (expected.length !== actual.length) return false;
    return expected.every((exp, i) => fuzzyMatch(exp, actual[i]));
  }

  // Handle objects
  if (typeof expected === "object" && typeof actual === "object") {
    return Object.keys(expected).every((key) =>
      fuzzyMatch(expected[key], actual[key]),
    );
  }

  // Handle primitives - fuzzy match allows type coercion (e.g., "1" matches 1)
  // Intentional for fuzzy matching with type coercion
  return expected == actual;
}

interface ComparisonResult {
  matches: Array<{ key: string; expected: any; actual: any }>;
  mismatches: Array<{ key: string; expected: any; actual: any }>;
  extras: string[];
}

function compareObjects(
  expected: Record<string, any>,
  actual: Record<string, any>,
  matchFn: (expected: any, actual: any, key: string) => boolean,
): ComparisonResult {
  const matches: ComparisonResult["matches"] = [];
  const mismatches: ComparisonResult["mismatches"] = [];

  // Check expected fields
  for (const [key, expectedValue] of Object.entries(expected)) {
    const actualValue = actual[key];

    if (matchFn(expectedValue, actualValue, key)) {
      matches.push({ key, expected: expectedValue, actual: actualValue });
    } else {
      mismatches.push({ key, expected: expectedValue, actual: actualValue });
    }
  }

  // Find extra fields
  const expectedKeys = new Set(Object.keys(expected));
  const extras = Object.keys(actual).filter((key) => !expectedKeys.has(key));

  return { matches, mismatches, extras };
}

function formatValue(value: any): string {
  if (value === undefined) return "undefined";
  if (value === null) return "null";
  if (value instanceof RegExp) return value.toString();
  if (typeof value === "string") return `"${value}"`;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
