import { describe, expect, it } from "vitest";
import { ParamOrganizationSlug, ParamPeriod, ParamPlatform } from "./schema";

describe("ParamPeriod", () => {
  it.each(["30m", "1h", "24h", "7d", "2w"])("accepts %s", (period) => {
    expect(ParamPeriod.parse(period)).toBe(period);
  });

  it.each(["1mo", "last hour", "1.5h"])("rejects %s", (period) => {
    expect(ParamPeriod.safeParse(period).success).toBe(false);
  });
});

describe("ParamOrganizationSlug", () => {
  it.each([undefined, null])("explains how to recover a %s slug", (value) => {
    const result = ParamOrganizationSlug.safeParse(value);

    expect(result.error?.issues[0]?.message).toBe(
      "Required. Call `find_organizations()` to list your organizations, then retry with `organizationSlug` set to one of their slugs.",
    );
  });

  it("keeps the type message for non-string slugs", () => {
    const result = ParamOrganizationSlug.safeParse(42);

    expect(result.error?.issues[0]?.message).toBe(
      "Invalid input: expected string, received number",
    );
  });
});

describe("ParamPlatform", () => {
  // Values agents sent to create_project in production that Sentry rejected
  // with `{"platform":["Invalid platform"]}`.
  it.each([
    ["cocoa", "apple"],
    ["cocoa-ios", "apple-ios"],
    ["react", "javascript-react"],
    ["csharp", "dotnet"],
    ["javascript-cloudflare", "node-cloudflare-workers"],
    ["javascript-cloudflare-workers", "node-cloudflare-workers"],
  ])("maps rejected platform %s to %s", (platform, expected) => {
    expect(ParamPlatform.parse(platform)).toBe(expected);
  });

  it.each(["javascript-react", "apple-ios", "dotnet", "python-litestar"])(
    "keeps the Sentry platform ID %s",
    (platform) => {
      expect(ParamPlatform.parse(platform)).toBe(platform);
    },
  );
});
