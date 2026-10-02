import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  captureException,
  type ErrorEvent,
  getCurrentScope,
  getIsolationScope,
  type StreamedSpanJSON,
  setCurrentClient,
} from "@sentry/core";
import { ServerRuntimeClient } from "@sentry/core/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildServer } from "../server";
import { getServerContext } from "../test-setup";
import findProjects from "../tools/catalog/find-projects";
import type { ServerContext } from "../types";
import { type Target, setTargetTagsAndAttributes } from "./scope";

const beforeSendSpan = vi.fn((span: StreamedSpanJSON) => span);
const beforeSend = vi.fn((event: ErrorEvent) => event);
let sentry: ServerRuntimeClient;

// Without an async context strategy, withIsolationScope does not fork the
// isolation scope, so values set by one test stay there for the next one.
function resetScopeContext(): void {
  const scope = getIsolationScope();
  for (const key of [
    "organization.slug",
    "project.slug",
    "project.id",
    "team.slug",
    "issue.id",
    "trace.id",
    "trace.span_id",
    "monitor.slug",
    "uptime.monitor_id",
    "release.version",
    "replay.id",
    "profile.id",
    "profiler.id",
    "ai_conversation.id",
    "client.id",
  ]) {
    scope.setAttribute(key, undefined);
    scope.setTag(key, undefined);
  }
}

beforeEach(() => {
  vi.clearAllMocks();
  resetScopeContext();
  sentry = new ServerRuntimeClient({
    dsn: "https://public@example.com/1",
    integrations: [],
    stackParser: () => [],
    tracesSampleRate: 1,
    transport: () => ({
      send: async () => ({ statusCode: 200 }),
      flush: async () => true,
    }),
    beforeSendSpan,
    beforeSend,
  });
  setCurrentClient(sentry);
  sentry.init();
});

afterEach(async () => {
  await sentry.close();
  getCurrentScope().setClient(undefined);
  resetScopeContext();
});

async function callTool(
  context: ServerContext,
  name: string,
  args: Record<string, unknown>,
): Promise<void> {
  const server = buildServer({ context });
  const client = new Client({ name: "telemetry-test", version: "1.0.0" });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  try {
    await server.connect(serverTransport);
    await client.connect(clientTransport);
    const result = await client.callTool({ name, arguments: args });
    expect(result.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
  }
  await sentry.flush();
}

describe("organization telemetry", () => {
  it.each([
    {
      description: "explicit organization arguments",
      name: "find_projects",
      args: { organizationSlug: "sentry-mcp-evals" },
      constraints: {},
    },
    {
      description: "session constraints",
      name: "find_projects",
      args: {},
      constraints: { organizationSlug: "sentry-mcp-evals" },
    },
    {
      description: "URL-derived organizations through catalog execution",
      name: "execute_sentry_tool",
      args: {
        name: "get_issue_breadcrumbs",
        arguments: {
          issueUrl:
            "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
        },
      },
      constraints: {},
    },
  ])(
    "includes $description on streamed root spans",
    async ({ name, args, constraints }) => {
      await callTool(
        getServerContext({
          constraints,
          grantedSkills: new Set(["inspect"]),
        }),
        name,
        args,
      );
      expect(beforeSendSpan).toHaveBeenCalledWith(
        expect.objectContaining({
          is_segment: true,
          attributes: expect.objectContaining({
            "organization.slug": "sentry-mcp-evals",
          }),
        }),
      );
    },
  );

  it("preserves organization tags on error events", async () => {
    await findProjects.handler(
      {
        organizationSlug: "sentry-mcp-evals",
        regionUrl: null,
        query: null,
        cursor: null,
      },
      getServerContext(),
    );
    captureException(new Error("organization telemetry regression"));
    await sentry.flush();
    expect(beforeSend).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: expect.objectContaining({
          "organization.slug": "sentry-mcp-evals",
        }),
      }),
      expect.anything(),
    );
  });
});

describe("request and tool telemetry", () => {
  it("includes request and tool context on streamed root spans", async () => {
    await callTool(
      getServerContext({
        clientId: "telemetry-test-client",
        grantedSkills: new Set(["inspect"]),
      }),
      "execute_sentry_tool",
      {
        name: "get_issue_breadcrumbs",
        arguments: {
          issueUrl:
            "https://sentry-mcp-evals.sentry.io/issues/CLOUDFLARE-MCP-41/",
        },
      },
    );
    expect(beforeSendSpan).toHaveBeenCalledWith(
      expect.objectContaining({
        is_segment: true,
        attributes: expect.objectContaining({
          "client.id": "telemetry-test-client",
          "issue.id": "CLOUDFLARE-MCP-41",
        }),
      }),
    );
  });
});

describe("setTargetTagsAndAttributes", () => {
  function scopeValuesFor(target: Target) {
    setTargetTagsAndAttributes(target);
    const { tags, attributes } = getIsolationScope().getScopeData();
    return { tags, attributes };
  }

  it("sets every target field as a tag and an attribute", () => {
    const { tags, attributes } = scopeValuesFor({
      organizationSlug: "sentry",
      projectSlug: "javascript",
      projectId: 42,
      teamSlug: "sdk",
      issueId: "JAVASCRIPT-1",
      traceId: "a".repeat(32),
      spanId: "b".repeat(16),
      monitorSlug: "nightly",
      uptimeMonitorId: "7",
      releaseVersion: "1.0.0",
      replayId: "c".repeat(32),
      profileId: "d".repeat(32),
      profilerId: "e".repeat(32),
      aiConversationId: "conversation-1",
    });
    const expected = {
      "organization.slug": "sentry",
      "project.slug": "javascript",
      "project.id": "42",
      "team.slug": "sdk",
      "issue.id": "JAVASCRIPT-1",
      "trace.id": "a".repeat(32),
      "trace.span_id": "b".repeat(16),
      "monitor.slug": "nightly",
      "uptime.monitor_id": "7",
      "release.version": "1.0.0",
      "replay.id": "c".repeat(32),
      "profile.id": "d".repeat(32),
      "profiler.id": "e".repeat(32),
      "ai_conversation.id": "conversation-1",
    };
    expect(tags).toMatchObject(expected);
    expect(attributes).toMatchObject(expected);
  });

  it.each([
    { projectSlugOrId: "42", key: "project.id", other: "project.slug" },
    { projectSlugOrId: "javascript", key: "project.slug", other: "project.id" },
  ])(
    "maps projectSlugOrId $projectSlugOrId to $key",
    ({ projectSlugOrId, key, other }) => {
      const { tags, attributes } = scopeValuesFor({
        organizationSlug: "sentry",
        projectSlugOrId,
      });
      expect(tags[key]).toBe(projectSlugOrId);
      expect(attributes[key]).toBe(projectSlugOrId);
      expect(tags[other]).toBeUndefined();
      expect(attributes[other]).toBeUndefined();
    },
  );

  it("skips empty project and team values", () => {
    const { tags, attributes } = scopeValuesFor({
      organizationSlug: "sentry",
      projectSlug: null,
      projectId: undefined,
      projectSlugOrId: "",
      teamSlug: null,
    });
    for (const key of ["project.slug", "project.id", "team.slug"]) {
      expect(tags[key]).toBeUndefined();
      expect(attributes[key]).toBeUndefined();
    }
    expect(attributes["organization.slug"]).toBe("sentry");
  });
});
