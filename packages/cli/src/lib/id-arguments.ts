/**
 * Positionals that name IDs and the org/project to look them up in, parsed
 * by `grammar/id-arguments.pegjs`.
 *
 * Every command that takes trace, span, replay, log, event, dashboard,
 * issue, conversation, or integration IDs shares one syntax, whatever the
 * kind of ID:
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
 * Some kinds also name items without an ID ({@link IdKind.names}): a
 * dashboard by its title, an issue by search text. Then what is not an ID
 * is a name, after the target or alone: `<org>/ My Dashboard`. Kinds
 * without names say where to search instead ({@link IdKind.search}).
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
import { looksLikeIssueShortId } from "./arg-parsing.js";
import { ContextError, ValidationError } from "./errors.js";
import {
  isSpanId,
  tryNormalizeHexId,
  validateHexId,
  validateSpanId,
} from "./hex-id.js";
import { looksLikeHexIdFragment } from "./hex-id-recovery.js";
import { validateResourceId } from "./input-validation.js";
import { isIssueIdentifier, parseIssueIdentifier } from "./issue-identifier.js";
import { type ParsedSentryUrl, parseSentryUrl } from "./sentry-url-parser.js";
import { isAllDigits, shellQuote } from "./utils.js";

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
  /**
   * Items of this kind have names, such as a dashboard's title or issue
   * search text: what is not, and may not be, an ID ({@link IdKind.mayBeId})
   * is a name, for the command to look up. A name may hold spaces and
   * slashes, and after a target, takes the rest of the arguments, joined
   * with spaces (an unquoted title).
   */
  readonly names?: boolean;
  /**
   * An ID is a whole token with its own syntax for the org, project, and
   * URL (issue short IDs): the grammar does not split a path off it, and
   * {@link IdKind.validate} takes it apart. Only for kinds with names.
   */
  readonly wholeIds?: boolean;
  /** A bare word before the ID names an org, not a project */
  readonly orgScoped?: boolean;
  /**
   * For a kind without names: the list command that searches for items.
   * {@link IdKind.validate} fails on text with a hint to search for it,
   * instead of how the ID is malformed.
   */
  readonly search?: {
    /** The list command, e.g. `"sentry trace list"`, which takes `--query` */
    readonly command: string;
    /** Whether `value`, not an ID, reads as text rather than a broken ID */
    readonly isText: (value: string) => boolean;
  };
};

/** Characters a hex ID may have, once lowercased and without dashes */
const HEX_ID_CHARS_RE = /^[0-9a-f]*$/;

/**
 * Whether `value` reads as search text rather than a hex ID: it has letters
 * past `f`, and is no flag (`--h`), placeholder (`<trace-id>`), or path,
 * which the hex ID errors explain better.
 */
function isHexSearchText(value: string): boolean {
  return (
    !(value.startsWith("-") || /[<>{}/]/.test(value)) &&
    !HEX_ID_CHARS_RE.test(value.toLowerCase().replace(/-/g, ""))
  );
}

/**
 * Whether `value` is issue search text: words with spaces, which no issue
 * identifier has. Anything else (no space, a control character, or a URL)
 * is a malformed identifier, rejected with its own message.
 */
function isIssueSearchText(value: string): boolean {
  return (
    value.includes(" ") &&
    !CONTROL_CHAR_RE.test(value) &&
    parseSentryUrl(value) === null &&
    !URL_RE.test(value)
  );
}

const CONTROL_CHAR_RE = /\p{Cc}/u;
const URL_RE = /^https?:\/\//i;

/**
 * An opaque ID: anything a slug may hold in a URL path, so no slash, `?`,
 * `#`, `%`, whitespace, or control character
 */
