/**
 * The scope tests run on `test/fixtures/project-scope-operations.json`, the
 * `x-sentry-project-scope` declarations they expect from Sentry. Once the
 * installed `@sentry/api` carries them, every one must be in the catalog,
 * or the tests prove rules the CLI doesn't have.
 */

import { existsSync, readFileSync } from "node:fs";
import { describe, expect, test } from "vitest";
import fixture from "../fixtures/project-scope-operations.json";

const GENERATED = new URL(
  "../../src/generated/project-scope-operations.json",
  import.meta.url,
);
const generated: unknown[] = existsSync(GENERATED)
  ? JSON.parse(readFileSync(GENERATED, "utf8"))
  : [];

describe("the scope rules the tests expect", () => {
  test.skipIf(generated.length === 0)(
    "are all in the @sentry/api catalog",
    () => {
      expect(generated).toEqual(expect.arrayContaining(fixture));
    },
  );
});
