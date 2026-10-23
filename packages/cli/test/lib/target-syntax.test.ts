/**
 * The generated target syntax docs come from TARGET_FORMS. These tests keep
 * that table honest against the real parser.
 */

import { describe, expect, test } from "vitest";
import {
  ProjectSpecificationType,
  parseOrgProjectArg,
} from "../../src/lib/arg-parsing.js";
import { TARGET_FORMS } from "../../src/lib/target-syntax.js";

describe("TARGET_FORMS", () => {
  test.each(TARGET_FORMS.map((form) => [form.syntax, form] as const))(
    "%s example parses to the documented type",
    (_syntax, form) => {
      const parsed = parseOrgProjectArg(form.example, { multi: form.multi });
      expect(parsed.type).toBe(form.type);
    },
  );

  test("documents every parse result type", () => {
    const documented = new Set(TARGET_FORMS.map((form) => form.type));
    const missing = Object.values(ProjectSpecificationType).filter(
      (type) => !documented.has(type),
    );
    expect(missing).toEqual([]);
  });
});
