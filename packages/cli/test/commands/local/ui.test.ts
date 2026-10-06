import { describe, expect, test, vi } from "vitest";
import {
  assertLoopbackHostForUi,
  buildLocalUiUrl,
  formatLocalServerUrl,
  getLocalUiBaseUrl,
  openLocalUi,
} from "../../../src/commands/local/ui.js";
import { openBrowser } from "../../../src/lib/browser.js";

vi.mock("../../../src/lib/browser.js", () => ({
  openBrowser: vi.fn(),
}));

describe("local UI URLs", () => {
  test("uses the Vite UI in development", () => {
    expect(getLocalUiBaseUrl("development")).toBe("http://localhost:5173");
  });

  test("uses the hosted UI outside development", () => {
    expect(getLocalUiBaseUrl("production")).toBe("https://local.sentry.dev");
    expect(getLocalUiBaseUrl("nightly")).toBe("https://local.sentry.dev");
  });

  test("formats IPv6 loopback URLs correctly", () => {
    expect(formatLocalServerUrl("::1", 8969)).toBe("http://[::1]:8969");
    expect(buildLocalUiUrl("http://[::1]:8969")).toBe(
      "http://localhost:5173/#stream=http%3A%2F%2F%5B%3A%3A1%5D%3A8969%2Fstream"
    );
  });

  test("refuses to send the browser to a non-loopback receiver", () => {
    expect(() => buildLocalUiUrl("http://example.com:8969")).toThrow(
      "--open requires a loopback --host"
    );
  });

  test("validates an --open host before a receiver is started", () => {
    expect(() => assertLoopbackHostForUi("0.0.0.0")).toThrow(
      "--open requires a loopback --host"
    );
  });

  test("does not fail capture when the browser cannot be opened", async () => {
    const openBrowserMock = vi.mocked(openBrowser);
    openBrowserMock.mockResolvedValueOnce(false);

    await expect(openLocalUi("http://localhost:8969")).resolves.toBeUndefined();
  });

  test("does not fail capture when browser launch rejects unexpectedly", async () => {
    const openBrowserMock = vi.mocked(openBrowser);
    openBrowserMock.mockRejectedValueOnce(new Error("browser unavailable"));

    await expect(openLocalUi("http://localhost:8969")).resolves.toBeUndefined();
  });
});
