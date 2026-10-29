/**
 * Positionals that name IDs and the org/project to look them up in, parsed
 * by `grammar/id-arguments.pegjs`.
 *
 * Every command that takes trace, span, replay, log, or event IDs shares one
 * syntax, whatever the kind of ID:
 *
 * - `<id>`: the org/project is auto-detected
 * - `<org>/<id>` and `<org>/<project>/<id>`, like a URL (`<project>/<id>`
 *   for commands that need a project)
 * - `<target> <id>`, where `<target>` is any org/project target
 * - `<id> <org>/<project>`, reversed, with a warning
 * - a Sentry URL with the ID in it
 *
 * and, for commands that take several, more IDs after any of those, each
 * repeating the target or not. An argument may hold several lines, and IDs
 * after a space: `"<org>/<project> <id>"` is two arguments.
 *
 * The command picks an {@link ID_KINDS} entry, which says what its IDs look
 * like, how to validate them, and which part of a URL holds one. The grammar
 * never guesses a kind from the shape of an ID: trace, replay, and log IDs
 * all look alike. `sentry-cli/no-ad-hoc-id-arguments` keeps
 * commands from parsing these forms on their own.
 *
 * Parsing has no side effects: a pasted URL's server comes back as `baseUrl`
 * and anything to tell the user as `warnings`, for the caller to apply.
 */

import { parse } from "../generated/id-arguments-grammar.js";
import { ContextError, ValidationError } from "./errors.js";
import {
  isSpanId,
  tryNormalizeHexId,
  validateHexId,
  validateSpanId,
} from "./hex-id.js";
import { looksLikeHexIdFragment } from "./hex-id-recovery.js";
import { type ParsedSentryUrl, parseSentryUrl } from "./sentry-url-parser.js";

/** A kind of ID a command takes. */
export type IdKind = {
  /** Name in messages, e.g. `"Trace ID"` */
  readonly label: string;
  /** Whether `value` is an ID of this kind (after normalizing) */
  readonly isId: (value: string) => boolean;
  /**
   * Whether `value`, not an ID, still looks like a malformed one, so
   * `<org>/<value>` names an ID to report or recover, not a project
   */
  readonly mayBeId: (value: string) => boolean;
  /**
   * Normalize an ID.
   *
   * @throws {ValidationError} When `value` is not one
   */
  readonly validate: (value: string) => string;
  /** The ID of this kind in a parsed Sentry URL, if it has one */
  readonly fromUrl: (url: ParsedSentryUrl) => string | undefined;
  /** A URL with this kind of ID, suggested when a pasted URL has none */
  readonly urlExample?: string;
};

function hexKind(
  label: string,
  fromUrl: IdKind["fromUrl"],
  urlExample?: string,
): IdKind {
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  return {
    label,
    isId: (value) => tryNormalizeHexId(value) !== undefined,
    mayBeId: looksLikeHexIdFragment,
    validate: (value) => validateHexId(value, lower),
    fromUrl,
    urlExample,
  };
}

/** The kinds of ID commands take. Commands use these instead of their own. */
export const ID_KINDS = {
  trace: hexKind("Trace ID", (url) => url.traceId),
  event: hexKind("Event ID", (url) => url.eventId),
  // Replays are looked up in an org, so a replay URL needs one
  replay: hexKind(
    "Replay ID",
    (url) => (url.org ? url.replayId : undefined),
    "https://sentry.io/organizations/{org}/explore/replays/{replayId}/",
  ),
  log: hexKind("Log ID", () => undefined),
  span: {
    label: "Span ID",
    isId: isSpanId,
    mayBeId: looksLikeHexIdFragment,
    validate: validateSpanId,
    fromUrl: () => undefined,
  },
} as const satisfies Record<string, IdKind>;

/** How a command takes its IDs. */
export type IdArgumentsOptions = {
  /** Usage shown in errors and warnings */
  readonly usageHint: string;
  /** Whether the command takes more than one ID */
  readonly multiple?: boolean;
  /**
   * Whether the command may get no ID, like a list of a project's items or
   * a trace's. Then a lone argument that does not end in an ID is a target.
   */
  readonly optional?: boolean;
  /**
   * Whether the command needs a project, not just an org. Then `<x>/<id>`
   * names project `<x>` (found in any org), like `<x> <id>` does.
   */
  readonly needsProject?: boolean;
  /**
   * Whether to validate the IDs. Commands that recover malformed IDs once
   * they know the target turn it off, and validate later.
   */
  readonly validate?: boolean;
};

/** ID arguments, parsed. */
export type IdArguments = {
  /**
   * The org/project target argument, for `parseOrgProjectInput`;
   * `undefined` to auto-detect. `<x>/<id>` gives `<x>/` (the org), or `<x>`
   * when the command needs a project.
   */
  readonly target?: string;
  /** The IDs: normalized, or as typed when not validated */
  readonly ids: readonly string[];
  /** Server of a pasted Sentry URL, for `applySentryUrlContext` */
  readonly baseUrl?: string;
  /** Warnings to log, such as for ignored or reversed arguments */
  readonly warnings: readonly string[];
};

/**
 * Parse ID arguments.
 *
 * @throws {ContextError} When the IDs are missing and not optional
 * @throws {ValidationError} When an ID is invalid (unless not validated), a
 *   path has an empty org or project, or IDs name different targets
 */
