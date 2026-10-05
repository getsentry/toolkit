import { beforeEach, describe, expect, test, vi } from "vitest";
import {
  formatConflictError,
  formatMultipleProjectsFooter,
  formatNoDsnError,
  formatResolutionError,
} from "../../../src/lib/dsn/errors.js";
import type {
  DetectedDsn,
  DsnDetectionResult,
} from "../../../src/lib/dsn/types.js";

// Mock api-client to prevent real API calls from getAccessibleProjects
const { mockListOrganizations, mockListProjects } = vi.hoisted(() => ({
  mockListOrganizations: vi.fn(() => Promise.resolve([])),
  mockListProjects: vi.fn(() => Promise.resolve([])),
}));

vi.mock("../../../src/lib/api-client.js", () => ({
  listOrganizations: mockListOrganizations,
  listProjects: mockListProjects,
  findProjectByDsnKey: vi.fn(() => Promise.resolve(null)),
}));

describe("formatConflictError", () => {
  test("formats error with two conflicting DSNs", () => {
    const result: DsnDetectionResult = {
      primary: null,
      all: [
        {
          raw: "https://abc123@o123.ingest.sentry.io/456",
          protocol: "https",
          publicKey: "abc123",
          host: "o123.ingest.sentry.io",
          projectId: "456",
          orgId: "123",
          source: "env_file",
          sourcePath: ".env",
        },
        {
          raw: "https://def456@o789.ingest.sentry.io/101112",
          protocol: "https",
          publicKey: "def456",
          host: "o789.ingest.sentry.io",
          projectId: "101112",
          orgId: "789",
          source: "code",
          sourcePath: "src/sentry.ts",
        },
      ],
      hasMultiple: true,
      fingerprint: "",
    };

    const error = formatConflictError(result);

    expect(error).toContain("Error: Multiple Sentry DSNs detected");
    expect(error).toContain("DSN 1:");
    expect(error).toContain("abc123@o123.ingest.sentry.io/456");
    expect(error).toContain("DSN 2:");
    expect(error).toContain("def456@o789.ingest.sentry.io/101112");
    expect(error).toContain("Project ID: 456");
    expect(error).toContain("Project ID: 101112");
    expect(error).toContain("sentry <command> <org>/<project>");
    expect(error).toContain("sentry config set defaults.org");
  });

  test("formats error with DSN without projectId", () => {
    const result: DsnDetectionResult = {
      primary: null,
      all: [
        {
          raw: "https://abc123@sentry.io/456",
          protocol: "https",
          publicKey: "abc123",
          host: "sentry.io",
          projectId: "456",
          source: "env",
        },
        {
          raw: "https://xyz789@sentry.io/789",
          protocol: "https",
          publicKey: "xyz789",
          host: "sentry.io",
          // No projectId on this one intentionally
          source: "code",
          sourcePath: "app.js",
        } as DetectedDsn,
      ],
      hasMultiple: true,
      fingerprint: "",
    };

    const error = formatConflictError(result);

    expect(error).toContain("DSN 1:");
    expect(error).toContain("DSN 2:");
    // First one has projectId, second doesn't
    expect(error).toContain("Project ID: 456");
  });

  test("formats error with single DSN (edge case)", () => {
    const result: DsnDetectionResult = {
      primary: null,
      all: [
        {
          raw: "https://single@o1.ingest.sentry.io/1",
          protocol: "https",
          publicKey: "single",
          host: "o1.ingest.sentry.io",
          projectId: "1",
          orgId: "1",
          source: "env",
        },
      ],
      hasMultiple: false,
      fingerprint: "",
    };

    const error = formatConflictError(result);

    expect(error).toContain("DSN 1:");
    expect(error).not.toContain("DSN 2:");
  });

  test("includes source description for each DSN", () => {
    const result: DsnDetectionResult = {
      primary: null,
      all: [
        {
          raw: "https://a@o1.ingest.sentry.io/1",
          protocol: "https",
          publicKey: "a",
          host: "o1.ingest.sentry.io",
          projectId: "1",
          orgId: "1",
          source: "env",
        },
        {
          raw: "https://b@o2.ingest.sentry.io/2",
          protocol: "https",
          publicKey: "b",
          host: "o2.ingest.sentry.io",
          projectId: "2",
          orgId: "2",
          source: "env_file",
          sourcePath: ".env.local",
        },
        {
          raw: "https://c@o3.ingest.sentry.io/3",
          protocol: "https",
          publicKey: "c",
          host: "o3.ingest.sentry.io",
          projectId: "3",
          orgId: "3",
          source: "code",
          sourcePath: "config/sentry.js",
        },
      ],
      hasMultiple: true,
      fingerprint: "",
    };

    const error = formatConflictError(result);

    expect(error).toContain("Source:");
    // env source
    expect(error).toMatch(/Source:.*SENTRY_DSN/i);
  });
});

