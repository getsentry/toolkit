/**
 * `sdk.run()` rejects when the command fails, including a failure that
 * Stricli records only in the process's exit code.
 */

import { afterEach, beforeEach, describe, expect, test } from "vitest";
import createSentrySDK from "../../src/index.js";
import { mockFetch, useTestConfigDir } from "../helpers.js";

describe("sdk.run() failures", () => {
  useTestConfigDir("sdk-run-failure-");
  let originalFetch: typeof fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = mockFetch(async () =>
      Response.json({ detail: "Not found" }, { status: 404 }),
    );
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test("rejects when the command fails", async () => {
    const sdk = createSentrySDK({
      token: `sntryu_${"a".repeat(64)}`,
      org: "acme",
    });
    await expect(sdk.run("issue", "view", "200")).rejects.toThrow();
  });
});
