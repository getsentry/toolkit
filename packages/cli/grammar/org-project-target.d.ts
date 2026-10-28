// Types of the parser generated from org-project-target.pegjs. The generator
// copies this file to src/generated/org-project-target-grammar.d.ts and
// rewrites relative imports to resolve from there.

import type {
  ParsedNameFilter,
  ParsedOrgProject,
} from "../src/lib/arg-parsing.js";

/**
 * Hooks the target grammar calls for character-level validation, so its
 * errors match the rest of the CLI. See `parseOrgProjectArg()`.
 */
export type OrgProjectTargetGrammarOptions = {
  /** Accept `<org>/<project>,<project>` lists. */
  multi?: boolean;
  /**
   * Whether the rest of `[<org>/]<rest>` is a name filter (a glob) rather
   * than a project. List commands that filter by name pass it.
   */
  isNameFilter?: (value: string) => boolean;
  /** Throw when `value` is not a valid slug. */
  checkSlug: (value: string, label: string) => void;
  /** Throw when `value` starts with `@`. */
  rejectAt: (value: string, label: string) => void;
  /** Throw a validation error. */
  invalid: (message: string, field?: string) => never;
  startRule?: "target";
};

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: unknown;
}

/** Parse a non-empty target that is not a URL. */
export declare function parse(
  input: string,
  options: OrgProjectTargetGrammarOptions & { isNameFilter?: undefined },
): Exclude<ParsedOrgProject, { type: "auto-detect" }>;
/** Parse a non-empty list target that is not a URL; globs are name filters. */
export declare function parse(
  input: string,
  options: OrgProjectTargetGrammarOptions & {
    isNameFilter: (value: string) => boolean;
  },
): Exclude<ParsedOrgProject, { type: "auto-detect" }> | ParsedNameFilter;
