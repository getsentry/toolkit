import { afterEach, describe, expect, it, vi } from "vitest";
import { fetchSdkVersion } from "../../../../src/lib/wizard/utils/release-registry.js";

describe("fetchSdkVersion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns the version the registry lists for the SDK", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      Response.json({
        "sentry.dart.flutter": { version: "9.1.0" },
        "sentry.dart.plugin": { version: "3.0.0" },
      }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(fetchSdkVersion("sentry.dart.flutter")).resolves.toBe("9.1.0");
    expect(fetchMock).toHaveBeenCalledWith(
      "https://release-registry.services.sentry.io/sdks",
    );
  });

  it("returns undefined for an SDK the registry doesn't list", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(Response.json({})));

    await expect(fetchSdkVersion("sentry.unknown")).resolves.toBeUndefined();
  });

  it("returns undefined for an error response", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("oops", { status: 503 })),
    );

    await expect(
      fetchSdkVersion("sentry.dart.flutter"),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the registry can't be reached", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new TypeError("fetch failed")),
    );

    await expect(
      fetchSdkVersion("sentry.dart.flutter"),
    ).resolves.toBeUndefined();
  });
});
