import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ServerContext } from "../../types";
import { resolveRegionUrlForOrganization } from "./resolve-region-url";

const { getOrganization } = vi.hoisted(() => ({
  getOrganization: vi.fn(),
}));

vi.mock("./api", () => ({
  apiServiceFromContext: vi.fn(() => ({
    getOrganization,
  })),
}));

function createContext(
  constraints: ServerContext["constraints"] = {},
): ServerContext {
  return {
    accessToken: "test-access-token",
    constraints,
  };
}

function deferred<Value>() {
  let resolve!: (value: Value) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe("resolveRegionUrlForOrganization", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns an explicit regionUrl without fetching the organization", async () => {
    const result = await resolveRegionUrlForOrganization({
      context: createContext(),
      organizationSlug: "my-org",
      regionUrl: " https://de.sentry.io ",
    });

    expect(result).toBe("https://de.sentry.io");
    expect(getOrganization).not.toHaveBeenCalled();
  });

  it("returns the scoped regionUrl from context without fetching the organization", async () => {
    const result = await resolveRegionUrlForOrganization({
      context: createContext({
        organizationSlug: "my-org",
        regionUrl: " https://us.sentry.io ",
      }),
      organizationSlug: "my-org",
      regionUrl: null,
    });

    expect(result).toBe("https://us.sentry.io");
    expect(getOrganization).not.toHaveBeenCalled();
  });

  it("caches fetched region URLs per context", async () => {
    getOrganization.mockResolvedValue({
      links: {
        regionUrl: " https://us.sentry.io ",
      },
    });

    const context = createContext();

    const first = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: "my-org",
      regionUrl: null,
    });
    const second = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: "my-org",
      regionUrl: null,
    });

    expect(first).toBe("https://us.sentry.io");
    expect(second).toBe("https://us.sentry.io");
    expect(getOrganization).toHaveBeenCalledOnce();
    expect(getOrganization).toHaveBeenCalledWith("my-org");
  });

  it("deduplicates concurrent lookups for the same organization and context", async () => {
    const pending = deferred<{
      links: { regionUrl: string };
    }>();
    getOrganization.mockReturnValue(pending.promise);
    const context = createContext();

    const results = Promise.all(
      Array.from({ length: 3 }, () =>
        resolveRegionUrlForOrganization({
          context,
          organizationSlug: " my-org ",
        }),
      ),
    );

    pending.resolve({ links: { regionUrl: " https://de.sentry.io " } });
    expect(await results).toEqual(Array(3).fill("https://de.sentry.io"));
    expect(getOrganization).toHaveBeenCalledOnce();
    expect(getOrganization).toHaveBeenCalledWith("my-org");
  });

  it("retries a failed concurrent lookup instead of caching its fallback", async () => {
    const pending = deferred<never>();
    getOrganization.mockReturnValueOnce(pending.promise).mockResolvedValue({
      links: { regionUrl: "https://us.sentry.io" },
    });
    const context = createContext();
    const first = resolveRegionUrlForOrganization({
      context,
      organizationSlug: "my-org",
    });
    const second = resolveRegionUrlForOrganization({
      context,
      organizationSlug: "my-org",
    });

    pending.reject(new Error("Temporary lookup failure"));
    expect(await Promise.all([first, second])).toEqual([null, null]);
    expect(
      await resolveRegionUrlForOrganization({
        context,
        organizationSlug: "my-org",
      }),
    ).toBe("https://us.sentry.io");
    expect(getOrganization).toHaveBeenCalledTimes(2);
  });

  it("does not reuse a region discovered with another credential or source host", async () => {
    getOrganization
      .mockResolvedValueOnce({ links: { regionUrl: "https://us.sentry.io" } })
      .mockResolvedValueOnce({ links: { regionUrl: "https://de.sentry.io" } })
      .mockResolvedValueOnce({
        links: { regionUrl: "https://sentry.example" },
      });
    const context = createContext();
    const lookup = () =>
      resolveRegionUrlForOrganization({ context, organizationSlug: "my-org" });

    expect(await lookup()).toBe("https://us.sentry.io");
    context.accessToken = "rotated-access-token";
    expect(await lookup()).toBe("https://de.sentry.io");
    context.sentryHost = "sentry.example";
    expect(await lookup()).toBe("https://sentry.example");
    expect(getOrganization).toHaveBeenCalledTimes(3);
  });

  it("keeps a new credential's in-flight lookup separate from the old one", async () => {
    const oldLookup = deferred<{
      links: { regionUrl: string };
    }>();
    const newLookup = deferred<{
      links: { regionUrl: string };
    }>();
    getOrganization
      .mockReturnValueOnce(oldLookup.promise)
      .mockReturnValueOnce(newLookup.promise);
    const context = createContext();
    const lookup = () =>
      resolveRegionUrlForOrganization({ context, organizationSlug: "my-org" });

    const oldResult = lookup();
    await vi.waitFor(() => expect(getOrganization).toHaveBeenCalledOnce());
    context.accessToken = "rotated-access-token";
    const newResult = lookup();
    newLookup.resolve({ links: { regionUrl: "https://de.sentry.io" } });
    expect(await newResult).toBe("https://de.sentry.io");
    oldLookup.resolve({ links: { regionUrl: "https://us.sentry.io" } });
    expect(await oldResult).toBeNull();
    expect(await lookup()).toBe("https://de.sentry.io");
    expect(getOrganization).toHaveBeenCalledTimes(2);
  });

  it("caches empty region URLs after a successful organization lookup", async () => {
    getOrganization.mockResolvedValue({
      links: {
        regionUrl: "",
      },
    });

    const context = createContext();

    const first = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: "self-hosted-org",
      regionUrl: null,
    });
    const second = await resolveRegionUrlForOrganization({
      context,
      organizationSlug: "self-hosted-org",
      regionUrl: null,
    });

    expect(first).toBeNull();
    expect(second).toBeNull();
    expect(getOrganization).toHaveBeenCalledOnce();
    expect(getOrganization).toHaveBeenCalledWith("self-hosted-org");
  });
});
