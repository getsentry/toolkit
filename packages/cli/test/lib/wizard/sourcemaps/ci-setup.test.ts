/**
 * `setupCI` for the tools that upload with `sentry` commands: which prompts
 * it shows and which environment variables it tells the user to set in CI.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { clackMocks } = vi.hoisted(() => ({
  clackMocks: {
    select: vi.fn(),
    isCancel: vi.fn(() => false),
    log: {
      info: vi.fn(),
      step: vi.fn(),
      success: vi.fn(),
      warn: vi.fn(),
    },
  },
}));

vi.mock("@clack/prompts", () => clackMocks);

import { setupCI } from "../../../../src/lib/wizard/sourcemaps/ci.js";

let stdout: string;

beforeEach(() => {
  stdout = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk) => {
    stdout += String(chunk);
    return true;
  });
  // Every select answers "yes": using CI, added the script, configured CI
  clackMocks.select.mockResolvedValue(true);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.clearAllMocks();
});

const uploadTarget = { org: "my-org", project: "my-project" };

describe("setupCI", () => {
  it("names the auth token, org and project for Wrangler", async () => {
    await setupCI("wrangler", "sntrys_tok", uploadTarget);

    expect(stdout).toContain("SENTRY_AUTH_TOKEN=sntrys_tok");
    expect(stdout).toContain("SENTRY_ORG=my-org");
    expect(stdout).toContain("SENTRY_PROJECT=my-project");
    expect(stdout).not.toContain("SENTRY_URL");
  });

  it("adds SENTRY_URL for self-hosted Sentry", async () => {
    await setupCI("wrangler", "sntrys_tok", {
      ...uploadTarget,
      url: "https://sentry.example.com/",
    });

    expect(stdout).toContain("SENTRY_URL=https://sentry.example.com/");
  });

  it("does not ask to add the upload script to CI for Wrangler, whose post-deploy script runs it", async () => {
    await setupCI("wrangler", "sntrys_tok", uploadTarget);

    // "Using CI?" and "Configured CI?" only
    expect(clackMocks.select).toHaveBeenCalledTimes(2);
  });

  it("asks to add the upload script to CI for the generic flow", async () => {
    await setupCI("sentry-cli", "sntrys_tok", uploadTarget);

    expect(clackMocks.select).toHaveBeenCalledTimes(3);
    expect(stdout).toContain("SENTRY_ORG=my-org");
  });

  it("names only the auth token for bundler plugins", async () => {
    await setupCI("vite", "sntrys_tok", uploadTarget);

    expect(stdout).toContain("SENTRY_AUTH_TOKEN=sntrys_tok");
    expect(stdout).not.toContain("SENTRY_ORG");
  });
});