const OPAQUE_ID_RE = /^[^/?#%\s\p{Cc}]+$/u;

function hexKind(
  label: string,
  listCommand: string | null,
  fromUrl: IdKind["fromUrl"],
  urlExample?: string,
): IdKind {
  const lower = label.charAt(0).toLowerCase() + label.slice(1);
  const kind: IdKind = {
    label,
    isId: (value) => tryNormalizeHexId(value) !== undefined,
    mayBeId: looksLikeHexIdFragment,
    validate: (value) => validateHexId(value, lower),
    fromUrl,
    urlExample,
  };
  return listCommand ? searchable(kind, listCommand) : kind;
}

/**
 * A kind without names whose IDs fail, when given text instead, with where
 * to search for it rather than how the ID is malformed: `validate()` throws
 * that, so a command that recovers malformed IDs first still gets it last.
 */
function searchable(kind: IdKind, listCommand: string): IdKind {
  const search = { command: listCommand, isText: isHexSearchText };
  return {
    ...kind,
    search,
    validate: (value) => {
      if (!(kind.isId(value) || kind.mayBeId(value)) && search.isText(value)) {
        const label = kind.label.charAt(0).toLowerCase() + kind.label.slice(1);
        throw new ValidationError(
          `Not a ${label}: "${value}". To search, try \`${search.command} --query ${shellQuote(value)}\`.\n\n` +
            `If it names a project, pass the ${label} after it: <org>/<project> <${label}>`,
          "positional",
        );
      }
      return kind.validate(value);
    },
  };
}

/**
 * Issue IDs: a numeric ID, short ID (`CLI-G`, `G`), selector (`@latest`),
 * or issue URL, which carry their own org and project; words with spaces
 * are a search. `parseIssueIdentifier()` takes an ID apart.
 */
const ISSUE_KIND: IdKind & {
  /**
   * The form of an issue ID that reads as one where another kind's ID may
   * go too, as in `event view`: a short ID in its usual uppercase
   * (`CLI-G`), which no project slug is, or a numeric ID; `null` for
   * anything else
   */
  readonly distinctForm: (value: string) => "short-id" | "numeric" | null;
} = {
  label: "Issue ID",
  isId: (value) => isIssueIdentifier(value),
  mayBeId: (value) => !isIssueSearchText(value),
  validate: (value) => {
    parseIssueIdentifier(value);
    return value;
  },
  // Issue URLs are whole IDs: `parseIssueIdentifier()` reads them
  fromUrl: () => undefined,
  names: true,
  wholeIds: true,
  distinctForm: (value) => {
    if (looksLikeIssueShortId(value)) {
      return "short-id";
    }
    return isAllDigits(value) ? "numeric" : null;
  },
};

/** The kinds of ID commands take. Commands use these instead of their own. */
export const ID_KINDS = {
  trace: hexKind("Trace ID", "sentry trace list", (url) => url.traceId),
  // `event list` searches an issue's events, so there is no search to hint
  event: hexKind("Event ID", null, (url) => url.eventId),
  // Replays are looked up in an org, so a replay URL needs one
  replay: hexKind(
    "Replay ID",
    "sentry replay list",
    (url) => (url.org ? url.replayId : undefined),
    "https://sentry.io/organizations/{org}/explore/replays/{replayId}/",
  ),
  log: hexKind("Log ID", "sentry log list", () => undefined),
  span: searchable(
    {
      label: "Span ID",
      isId: isSpanId,
      mayBeId: looksLikeHexIdFragment,
      validate: validateSpanId,
      fromUrl: () => undefined,
    },
    "sentry span list",
  ),
  // A numeric ID, or a title: `Latency/p95`, `Top 10`, or unquoted words
  // after the org
  dashboard: {
    label: "Dashboard ID",
    isId: isAllDigits,
    mayBeId: () => false,
    validate: (value) => value,
    fromUrl: (url) => url.dashboardId,
    names: true,
    orgScoped: true,
  },
  issue: ISSUE_KIND,
  // Agent conversation IDs are opaque (`gen_ai.conversation.id`), and
  // looked up in an org. Anything after a target is one, for `validate` to
  // reject when malformed.
  conversation: {
    label: "Conversation ID",
    isId: (value) => OPAQUE_ID_RE.test(value),
    mayBeId: () => true,
    validate: (value) => {
      validateResourceId(value, "conversation ID");
      return value;
    },
    fromUrl: () => undefined,
    orgScoped: true,
  },
  // Integrations are org-scoped and named by their numeric ID only
  integration: {
    label: "Integration ID",
    isId: isAllDigits,
    mayBeId: () => true,
    validate: (value) => {
      if (!isAllDigits(value)) {
        throw new ValidationError(
          `Invalid integration ID '${value}'. Use the numeric ID from 'sentry integration list'.`,
          "integration-id",
        );
      }
      return value;
    },
    fromUrl: () => undefined,
    orgScoped: true,
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
  /**
   * The name, for a kind with names, when the arguments name no ID; `ids`
   * is then empty
   */
  readonly name?: string;
  /**
   * When `target` was a bare word before `name` (`My Dashboard`), the whole
   * input read as one name instead, for a command that falls back to it
   * once it knows the word names nothing
   */
  readonly nameWithTarget?: string;
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
  // A name may hold spaces, so IDs are not split off at them
  const tokens = tokenize(args, kind.names ? null : kind.isId);
  const syntax = parse(tokens.map((token) => `\0${token}`).join(""), {
    optional,
    isId: kind.isId,
    mayBeId: kind.mayBeId,
    idUrl: (value) => idUrl(value, kind),
    names: kind.names ?? false,
    wholeIds: kind.wholeIds ?? false,
  });
  const warnings: string[] = [];

  const pathTarget = (prefix: string, text: string) =>
    pathTargetArg(prefix, text, { usageHint, needsProject });
  let target = syntax.path
    ? pathTarget(syntax.target ?? "", syntax.ids[0]?.text ?? "")
    : separateTarget(syntax.target, kind);

  if (syntax.name !== undefined) {
    return {
      target,
      ids: [],
      baseUrl: syntax.baseUrl,
      warnings,
      name: syntax.name,
      ...(syntax.bareTarget && {
        nameWithTarget: `${syntax.target} ${syntax.name}`,
      }),
    };
  }
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

/**
 * A target that is its own argument: a bare word names an org for an
 * org-scoped kind (`my-org` is `my-org/`), and a project otherwise.
 */
function separateTarget(
  target: string | undefined,
  kind: IdKind,
): string | undefined {
  if (target === undefined || !kind.orgScoped || target.includes("/")) {
    return target;
  }
  return `${target}/`;
}

/** Line breaks between IDs pasted into one argument */
const LINE_BREAK_RE = /\r?\n/;
const WHITESPACE_RE = /\s+/;

/**
 * The grammar's tokens: every line of every argument, trimmed, and with the
 * IDs at the end of a line split off at spaces. A line's first word stays
 * whole, so a project's display name keeps its spaces. Empty lines are
 * dropped: an empty target means none.
 *
 * @param isId - Whether a word is an ID to split off; `null` for a kind
 *   with names, which may hold spaces, so lines stay whole and as typed
 */
function tokenize(
  args: readonly string[],
  isId: ((value: string) => boolean) | null,
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
      if (!isId) {
        const token = line.trim();
        if (token) {
          tokens.push(token);
        }
        continue;
      }
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
