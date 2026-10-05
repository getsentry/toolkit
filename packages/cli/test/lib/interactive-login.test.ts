/**
 * Tests for interactive login flow.
 *
 * - buildDeviceFlowDisplay: extracted display logic (pure function)
 * - runInteractiveLogin: full OAuth device flow with mocked dependencies
 *
 * Uses SENTRY_PLAIN_OUTPUT=1 to get predictable raw markdown output
 * (no ANSI codes) for string assertions.
 */

import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
  vi,
} from "vitest";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as browser from "../../src/lib/browser.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as clipboard from "../../src/lib/clipboard.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbInstance from "../../src/lib/db/index.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as dbUser from "../../src/lib/db/user.js";
import {
  buildDeviceFlowDisplay,
  runInteractiveLogin,
} from "../../src/lib/interactive-login.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as oauth from "../../src/lib/oauth.js";
// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as qrcode from "../../src/lib/qrcode.js";
import type { TokenResponse } from "../../src/types/index.js";

// Force plain output for predictable string matching
let origPlain: string | undefined;
beforeAll(() => {
  origPlain = process.env.SENTRY_PLAIN_OUTPUT;
  process.env.SENTRY_PLAIN_OUTPUT = "1";
});
afterAll(() => {
  if (origPlain === undefined) {
    delete process.env.SENTRY_PLAIN_OUTPUT;
  } else {
    process.env.SENTRY_PLAIN_OUTPUT = origPlain;
  }
});

describe("buildDeviceFlowDisplay", () => {
  const CODE = "ABCD-EFGH";
  const URL = "https://sentry.io/auth/device/?user_code=ABCD-EFGH";

  test("includes complete URL as plain text for copy-paste", () => {
    const lines = buildDeviceFlowDisplay(CODE, URL, true, false);
    const joined = lines.join("\n");
    // URL must be literal (no markdown escaping) so it's copyable
    expect(joined).toContain(URL);
  });

  test("preserves underscores in URLs (no markdown escaping)", () => {
    const urlWithUnderscores =
      "https://self_hosted.example.com/auth/device/?user_code=AB_CD";
    const lines = buildDeviceFlowDisplay(
      "AB_CD",
      urlWithUnderscores,
      true,
      false
    );
    const joined = lines.join("\n");
    // URL must not be escaped — underscores stay as-is for copy-paste
    expect(joined).toContain(urlWithUnderscores);
    expect(joined).not.toContain("\\_");
  });

  test("includes user code in output", () => {
    const lines = buildDeviceFlowDisplay(CODE, URL, true, false);
    const joined = lines.join("\n");
    // Plain mode strips backtick code spans — check for bare code
    expect(joined).toContain(CODE);
  });

  test("omits copy hint when browser opened", () => {
    const lines = buildDeviceFlowDisplay(CODE, URL, true, true);
    const joined = lines.join("\n");
    expect(joined).not.toContain("Copy the URL above");
    expect(joined).not.toContain("to copy URL");
  });

  test("shows copy hint when browser did not open (TTY)", () => {
    const lines = buildDeviceFlowDisplay(CODE, URL, false, true);
    const joined = lines.join("\n");
    expect(joined).toContain("Copy the URL above to sign in.");
    expect(joined).toContain("to copy URL");
  });

  test("shows copy hint without keyboard shortcut in non-TTY", () => {
    const lines = buildDeviceFlowDisplay(CODE, URL, false, false);
    const joined = lines.join("\n");
    expect(joined).toContain("Copy the URL above to sign in.");
    expect(joined).not.toContain("to copy URL");
  });

  test("returns more lines when browser did not open", () => {
    const withBrowser = buildDeviceFlowDisplay(CODE, URL, true, false);
    const withoutBrowser = buildDeviceFlowDisplay(CODE, URL, false, false);
    // Without browser: extra copy-hint line + blank line
    expect(withoutBrowser.length).toBeGreaterThan(withBrowser.length);
  });
});

