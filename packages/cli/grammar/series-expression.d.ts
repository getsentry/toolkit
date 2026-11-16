// Types of the parser generated from series-expression.pegjs. The generator
// copies this file to src/generated/series-expression-grammar.d.ts.

/** A transformation a series can take, at most once. */
export type TransformationKind = "fill" | "smooth";

/** A widget series as typed: its aggregate and the transformations on it. */
export type SeriesSyntax = {
  /** The aggregate, trimmed but otherwise as typed (`p95:span.duration`). */
  readonly aggregate: string;
  /**
   * Transformations in the order Sentry applies them, innermost call first,
   * as Sentry stores them (`fill(linear)`, `smooth(ema,7)`).
   */
  readonly transformations: readonly string[];
  /** `#<n>`: which of several equal aggregates, counting from 1. */
  readonly occurrence?: number;
};

/**
 * What goes where the word being completed stops, and the transformations
 * around it, outermost first. For an argument, `frames` are the ones around
 * the transformation the argument belongs to.
 */
export type SeriesCompletionContext = {
  /** Offset where the part being typed begins. */
  readonly start: number;
  readonly frames: readonly TransformationKind[];
} & (
  | { readonly kind: "aggregate" | "fill-mode" | "smooth-method" | "factor" }
  | { readonly kind: "window"; readonly method: "sma" | "ema" | "asap" }
);

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: { start: { offset: number; line: number; column: number } };
}

/**
 * Parse a whole series. Throws {@link SyntaxError} for malformed input.
 * With `partial`, parse the start of one being typed instead.
 */
export declare function parse(input: string): SeriesSyntax;
export declare function parse(
  input: string,
  options: { partial: true },
): SeriesCompletionContext;