export function parseIdArguments(
  args: readonly string[],
  kind: IdKind,
  options: IdArgumentsOptions,
): IdArguments {
  const {
    usageHint,
    multiple = false,
    optional = false,
    needsProject = false,
  } = options;
  const tokens = tokenize(args, kind.isId);
  const syntax = parse(tokens.map((token) => `\0${token}`).join(""), {
    optional,
    isId: kind.isId,
    mayBeId: kind.mayBeId,
    idUrl: (value) => idUrl(value, kind),
  });
  const warnings: string[] = [];

  const pathTarget = (prefix: string, text: string) =>
    pathTargetArg(prefix, text, { usageHint, needsProject });
  let target = syntax.path
    ? pathTarget(syntax.target ?? "", syntax.ids[0]?.text ?? "")
    : syntax.target;
  const typed: { text: string; id: string }[] = [];
  for (const token of syntax.ids) {
    if (token.target) {
      const own = pathTarget(token.target, token.text);
      if (target === undefined) {
        target = own;
      } else if (own !== target && token.target !== target) {
        throw new ValidationError(
          `${kind.label}s reference different projects ('${target}' and '${own}'). ` +
            `Pass IDs from one project per call: ${usageHint}`,
          "positional",
        );
      }
    }
    if (token.id !== "") {
      typed.push(token);
    }
  }

  if (syntax.reversed && target !== undefined && typed[0]) {
    warnings.push(
      `Arguments appear reversed. Interpreting as: ${target} ${typed[0].text}`,
    );
  }

  if (typed.length === 0) {
    if (optional) {
      return { target, ids: [], baseUrl: syntax.baseUrl, warnings };
    }
    throw new ContextError(
      kind.label,
      usageHint,
      missingSuggestions(tokens, kind),
    );
  }

  let chosen = typed;
  if (!multiple && typed.length > 1) {
    // Keep the first real ID; the rest are extra
    const first = typed.find((token) => kind.isId(token.id)) ?? typed[0];
    chosen = first ? [first] : [];
    const extra = typed.filter((token) => token !== first);
    warnings.push(
      `Extra arguments ignored: ${extra.map((token) => token.text).join(" ")}. Expected: ${usageHint}`,
    );
  }

  const validate = options.validate ?? true;
  return {
    target,
    ids: chosen.map((token) => (validate ? kind.validate(token.id) : token.id)),
    baseUrl: syntax.baseUrl,
    warnings,
  };
}

/** Arguments that name exactly one ID, parsed. */
export type IdArgument = Omit<IdArguments, "ids"> & {
  /** The ID: normalized, or as typed when not validated */
  readonly id: string;
};

/**
 * Parse arguments that name one ID, like {@link parseIdArguments} for a
 * command that takes neither several IDs nor none.
 */
export function parseIdArgument(
  args: readonly string[],
  kind: IdKind,
  options: Omit<IdArgumentsOptions, "multiple" | "optional">,
): IdArgument {
  const { ids, ...rest } = parseIdArguments(args, kind, options);
  const [id] = ids;
  if (id === undefined) {
    throw new ContextError(kind.label, options.usageHint);
  }
  return { ...rest, id };
}

/** Line breaks between IDs pasted into one argument */
const LINE_BREAK_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;

/**
 * The grammar's tokens: every line of every argument, trimmed, and with the
 * IDs at the end of a line split off at spaces. A line's first word stays
 * whole, so a project's display name keeps its spaces. Empty lines are
 * dropped: an empty target means none.
 */
function tokenize(
  args: readonly string[],
  isId: (value: string) => boolean,
): string[] {
  const tokens: string[] = [];
  for (const arg of args) {
    if (arg.includes("\0")) {
      throw new ValidationError(
        "Arguments cannot contain NUL characters.",
        "positional",
      );
    }
    for (const line of arg.split(LINE_BREAK_RE)) {
      const words = line.trim().split(WHITESPACE_RE);
      const ids: string[] = [];
      while (words.length > 1 && isId(words.at(-1) ?? "")) {
        ids.unshift(words.pop() ?? "");
      }
      tokens.push(...[words.join(" "), ...ids].filter((token) => token));
    }
  }
  return tokens;
}

/**
 * The target argument for the `[<org>/[<project>/]]` before an ID in a path
 * (`text`): `<org>/<project>` with both; with one, `<org>/`, or the project
 * when the command needs one.
 *
 * @throws {ValidationError} When the org or the project is empty
 */
function pathTargetArg(
  prefix: string,
  text: string,
  options: { usageHint: string; needsProject: boolean },
): string {
  const { usageHint, needsProject } = options;
  const slash = prefix.indexOf("/");
  if (slash === -1) {
    return needsProject ? prefix : `${prefix}/`;
  }
  if (slash === 0 || slash === prefix.length - 1) {
    throw new ValidationError(
      `Invalid format: "${text}" needs an organization and a project before the ID.\n\nUsage: ${usageHint}`,
      "positional",
    );
  }
  return prefix;
}

/** The ID of `kind` in a Sentry URL, or `null` for anything else. */
function idUrl(value: string, kind: IdKind) {
  const url = parseSentryUrl(value);
  const id = url ? kind.fromUrl(url) : undefined;
  if (!(url && id)) {
    return null;
  }
  return {
    id,
    ...(url.org && { org: url.org }),
    baseUrl: url.baseUrl,
  };
}

function missingSuggestions(tokens: readonly string[], kind: IdKind): string[] {
  const pastedUrl = tokens.some((token) => parseSentryUrl(token) !== null);
  return pastedUrl && kind.urlExample
    ? [
        `Pass a ${kind.label.replace(" ID", "").toLowerCase()} URL: ${kind.urlExample}`,
      ]
    : [];
}
