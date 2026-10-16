/**
 * Integration List Command Tests
 *
 * The org-list framework is covered by repo/team list tests; these pin the
 * integration-specific wiring: API functions, columns, and JSON fields.
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { listCommand } from "../../../src/commands/integration/list.js";

vi.mock("../../../src/lib/api-client.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/api-client.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as apiClient from "../../../src/lib/api-client.js";
import { DEFAULT_SENTRY_URL } from "../../../src/lib/constants.js";

vi.mock("../../../src/lib/db/pagination.js", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("../../../src/lib/db/pagination.js")>();
  return Object.fromEntries(
    Object.entries(actual).map(([k, v]) => [
      k,
      typeof v === "function" ? vi.fn(v) : v,
    ]),
  );
});

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for vi.mocked access
import * as paginationDb from "../../../src/lib/db/pagination.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import type { SentryIntegration } from "../../../src/types/sentry.js";

const sampleIntegrations: SentryIntegration[] = [
  {
    id: "101",
    name: "getsentry",
    domainName: "github.com/getsentry",
    provider: { key: "github", name: "GitHub" },
    status: "active",
    organizationIntegrationStatus: "active",
    externalId: "555",
  },
  {
    id: "102",
    name: "Sentry",
    domainName: "sentry.slack.com",
    provider: { key: "slack", name: "Slack" },
    status: "active",
    organizationIntegrationStatus: "pending_deletion",
    externalId: "T0001",
  },
];

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
  };
}

describe("integration list", () => {
  const listPaginatedSpy = vi.mocked(apiClient.listIntegrationsPaginated);
  const listSpy = vi.mocked(apiClient.listIntegrations);

  beforeEach(() => {
    vi.mocked(paginationDb.advancePaginationState).mockReturnValue(undefined);
    vi.mocked(paginationDb.hasPreviousPage).mockReturnValue(false);
    setOrgRegion("my-org", DEFAULT_SENTRY_URL);
  });

  afterEach(() => {
    listPaginatedSpy.mockReset();
    listSpy.mockReset();
    vi.mocked(paginationDb.advancePaginationState).mockReset();
    vi.mocked(paginationDb.hasPreviousPage).mockReset();
  });

  test("org-all JSON includes integration fields and pagination", async () => {
    listPaginatedSpy.mockResolvedValue({
      data: sampleIntegrations,
      nextCursor: "0:25:0",
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { limit: 25, json: true }, "my-org/");

    const parsed = JSON.parse(stdoutWrite.mock.calls.map((c) => c[0]).join(""));
    expect(parsed).toHaveProperty("hasMore", true);
    expect(parsed).toHaveProperty("nextCursor", "0:25:0");
    expect(parsed.data).toHaveLength(2);
    expect(parsed.data[0]).toMatchObject({
      id: "101",
      provider: { key: "github" },
      organizationIntegrationStatus: "active",
    });
  });

  test("human output shows provider, ID, and per-org status", async () => {
    listPaginatedSpy.mockResolvedValue({
      data: sampleIntegrations,
      nextCursor: undefined,
    });

    const { context, stdoutWrite } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { limit: 25, json: false }, "my-org/");

    const output = stdoutWrite.mock.calls.map((c) => c[0]).join("");
    expect(output).toContain("GitHub");
    expect(output).toContain("Slack");
    expect(output).toContain("101");
    expect(output).toContain("pending_deletion");
  });

  test("explicit org lists that org's integrations", async () => {
    listSpy.mockResolvedValue(sampleIntegrations);

    const { context } = createMockContext();
    const func = await listCommand.loader();
    await func.call(context, { limit: 30, json: true }, "my-org/my-project");

    expect(listSpy).toHaveBeenCalledWith("my-org");
  });
});
