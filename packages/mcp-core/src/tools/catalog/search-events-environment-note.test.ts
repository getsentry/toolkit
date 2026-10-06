import { describe, expect, it } from "vitest";
import {
  collectRequestedEnvironments,
  formatUnknownEnvironmentNote,
} from "../support/search-events/search";

describe("collectRequestedEnvironments", () => {
  it("collects from the separate environment field (string and array)", () => {
    expect(collectRequestedEnvironments("production", "")).toEqual([
      "production",
    ]);
    expect(collectRequestedEnvironments(["prod", "staging"], "")).toEqual([
      "prod",
      "staging",
    ]);
    expect(collectRequestedEnvironments(null, "")).toEqual([]);
  });

  it("collects environment tokens from the query string (the route Sentry doesn't validate)", () => {
    expect(collectRequestedEnvironments(null, "environment:qa")).toEqual([
      "qa",
    ]);
    expect(
      collectRequestedEnvironments(null, "level:error environment:staging"),
    ).toEqual(["staging"]);
    expect(
      collectRequestedEnvironments(null, "environment:[prod,dev]"),
    ).toEqual(["prod", "dev"]);
    // IN-list with spaces after commas (official syntax) — tokenizer splits it,
    // so it must be rejoined rather than parsed as garbage.
    expect(
      collectRequestedEnvironments(null, "environment:[prod, dev] level:error"),
    ).toEqual(["prod", "dev"]);
    expect(collectRequestedEnvironments(null, 'environment:"qa eu"')).toEqual([
      "qa eu",
    ]);
  });

  it("merges the field and the query token", () => {
    expect(
      collectRequestedEnvironments("production", "environment:qa"),
    ).toEqual(["production", "qa"]);
  });

  it("ignores dotted keys and quoted text that aren't real environment filters", () => {
    // `deployment.environment` is a different (OTel) field, not the env filter.
    expect(
      collectRequestedEnvironments(null, "deployment.environment:prod"),
    ).toEqual([]);
    // `environment:` inside a quoted value (e.g. a message) is not a filter.
    expect(
      collectRequestedEnvironments(null, 'message:"environment:foo"'),
    ).toEqual([]);
    // A real environment filter alongside those is still collected.
    expect(
      collectRequestedEnvironments(
        null,
        'deployment.environment:prod environment:qa message:"environment:bar"',
      ),
    ).toEqual(["qa"]);
  });
});

describe("formatUnknownEnvironmentNote", () => {
  it("names the unknown env and lists the available ones", () => {
    const note = formatUnknownEnvironmentNote(
      ["qa"],
      ["production", "staging", "development"],
    );
    expect(note).toContain("`qa`");
    expect(note).toContain("not found");
    expect(note).toContain("`production`");
    expect(note).toContain("`staging`");
    expect(note).toContain("Re-run");
  });

  it("caps the available list and reports the total", () => {
    const many = Array.from({ length: 80 }, (_, i) => `env-${i}`);
    const note = formatUnknownEnvironmentNote(["qa", "qa"], many);
    expect(note).toContain("(80 total)");
    expect(note).not.toContain("`env-79`");
    // Deduped unknowns.
    expect(note.match(/`qa`/g)?.length).toBe(1);
  });
});
