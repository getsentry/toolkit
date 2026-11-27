import { beforeEach, describe, expect, it, vi } from "vitest";

const clackMocks = vi.hoisted(() => ({ warn: vi.fn() }));

vi.mock("@clack/prompts", () => ({
  log: { warn: clackMocks.warn },
}));

import {
  isNodeVersionSupportedBySdkV11,
  warnIfNodeVersionUnsupportedBySdkV11,
} from "../../../../src/lib/wizard/utils/node-version.js";

describe("isNodeVersionSupportedBySdkV11", () => {
  it.each([
    "v20.19.0",
    "v20.20.2",
    "20.19.5",
    "v22.12.0",
    "v22.23.2",
    "v23.2.0",
    "v24.0.0",
    "v26.8.1",
    // Node.js 21 is EOL but inside the documented `>=20.19.0 <22.0.0` range
    "v21.7.0",
  ])("returns true for %s", (version) => {
    expect(isNodeVersionSupportedBySdkV11(version)).toBe(true);
  });

  it.each(["v18.20.6", "v20.18.3", "v22.11.0", "v23.1.0", "16.20.2"])(
    "returns false for %s",
    (version) => {
      expect(isNodeVersionSupportedBySdkV11(version)).toBe(false);
    },
  );

  it.each(["", "not-a-version"])(
    "treats an unparseable version (%s) as supported",
    (version) => {
      expect(isNodeVersionSupportedBySdkV11(version)).toBe(true);
    },
  );

  it("defaults to the running Node.js version", () => {
    expect(isNodeVersionSupportedBySdkV11()).toBe(
      isNodeVersionSupportedBySdkV11(process.version),
    );
  });
});

describe("warnIfNodeVersionUnsupportedBySdkV11", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("warns on an unsupported version and names it", () => {
    warnIfNodeVersionUnsupportedBySdkV11("v18.20.6");

    expect(clackMocks.warn).toHaveBeenCalledTimes(1);
    expect(clackMocks.warn.mock.calls[0]?.[0]).toContain("v18.20.6");
    expect(clackMocks.warn.mock.calls[0]?.[0]).toContain("20.19.0");
  });

  it("stays silent on a supported version", () => {
    warnIfNodeVersionUnsupportedBySdkV11("v22.18.0");

    expect(clackMocks.warn).not.toHaveBeenCalled();
  });
});
