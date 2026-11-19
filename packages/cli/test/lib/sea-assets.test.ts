import { describe, expect, test, vi } from "vitest";

const seaModule = vi.hoisted(() => ({
  load: (_id: string): unknown => {
    throw new Error("node:sea unavailable");
  },
}));

vi.mock("node:module", () => ({
  createRequire: () => (id: string) => seaModule.load(id),
}));

const { getSeaRawAsset } = await import("../../src/lib/sea-assets.js");

describe("getSeaRawAsset", () => {
  test("propagates an embedded asset read failure", () => {
    seaModule.load = () => ({
      isSea: () => true,
      getRawAsset: () => {
        throw new Error("embedded asset is missing");
      },
    });

    expect(() => getSeaRawAsset("dist-build/missing.bin")).toThrow(
      "embedded asset is missing",
    );
  });
});
