/**
 * Tests for the generated command/API references.
 *
 * `script/generate-command-api.ts` reads each request's query object
 * statically. Keys wrapped in a call such as `omitUndefined({...})` are
 * invisible to it, so the fixed `dataset` and `query` values must stay plain
 * properties of the object literal. These tests catch a refactor that hides
 * them.
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "vitest";
import type { ApiReference } from "../../src/lib/api-schema.js";

const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

function references(command: string): ApiReference[] {
  const generated: unknown = JSON.parse(
    readFileSync(join(pkgRoot, "src/generated/command-api.json"), "utf8"),
  );
  if (typeof generated !== "object" || generated === null) {
    throw new Error("command-api.json is not an object");
  }
  const entries: unknown = Reflect.get(generated, command);
  if (!Array.isArray(entries)) {
    throw new Error(`command-api.json has no entry for ${command}`);
  }
  return entries.filter(
    (entry): entry is ApiReference =>
      typeof entry === "object" && entry !== null && "fn" in entry,
  );
}

const context = (query: string) =>
  `Known query context: ${query}. The command may add filters or requests.`;

describe("command API references", () => {
  test.each([
    [
      "sentry alert metrics list",
      "listOrganizationDetectors",
      "query=type:metric_issue",
    ],
    ["sentry log list", "listOrganizationEvents", "dataset=logs"],
    ["sentry span list", "listOrganizationEvents", "dataset=spans"],
    [
      "sentry trace list",
      "listOrganizationEvents",
      "dataset=spans, query=is_transaction:true",
    ],
  ])("%s records the fixed query context", (command, fn, query) => {
    expect(references(command)).toContainEqual({ fn, note: context(query) });
  });
});
