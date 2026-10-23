/**
 * Documented forms of the `<org>/<project>` target positional.
 *
 * The target syntax tables in the commands overview and CONTRIBUTING.md are
 * generated from this list (`script/generate-docs-sections.ts`), and
 * `test/lib/target-syntax.test.ts` parses each example with
 * `parseOrgProjectArg()` to check it yields the documented type. Change the
 * parser and this list together.
 */

import type { ProjectSpecificationType } from "./arg-parsing.js";

type SpecificationType =
  (typeof ProjectSpecificationType)[keyof typeof ProjectSpecificationType];

/** One documented target form. */
export type TargetForm = {
  /** Syntax shown in the docs table (Markdown). */
  readonly syntax: string;
  /** Example value; `undefined` means the argument is omitted. */
  readonly example: string | undefined;
  /** Whether the example needs `parseOrgProjectArg(..., { multi: true })`. */
  readonly multi?: boolean;
  /** Parse result type the example must produce. */
  readonly type: SpecificationType;
  /** What the form selects (Markdown). */
  readonly meaning: string;
};

export const TARGET_FORMS: readonly TargetForm[] = [
  {
    syntax: "_(omitted)_",
    example: undefined,
    type: "auto-detect",
    meaning:
      "Auto-detect the org and project from config, DSNs, or the directory name",
  },
  {
    syntax: "`<org>/<project>`",
    example: "my-org/my-project",
    type: "explicit",
    meaning: "That project in that organization",
  },
  {
    syntax: "`<org>/<project>,<project>`",
    example: "my-org/web,api",
    multi: true,
    type: "explicit",
    meaning:
      "Several projects in the same organization (commands that accept several projects)",
  },
  {
    syntax: "`<org>/`",
    example: "my-org/",
    type: "org-all",
    meaning: "The whole organization",
  },
  {
    syntax: "`<name>`",
    example: "my-project",
    type: "project-search",
    meaning:
      "A project named `<name>` in any accessible organization. If no project matches, commands that accept an organization use the organization named `<name>`. When both exist, the project wins: add the trailing slash (`<name>/`) to select the organization",
  },
];
