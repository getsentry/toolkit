import { describe, expect, it } from "vitest";
import { SentryApiService } from "../../../api-client";
import { buildSystemPromptWithEnvironments } from "./agent";

describe("buildSystemPromptWithEnvironments", () => {
  it("inlines a small list of real environment names", () => {
    const out = buildSystemPromptWithEnvironments("BASE", [
      "production",
      "dev",
    ]);
    expect(out).toContain("BASE");
    expect(out).toContain('"production"');
    expect(out).toContain('"dev"');
  });

  it("does not dump the full list for very large orgs", () => {
    const many = Array.from({ length: 250 }, (_, i) => `env-${i}`);
    const out = buildSystemPromptWithEnvironments("BASE", many);
    expect(out).not.toContain('"env-0"');
  });
});

describe("SentryApiService.listEnvironments", () => {
  const apiService = new SentryApiService({ accessToken: "test-token" });

  it("returns the organization's environments", async () => {
    const envs = await apiService.listEnvironments({
      organizationSlug: "sentry-mcp-evals",
    });
    expect(envs.map((e) => e.name)).toEqual(["production", "development"]);
  });
});
