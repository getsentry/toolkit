// Types of the parser generated from id-arguments.pegjs. The generator
// copies this file to src/generated/id-arguments-grammar.d.ts and rewrites
// relative imports to resolve from there.

/** An ID a Sentry URL carries, with the URL's org and server. */
export type IdUrl = {
  readonly id: string;
  readonly org?: string;
  readonly baseUrl?: string;
};

/**
 * What the command parses: the grammar itself does not know any kind of ID.
 * See `parseIdArguments()`.
 */
export type IdArgumentsGrammarOptions = {
  /** Whether the arguments may name no ID (then a lone token is a target). */
  optional: boolean;
  /** Whether `value` is an ID of the kind the command takes. */
  isId: (value: string) => boolean;
  /** The ID in a Sentry URL, or `null` for anything else. */
  idUrl: (value: string) => IdUrl | null;
};

/** A token that names an ID, maybe after a target: `[<target>/]<id>`. */
export type IdToken = {
  /** The token as typed */
  readonly text: string;
  /** What came before the ID's slash, if anything */
  readonly target?: string;
  /** The ID, not validated */
  readonly id: string;
};

/** Which tokens are the target and which are IDs. */
export type IdArgumentsSyntax = {
  /** The target, as typed: a separate argument, a path prefix, or `<org>/` */
  readonly target?: string;
  /** Whether `target` came before the first ID in one path */
  readonly path?: boolean;
  readonly ids: readonly IdToken[];
  /** Server of a pasted Sentry URL */
  readonly baseUrl?: string;
  /** Whether the ID came before the target */
  readonly reversed?: boolean;
};

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: unknown;
}

/** Parse NUL-prefixed tokens into a target and IDs. */
export declare function parse(
  input: string,
  options: IdArgumentsGrammarOptions,
): IdArgumentsSyntax;