describe("formatNoDsnError", () => {
  beforeEach(() => {
    mockListOrganizations.mockReset();
    mockListProjects.mockReset();
  });

  test("formats basic error message with search locations", async () => {
    mockListOrganizations.mockResolvedValue([]);

    const error = await formatNoDsnError("/path/to/project", false);

    expect(error).toContain("No Sentry DSN detected in /path/to/project");
    expect(error).toContain("SENTRY_DSN environment variable");
    expect(error).toContain(".env files");
    expect(error).toContain("JavaScript/TypeScript source code");
    expect(error).toContain("export SENTRY_DSN=");
    expect(error).toContain("sentry <command> <org>/<project>");
    expect(error).toContain("sentry config set defaults.org");
  });

  test("includes accessible projects when showProjects is true", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "my-org", name: "My Organization" },
    ]);
    mockListProjects.mockResolvedValue([
      { id: "10", slug: "frontend", name: "Frontend App" },
      { id: "11", slug: "backend", name: "Backend API" },
    ]);

    const error = await formatNoDsnError("/path/to/project", true);

    expect(error).toContain("Your accessible projects:");
    expect(error).toContain("my-org/frontend");
    expect(error).toContain("my-org/backend");
  });

  test("skips projects section when API fails", async () => {
    mockListOrganizations.mockRejectedValue(new Error("Not authenticated"));

    const error = await formatNoDsnError("/path/to/project", true);

    expect(error).not.toContain("Your accessible projects:");
    expect(error).toContain("No Sentry DSN detected");
  });

  test("skips projects section when no projects returned", async () => {
    mockListOrganizations.mockResolvedValue([
      { id: "1", slug: "empty-org", name: "Empty Org" },
    ]);
    mockListProjects.mockResolvedValue([]);

    const error = await formatNoDsnError("/path/to/project", true);

    expect(error).not.toContain("Your accessible projects:");
    expect(error).toContain("No Sentry DSN detected");
  });

  test("does not call API when showProjects is false", async () => {
    const error = await formatNoDsnError("/path/to/project", false);

    expect(mockListOrganizations).not.toHaveBeenCalled();
    expect(error).toContain("No Sentry DSN detected");
  });
});

describe("formatResolutionError", () => {
  test("formats error with DSN and error message", () => {
    const error = new Error("Connection timeout");
    const dsn = "https://abc123@o123.ingest.sentry.io/456";

    const formatted = formatResolutionError(error, dsn);

    expect(formatted).toContain("Error: Could not resolve project from DSN");
    expect(formatted).toContain(`DSN: ${dsn}`);
    expect(formatted).toContain("Error: Connection timeout");
    expect(formatted).toContain("You don't have access to this project");
    expect(formatted).toContain("self-hosted Sentry instance");
    expect(formatted).toContain("invalid or expired");
    expect(formatted).toContain("sentry <command> <org>/<project>");
  });

  test("formats error with access denied message", () => {
    const error = new Error("403 Forbidden");
    const dsn = "https://secret@o999.ingest.sentry.io/123";

    const formatted = formatResolutionError(error, dsn);

    expect(formatted).toContain("Error: 403 Forbidden");
    expect(formatted).toContain(`DSN: ${dsn}`);
  });
});

describe("formatMultipleProjectsFooter", () => {
  test("returns empty string for single project", () => {
    const projects = [
      {
        orgDisplay: "my-org",
        projectDisplay: "frontend",
        detectedFrom: ".env",
      },
    ];

    const footer = formatMultipleProjectsFooter(projects);

    expect(footer).toBe("");
  });

  test("returns empty string for empty array", () => {
    const footer = formatMultipleProjectsFooter([]);

    expect(footer).toBe("");
  });

  test("formats footer with two projects", () => {
    const projects = [
      {
        orgDisplay: "my-org",
        projectDisplay: "frontend",
        detectedFrom: "packages/frontend/.env",
      },
      {
        orgDisplay: "my-org",
        projectDisplay: "backend",
        detectedFrom: "src/sentry.ts",
      },
    ];

    const footer = formatMultipleProjectsFooter(projects);

    expect(footer).toContain("Found 2 Sentry projects:");
    expect(footer).toContain(
      "• my-org / frontend (from packages/frontend/.env)"
    );
    expect(footer).toContain("• my-org / backend (from src/sentry.ts)");
    expect(footer).toContain(
      "Use <org>/<project> to target a specific project."
    );
  });

  test("formats footer with projects without detectedFrom", () => {
    const projects = [
      {
        orgDisplay: "org-a",
        projectDisplay: "project-1",
      },
      {
        orgDisplay: "org-b",
        projectDisplay: "project-2",
      },
    ];

    const footer = formatMultipleProjectsFooter(projects);

    expect(footer).toContain("Found 2 Sentry projects:");
    expect(footer).toContain("• org-a / project-1");
    expect(footer).toContain("• org-b / project-2");
    expect(footer).not.toContain("(from");
  });

  test("formats footer with mixed detectedFrom presence", () => {
    const projects = [
      {
        orgDisplay: "my-org",
        projectDisplay: "frontend",
        detectedFrom: ".env.local",
      },
      {
        orgDisplay: "my-org",
        projectDisplay: "backend",
        // No detectedFrom
      },
      {
        orgDisplay: "other-org",
        projectDisplay: "shared",
        detectedFrom: "libs/shared/sentry.config.js",
      },
    ];

    const footer = formatMultipleProjectsFooter(projects);

    expect(footer).toContain("Found 3 Sentry projects:");
    expect(footer).toContain("• my-org / frontend (from .env.local)");
    expect(footer).toContain("• my-org / backend");
    expect(footer).not.toContain("• my-org / backend (from");
    expect(footer).toContain(
      "• other-org / shared (from libs/shared/sentry.config.js)"
    );
  });

  test("handles many projects", () => {
    const projects = Array.from({ length: 10 }, (_, i) => ({
      orgDisplay: `org-${i}`,
      projectDisplay: `project-${i}`,
      detectedFrom: `path/to/project-${i}/.env`,
    }));

    const footer = formatMultipleProjectsFooter(projects);

    expect(footer).toContain("Found 10 Sentry projects:");
    expect(footer).toContain("• org-0 / project-0");
    expect(footer).toContain("• org-9 / project-9");
  });
});
