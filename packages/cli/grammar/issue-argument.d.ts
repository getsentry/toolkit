// Types of the parser generated from issue-argument.pegjs. The generator
// copies this file to src/generated/issue-argument-grammar.d.ts.

/** What the caller decides for the grammar. See `parseIssueArgument()`. */
export type IssueArgumentGrammarOptions = {
  /** Whether `value` is an `@` selector, such as `@latest`. */
  isSelector: (value: string) => boolean;
};

/** Why an issue argument is malformed. */
export type IssueSyntaxError =
  /** `<org>/` without an ID */
  | "missing-id"
  /** `<org>/<project>/<id>` with an empty project or ID */
  | "missing-project-or-id"
  /** `<org>/-<suffix>` */
  | "slash-before-suffix"
  /** `-<suffix>` */
  | "missing-project"
  /** `<project>-` */
  | "missing-suffix";

/**
 * The parts of an issue argument, as typed: neither validated nor
 * normalized.
 */
export type IssueSyntax =
  | {
      readonly form: "selector";
      readonly org?: string;
      readonly selector: string;
    }
  /** `[<prefix>]#<fragment>`, split at the first `#` */
  | {
      readonly form: "hash";
      readonly prefix: string;
      readonly fragment: string;
    }
  | { readonly form: "numeric"; readonly id: string }
  /** `<project>:<id>` */
  | {
      readonly form: "project-id";
      readonly project: string;
      readonly id: string;
    }
  /** `[/]<project>-<suffix>` */
  | {
      readonly form: "short-id";
      readonly project: string;
      readonly suffix: string;
    }
  /** `[/]<suffix>` */
  | { readonly form: "suffix"; readonly suffix: string }
  /** `<org>/<numeric-id>` or `<org>/<project>/<numeric-id>` */
  | { readonly form: "org-numeric"; readonly org: string; readonly id: string }
  /** `<org>/<project>/<id>` */
  | {
      readonly form: "org-project-id";
      readonly org: string;
      readonly project: string;
      readonly id: string;
    }
  /** `<org>/<project>-<suffix>` */
  | {
      readonly form: "org-short-id";
      readonly org: string;
      readonly project: string;
      readonly suffix: string;
    }
  /** `<org>/<suffix>` */
  | {
      readonly form: "org-suffix";
      readonly org: string;
      readonly suffix: string;
    }
  | { readonly form: "invalid"; readonly reason: IssueSyntaxError };

export declare class SyntaxError extends Error {
  expected: unknown;
  found: string | null;
  location: unknown;
}

/** Split one trimmed, non-empty issue argument that is not a URL. */
export declare function parse(
  input: string,
  options: IssueArgumentGrammarOptions,
): IssueSyntax;