describe("runInteractiveLogin", () => {
  let performDeviceFlowSpy: ReturnType<typeof spyOn>;
  let completeOAuthFlowSpy: ReturnType<typeof spyOn>;
  let openBrowserSpy: ReturnType<typeof spyOn>;
  let generateQRCodeSpy: ReturnType<typeof spyOn>;
  let setupCopyKeyListenerSpy: ReturnType<typeof spyOn>;
  let setUserInfoSpy: ReturnType<typeof spyOn>;
  let getDbPathSpy: ReturnType<typeof spyOn>;

  /** Helper to build a mock TokenResponse with a user whose fields may be null. */
  function makeTokenResponse(user?: {
    id: string;
    name: string | null;
    email: string | null;
  }): TokenResponse {
    return {
      access_token: "sntrys_test_token",
      token_type: "Bearer",
      expires_in: 3600,
      ...(user ? { user } : {}),
    };
  }

  beforeEach(() => {
    completeOAuthFlowSpy = vi
      .spyOn(oauth, "completeOAuthFlow")
      .mockResolvedValue(undefined);
    openBrowserSpy = vi.spyOn(browser, "openBrowser").mockResolvedValue(false);
    generateQRCodeSpy = vi
      .spyOn(qrcode, "generateQRCode")
      .mockResolvedValue("[QR]");
    setupCopyKeyListenerSpy = vi
      .spyOn(clipboard, "setupCopyKeyListener")
      .mockReturnValue(() => {
        // no-op cleanup
      });
    setUserInfoSpy = vi.spyOn(dbUser, "setUserInfo").mockReturnValue(undefined);
    getDbPathSpy = vi.spyOn(dbInstance, "getDbPath").mockReturnValue("/tmp/db");
  });

  afterEach(() => {
    performDeviceFlowSpy.mockRestore();
    completeOAuthFlowSpy.mockRestore();
    openBrowserSpy.mockRestore();
    generateQRCodeSpy.mockRestore();
    setupCopyKeyListenerSpy.mockRestore();
    setUserInfoSpy.mockRestore();
    getDbPathSpy.mockRestore();
  });

  test("null user.name is omitted from result and stored as undefined in setUserInfo", async () => {
    performDeviceFlowSpy = vi
      .spyOn(oauth, "performDeviceFlow")
      .mockImplementation(async (callbacks) => {
        await callbacks.onUserCode(
          "ABCD",
          "https://sentry.io/auth/device/",
          "https://sentry.io/auth/device/?user_code=ABCD"
        );
        return makeTokenResponse({
          id: "48168",
          name: null,
          email: "user@example.com",
        });
      });

    const result = await runInteractiveLogin({ timeout: 1000 });

    expect(result).not.toBeNull();
    expect(result!.user).toBeDefined();
    // name must be absent from the result object (not present as undefined)
    expect("name" in result!.user!).toBe(false);
    expect(result!.user!.email).toBe("user@example.com");
    expect(result!.user!.id).toBe("48168");

    expect(setUserInfoSpy).toHaveBeenCalledWith({
      userId: "48168",
      email: "user@example.com",
      name: undefined,
    });
  });

  test("null user.email is omitted from result", async () => {
    performDeviceFlowSpy = vi
      .spyOn(oauth, "performDeviceFlow")
      .mockImplementation(async (callbacks) => {
        await callbacks.onUserCode(
          "EFGH",
          "https://sentry.io/auth/device/",
          "https://sentry.io/auth/device/?user_code=EFGH"
        );
        return makeTokenResponse({
          id: "123",
          name: "Jane Doe",
          email: null,
        });
      });

    const result = await runInteractiveLogin({ timeout: 1000 });

    expect(result).not.toBeNull();
    expect(result!.user!.name).toBe("Jane Doe");
    // email must be absent from the result object
    expect("email" in result!.user!).toBe(false);

    expect(setUserInfoSpy).toHaveBeenCalledWith({
      userId: "123",
      email: undefined,
      name: "Jane Doe",
    });
  });

  test("no user in token response: result.user is undefined, setUserInfo not called", async () => {
    performDeviceFlowSpy = vi
      .spyOn(oauth, "performDeviceFlow")
      .mockImplementation(async (callbacks) => {
        await callbacks.onUserCode(
          "WXYZ",
          "https://sentry.io/auth/device/",
          "https://sentry.io/auth/device/?user_code=WXYZ"
        );
        return makeTokenResponse(); // no user
      });

    const result = await runInteractiveLogin({ timeout: 1000 });

    expect(result).not.toBeNull();
    expect(result!.user).toBeUndefined();
    expect(setUserInfoSpy).not.toHaveBeenCalled();
  });

  test("forwards an explicit scope string to performDeviceFlow", async () => {
    performDeviceFlowSpy = vi
      .spyOn(oauth, "performDeviceFlow")
      .mockImplementation(async (callbacks) => {
        await callbacks.onUserCode(
          "SCOP",
          "https://sentry.io/auth/device/",
          "https://sentry.io/auth/device/?user_code=SCOP"
        );
        return makeTokenResponse();
      });

    await runInteractiveLogin({
      timeout: 1000,
      scope: "project:read org:read",
    });

    expect(performDeviceFlowSpy).toHaveBeenCalledWith(
      expect.any(Object),
      1000,
      "project:read org:read"
    );
  });

  test("forwards undefined scope when none is provided", async () => {
    performDeviceFlowSpy = vi
      .spyOn(oauth, "performDeviceFlow")
      .mockImplementation(async (callbacks) => {
        await callbacks.onUserCode(
          "NONE",
          "https://sentry.io/auth/device/",
          "https://sentry.io/auth/device/?user_code=NONE"
        );
        return makeTokenResponse();
      });

    await runInteractiveLogin({ timeout: 1000 });

    expect(performDeviceFlowSpy).toHaveBeenCalledWith(
      expect.any(Object),
      1000,
      undefined
    );
  });
});
