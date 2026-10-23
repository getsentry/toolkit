/**
 * Documented forms of the `<org>/<project>` target positional, keyed by the
 * `parseOrgProjectArg()` result type each form produces.
 *
 * The target syntax tables in the commands overview and CONTRIBUTING.md are
 * generated from this map (`script/generate-docs-sections.ts`). The key set is
 * checked by TypeScript, so a new parse result type cannot ship undocumented,
 * and the generator parses every example and fails when the parser returns a
 * different type, so the table cannot disagree with the parser.
 */

import type { ProjectSpecificationType } from "./arg-parsing.js";

/** A `parseOrgProjectArg()` result type. */
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
  /** What the form selects (Markdown). */
  readonly meaning: string;
};

/** Target forms by parse result type, in documentation order. */
export const TARGET_FORMS = {
  "auto-detect": [
    {
      syntax: "_(omitted)_",
      example: undefined,
      meaning:
        "Auto-detect the org and project from config, DSNs, or the directory name",
    },
  ],
  explicit: [
    {
      syntax: "`<org>/<project>`",
      example: "my-org/my-project",
      meaning: "That project in that organization",
    },
    {
      syntax: "`<org>/<project>,<project>`",
      example: "my-org/web,api",
      multi: true,
      meaning:
        "Several projects in the same organization (commands that accept several projects)",
    },
  ],
  "org-all": [
    {
      syntax: "`<org>/`",
      example: "my-org/",
      meaning: "The whole organization",
    },
  ],
  "project-search": [
    {
      syntax: "`<name>`",
      example: "my-project",
      meaning:
        "A project named `<name>` in any accessible organization. If no project matches, commands that accept an organization use the organization named `<name>`. When both exist, the project wins: add the trailing slash (`<name>/`) to select the organization",
    },
  ],
} as const satisfies Record<SpecificationType, readonly TargetForm[]>;
