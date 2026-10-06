/**
 * Release Deploy Command Tests
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { deployCommand } from "../../../src/commands/release/deploy.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as apiClient from "../../../src/lib/api-client.js";

vi.mock("../../../src/lib/resolve-target.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/resolve-target.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ])
  );
});

// biome-ignore lint/performance/noNamespaceImport: needed for spyOn mocking
import * as resolveTarget from "../../../src/lib/resolve-target.js";
import type { SentryDeploy } from "../../../src/types/index.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("release-deploy-");

const sampleDeploy: SentryDeploy = {
  id: "42",
  environment: "production",
  dateStarted: null,
  dateFinished: "2025-01-01T12:00:00Z",
  name: null,
  url: null,
};

function createMockContext(cwd = "/tmp") {
  const stdoutWrite = vi.fn(() => true);
  const stderrWrite = vi.fn(() => true);
  return {
    context: {
      stdout: { write: stdoutWrite },
      stderr: { write: stderrWrite },
      cwd,
    },
    stdoutWrite,
    stderrWrite,
  };
}

describe("release deploy", () => {
  let createRelaseDeploySpy: ReturnType<typeof spyOn>;
  let resolveOrgSpy: ReturnType<typeof spyOn>;

  beforeEach(() => {
    createRelaseDeploySpy = vi.spyOn(apiClient, "createReleaseDeploy");
    resolveOrgSpy = vi.spyOn(resolveTarget, "resolveOrg");
  });

  afterEach(() => {
    createRelaseDeploySpy.mockRestore();
    resolveOrgSpy.mockRestore();
  });

  test("creates a deploy with environment positional", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createRelaseDeploySpy.mockResolvedValue(sampleDeploy);

    const { context, stdoutWrite } = createMockContext();
    const func = await deployCommand.loader();
    await func.call(context, { json: true }, "my-org/1.0.0", "production");

    expect(createRelaseDeploySpy).toHaveBeenCalledWith("my-org", "1.0.0", {
      environment: "production",
    });
    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    const parsed = JSON.parse(output);
    expect(parsed.environment).toBe("production");
  });

  test("passes deploy name as third positional", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createRelaseDeploySpy.mockResolvedValue({
      ...sampleDeploy,
      name: "Deploy #42",
    });

    const { context } = createMockContext();
    const func = await deployCommand.loader();
    // Multi-word deploy names are passed as a single quoted positional.
    await func.call(context, { json: true }, "1.0.0", "staging", "Deploy #42");

    expect(createRelaseDeploySpy).toHaveBeenCalledWith(
      "my-org",
      "1.0.0",
      expect.objectContaining({ environment: "staging", name: "Deploy #42" })
    );
  });

  test("passes --url flag", async () => {
    resolveOrgSpy.mockResolvedValue({ org: "my-org" });
    createRelaseDeploySpy.mockResolvedValue(sampleDeploy);

    const { context } = createMockContext();
    const func = await deployCommand.loader();
    await func.call(
      context,
      { url: "https://example.com", json: true },
      "1.0.0",
      "production"
    );

    expect(createRelaseDeploySpy).toHaveBeenCalledWith(
      "my-org",
      "1.0.0",
      expect.objectContaining({
        environment: "production",
        url: "https://example.com",
      })
    );
  });

  test("throws when missing environment", async () => {
    const { context } = createMockContext();
    const func = await deployCommand.loader();

    await expect(func.call(context, { json: false }, "1.0.0")).rejects.toThrow(
      "Release version and environment"
    );
  });

  test("throws when no args provided", async () => {
    const { context } = createMockContext();
    const func = await deployCommand.loader();

    await expect(func.call(context, { json: false })).rejects.toThrow(
      "Release version and environment"
    );
  });
});
