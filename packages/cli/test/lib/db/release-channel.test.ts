/**
 * Release Channel Storage Tests
 */

import { describe, expect, test } from "vitest";
import {
  getReleaseChannel,
  parseReleaseChannel,
  setReleaseChannel,
} from "../../../src/lib/db/release-channel.js";
import {
  clearVersionCheckCache,
  getVersionCheckInfo,
  setVersionCheckInfo,
} from "../../../src/lib/db/version-check.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("test-release-channel-");

describe("getReleaseChannel", () => {
  test("returns 'stable' when nothing is stored", () => {
    expect(getReleaseChannel()).toBe("stable");
  });

  test("returns stored channel after set", () => {
    setReleaseChannel("nightly");
    expect(getReleaseChannel()).toBe("nightly");
  });

  test("returns 'stable' after explicitly setting stable", () => {
    setReleaseChannel("nightly");
    setReleaseChannel("stable");
    expect(getReleaseChannel()).toBe("stable");
  });
});

describe("setReleaseChannel", () => {
  test("persists 'nightly'", () => {
    setReleaseChannel("nightly");
    expect(getReleaseChannel()).toBe("nightly");
  });

  test("persists 'stable'", () => {
    setReleaseChannel("stable");
    expect(getReleaseChannel()).toBe("stable");
  });

  test("overwrites previous channel", () => {
    setReleaseChannel("nightly");
    setReleaseChannel("stable");
    expect(getReleaseChannel()).toBe("stable");

    setReleaseChannel("nightly");
    expect(getReleaseChannel()).toBe("nightly");
  });
});

describe("parseReleaseChannel", () => {
  test("accepts 'stable'", () => {
    expect(parseReleaseChannel("stable")).toBe("stable");
  });

  test("accepts 'nightly'", () => {
    expect(parseReleaseChannel("nightly")).toBe("nightly");
  });

  test("is case-insensitive", () => {
    expect(parseReleaseChannel("STABLE")).toBe("stable");
    expect(parseReleaseChannel("Nightly")).toBe("nightly");
    expect(parseReleaseChannel("NIGHTLY")).toBe("nightly");
  });

  test("throws on unrecognized value", () => {
    expect(() => parseReleaseChannel("beta")).toThrow(
      "Invalid channel: beta. Must be one of: stable, nightly"
    );
  });

  test("throws on empty string", () => {
    expect(() => parseReleaseChannel("")).toThrow();
  });
});

describe("clearVersionCheckCache", () => {
  test("clears cached lastChecked and latestVersion", () => {
    setVersionCheckInfo("1.0.0");
    const before = getVersionCheckInfo();
    expect(before.lastChecked).not.toBeNull();
    expect(before.latestVersion).toBe("1.0.0");

    clearVersionCheckCache();

    const after = getVersionCheckInfo();
    expect(after.lastChecked).toBeNull();
    expect(after.latestVersion).toBeNull();
  });

  test("is idempotent (no error on double-clear)", () => {
    clearVersionCheckCache();
    expect(() => clearVersionCheckCache()).not.toThrow();
    const info = getVersionCheckInfo();
    expect(info.lastChecked).toBeNull();
    expect(info.latestVersion).toBeNull();
  });
});

describe("setReleaseChannel — cache-clearing side effect", () => {
  test("clears version check cache when channel changes", () => {
    setVersionCheckInfo("1.0.0");
    expect(getVersionCheckInfo().latestVersion).toBe("1.0.0");

    // Switching from default "stable" to "nightly" should clear the cache
    setReleaseChannel("nightly");

    const info = getVersionCheckInfo();
    expect(info.lastChecked).toBeNull();
    expect(info.latestVersion).toBeNull();
  });

  test("does not clear cache when channel is unchanged", () => {
    setVersionCheckInfo("2.0.0");
    expect(getVersionCheckInfo().latestVersion).toBe("2.0.0");

    // Setting same channel again — cache should remain intact
    setReleaseChannel("stable"); // default is stable, so this is unchanged
    setReleaseChannel("stable"); // second set: now stored=stable, setting=stable → no change

    expect(getVersionCheckInfo().latestVersion).toBe("2.0.0");
  });
});
