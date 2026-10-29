// Types of the parser generated from id-arguments.pegjs. The generator
// copies this file to src/generated/id-arguments-grammar.d.ts and rewrites
// relative imports to resolve from there. It also compiles every `startRule`
// listed here as a start rule.

import type {
  IdArguments,
  TraceOrProjectArguments,
} from "../src/lib/id-arguments.js";
import type { ParsedSentryUrl } from "../src/lib/sentry-url-parser.js";

/**
 * Hooks the ID-arguments grammar calls to check IDs and to throw, so its
 * errors match the rest of the CLI. See `parseIdArguments()`.
 */
export type IdArgumentsGrammarOptions = {
  /** Usage shown when arguments are ignored or there are too many. */
  usageHint: string;
  /** Whether `value` is an ID. */
  isId: (value: string) => boolean;
  /** Normalize an ID; throw when `value` is not one. */
  id: (value: string) => string;
  /** Parse a Sentry web URL, or return `null` for anything else. */
  sentryUrl: (value: string) => ParsedSentryUrl | null;
  /** Throw for a missing ID. */
  missing: (suggestions?: string[]) => never;
  /** Throw a validation error. */
  invalid: (message: string, field?: string) => never;
};

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: unknown;
}

/** Parse NUL-prefixed arguments that end in an ID. */
export declare function parse(
  input: string,
  options: IdArgumentsGrammarOptions & {
    startRule: "trace" | "tracePath" | "replay";
  },
): IdArguments;
/** Parse NUL-prefixed arguments that list a project's or a trace's items. */
export declare function parse(
  input: string,
  options: IdArgumentsGrammarOptions & { startRule: "traceOrProject" },
): TraceOrProjectArguments;
