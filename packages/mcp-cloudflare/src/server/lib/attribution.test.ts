import { describe, expect, it } from "vitest";
import {
  PLUGIN_NAME_ATTRIBUTE,
  PLUGIN_NAME_HEADER,
  PLUGIN_VERSION_ATTRIBUTE,
  PLUGIN_VERSION_HEADER,
  UTM_SOURCE_ATTRIBUTE,
  UTM_SOURCE_HEADER,
  resolvePluginAttributesFromRequest,
  resolvePluginName,
  resolvePluginVersion,
  resolveUtmSource,
  resolveUtmSourceFromRequest,
  resolveUtmSourceFromUrl,
} from "./attribution";

describe("UTM_SOURCE_ATTRIBUTE", () => {
  it("is app.utm_source", () => {
    expect(UTM_SOURCE_ATTRIBUTE).toBe("app.utm_source");
  });
});

describe("UTM_SOURCE_HEADER", () => {
  it("is X-Sentry-Utm-Source", () => {
    expect(UTM_SOURCE_HEADER).toBe("X-Sentry-Utm-Source");
  });
});

describe("resolveUtmSource", () => {
  it.each([
    // Known server-side values
    ["plugin", "plugin"],
    // Any other non-empty value buckets to "other"
    ["unknown-source", "other"],
    // Client-side values are intentionally not known server-side
    ["sentry-mcp-settings-docs-btn", "other"],
    // Absent / empty → null (do not set the attribute)
    ["", null],
    [null, null],
    [undefined, null],
  ])("maps %s → %s", (input, expected) => {
    expect(resolveUtmSource(input)).toBe(expected);
  });
});

describe("resolveUtmSourceFromUrl", () => {
  it("reads utm_source from URL search params", () => {
    const url = new URL("https://mcp.sentry.dev/mcp?utm_source=plugin");
    expect(resolveUtmSourceFromUrl(url)).toBe("plugin");
  });

  it("returns null when utm_source is absent", () => {
    const url = new URL("https://mcp.sentry.dev/mcp");
    expect(resolveUtmSourceFromUrl(url)).toBeNull();
  });

  it("buckets unknown values to other", () => {
    const url = new URL("https://mcp.sentry.dev/mcp?utm_source=something-new");
    expect(resolveUtmSourceFromUrl(url)).toBe("other");
  });
});

describe("resolveUtmSourceFromRequest", () => {
  it("prefers the attribution header over the query param", () => {
    const request = new Request(
      "https://mcp.sentry.dev/mcp?utm_source=other-value",
      {
        headers: { [UTM_SOURCE_HEADER]: "plugin" },
      },
    );
    expect(resolveUtmSourceFromRequest(request)).toBe("plugin");
  });

  it("falls back to the query param when the header is absent", () => {
    const request = new Request("https://mcp.sentry.dev/mcp?utm_source=plugin");
    expect(resolveUtmSourceFromRequest(request)).toBe("plugin");
  });

  it("returns null when neither header nor query is present", () => {
    const request = new Request("https://mcp.sentry.dev/mcp");
    expect(resolveUtmSourceFromRequest(request)).toBeNull();
  });

  it("buckets unknown header values to other", () => {
    const request = new Request("https://mcp.sentry.dev/mcp", {
      headers: { [UTM_SOURCE_HEADER]: "something-new" },
    });
    expect(resolveUtmSourceFromRequest(request)).toBe("other");
  });

  it("accepts a pre-parsed URL for the query fallback", () => {
    const url = new URL("https://mcp.sentry.dev/mcp?utm_source=plugin");
    const request = new Request("https://mcp.sentry.dev/mcp");
    expect(resolveUtmSourceFromRequest(request, url)).toBe("plugin");
  });
});

describe("resolvePluginName", () => {
  it.each([
    ["claude", "claude"],
    ["cursor", "cursor"],
    ["codex", "codex"],
    ["copilot", "copilot"],
    ["grok", "grok"],
    ["agent-plugin", "agent-plugin"],
    ["Claude", "other"],
    ["something-new", "other"],
    ["", null],
    [null, null],
    [undefined, null],
  ])("maps %s → %s", (input, expected) => {
    expect(resolvePluginName(input)).toBe(expected);
  });
});

describe("resolvePluginVersion", () => {
  it.each([
    ["1.4.5", "1.4.5"],
    ["10.0.1234", "10.0.1234"],
    ["1.4.6-dev.14.gdeadbee", "dev"],
    ["1.4.6-rc.1", "dev"],
    ["12345.0.0", "other"],
    ["v1.4.5", "other"],
    ["1.4", "other"],
    ["1.4.5+build", "other"],
    ["latest", "other"],
    ["", null],
    [null, null],
    [undefined, null],
  ])("maps %s → %s", (input, expected) => {
    expect(resolvePluginVersion(input)).toBe(expected);
  });
});

describe("resolvePluginAttributesFromRequest", () => {
  it("resolves both plugin headers", () => {
    const request = new Request("https://mcp.sentry.dev/mcp", {
      headers: {
        [PLUGIN_NAME_HEADER]: "claude",
        [PLUGIN_VERSION_HEADER]: "1.4.5",
      },
    });
    expect(resolvePluginAttributesFromRequest(request)).toEqual({
      [PLUGIN_NAME_ATTRIBUTE]: "claude",
      [PLUGIN_VERSION_ATTRIBUTE]: "1.4.5",
    });
  });

  it("omits absent headers", () => {
    const request = new Request("https://mcp.sentry.dev/mcp", {
      headers: { [PLUGIN_NAME_HEADER]: "codex" },
    });
    expect(resolvePluginAttributesFromRequest(request)).toEqual({
      [PLUGIN_NAME_ATTRIBUTE]: "codex",
    });
    expect(
      resolvePluginAttributesFromRequest(
        new Request("https://mcp.sentry.dev/mcp"),
      ),
    ).toEqual({});
  });
});
