import { describe, expect, test } from "vitest";
import { getDatabase } from "../../../src/lib/db/index.js";
import {
  getOrgByNumericId,
  getOrgRegion,
  isTrustedRegionOrigin,
  resetTrustedRegionUrlsForTesting,
  setOrgRegion,
} from "../../../src/lib/db/regions.js";
import { useTestConfigDir } from "../../helpers.js";

const SOURCE_A = "https://control-a.example.com";
const SOURCE_B = "https://control-b.example.com";
const RESPONSE_B = "https://response-b.example.com";
const REGION_A = "https://region-a.example.com";
const REGION_B = "https://region-b.example.com";
const REGION_C = "https://region-c.example.com";
const IDENTITY_A = "identity-a";
const IDENTITY_B = "identity-b";

useTestConfigDir("regions-focused-");

describe("credential and origin scoped organization regions", () => {
  test("keeps identical slugs separate by lookup origin and credential", () => {
    setOrgRegion("shared", REGION_A, SOURCE_A, SOURCE_A, IDENTITY_A);
    setOrgRegion("shared", REGION_B, SOURCE_B, SOURCE_B, IDENTITY_A);
    setOrgRegion("shared", REGION_C, SOURCE_A, SOURCE_A, IDENTITY_B);
    expect(getOrgRegion("shared", SOURCE_A, IDENTITY_A)).toBe(REGION_A);
    expect(getOrgRegion("shared", SOURCE_B, IDENTITY_A)).toBe(REGION_B);
    expect(getOrgRegion("shared", SOURCE_A, IDENTITY_B)).toBe(REGION_C);
  });

  test("keeps self-hosted installation paths without extending origin trust", () => {
    setOrgRegion(
      "subpath-org",
      `${REGION_A}/sentry/`,
      SOURCE_A,
      SOURCE_A,
      IDENTITY_A,
    );
    expect(getOrgRegion("subpath-org", SOURCE_A, IDENTITY_A)).toBe(
      `${REGION_A}/sentry`,
    );
    expect(isTrustedRegionOrigin(REGION_A, SOURCE_A, IDENTITY_A)).toBe(true);
    expect(isTrustedRegionOrigin(REGION_A, SOURCE_A, IDENTITY_B)).toBe(false);
  });

  test("retains lookup to response to region trust for only the right credential", () => {
    setOrgRegion("bridge", RESPONSE_B, SOURCE_A, SOURCE_A, IDENTITY_A);
    setOrgRegion("target", REGION_C, RESPONSE_B, SOURCE_A, IDENTITY_A);
    resetTrustedRegionUrlsForTesting();
    expect(isTrustedRegionOrigin(RESPONSE_B, SOURCE_A, IDENTITY_A)).toBe(true);
    expect(isTrustedRegionOrigin(REGION_C, RESPONSE_B, IDENTITY_A)).toBe(true);
    expect(isTrustedRegionOrigin(REGION_C, SOURCE_A, IDENTITY_A)).toBe(true);
    expect(isTrustedRegionOrigin(REGION_C, SOURCE_A, IDENTITY_B)).toBe(false);
  });

  test.each([
    "ftp://region.example.com",
    "https://user:password@region.example.com",
    "not a URL",
  ])("rejects untrusted region URL %s", (regionUrl) => {
    expect(() =>
      setOrgRegion("invalid", regionUrl, SOURCE_A, SOURCE_A, IDENTITY_A),
    ).toThrow();
  });

  test.each(["", "/", "/sentry"])(
    "treats a legacy non-absolute cached region URL %j as a cache miss (CLI-2DE)",
    (regionUrl) => {
      getDatabase()
        .query(
          "INSERT INTO org_regions (org_slug, org_id, region_url, credential_identity, source_origin, response_origin, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        )
        .run("legacy", "4242", regionUrl, IDENTITY_A, SOURCE_A, SOURCE_A, 0);
      expect(getOrgRegion("legacy", SOURCE_A, IDENTITY_A)).toBeUndefined();
      expect(getOrgByNumericId("4242", SOURCE_A, IDENTITY_A)).toBeUndefined();
    },
  );
});
