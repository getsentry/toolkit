/**
 * MCP Apps: what a host reads to render render_sentry_chart inline. The tool
 * names its view in `_meta.ui.resourceUri`, and that `ui://` resource reads
 * back as a self-contained HTML document with the MCP Apps mime type. MCP
 * Apps ship to experimental sessions only for now.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { buildServer } from "./server";
import type { Skill } from "./skills";
import type { ServerContext } from "./types";

vi.mock("@sentry/core/server", () => ({
  wrapMcpServerWithSentry: vi.fn((server) => server),
}));

const CHART_URI = "ui://sentry/chart/v3.html";
const MCP_APP_MIME_TYPE = "text/html;profile=mcp-app";

async function connect(skills: Skill[], experimentalMode = true) {
  const context: ServerContext = {
    accessToken: "test-token",
    grantedSkills: new Set(skills),
    constraints: { organizationSlug: null, projectSlug: null },
    sentryHost: "sentry.io",
  };
  const server = buildServer({ context, experimentalMode });
  const [clientTransport, serverTransport] =
    InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "mcp-apps-host", version: "1.0.0" });
  await server.connect(serverTransport);
  await client.connect(clientTransport);
  return {
    client,
    async [Symbol.asyncDispose]() {
      await client.close();
      await server.close();
    },
  };
}

describe("MCP Apps chart view", () => {
  it("links render_sentry_chart to its view in tools/list", async () => {
    await using session = await connect(["inspect"]);
    const { tools } = await session.client.listTools();
    const chartTool = tools.find((tool) => tool.name === "render_sentry_chart");

    expect(chartTool?._meta).toEqual({
      ui: { resourceUri: CHART_URI },
      "openai/outputTemplate": CHART_URI,
    });
  });

  it("lists and reads the view as a self-contained HTML document", async () => {
    await using session = await connect(["inspect"]);

    expect(session.client.getServerCapabilities()?.resources).toEqual({
      listChanged: false,
    });
    const { resources } = await session.client.listResources();
    expect(resources).toEqual([
      expect.objectContaining({ uri: CHART_URI, mimeType: MCP_APP_MIME_TYPE }),
    ]);

    const { contents } = await session.client.readResource({ uri: CHART_URI });
    expect(contents).toHaveLength(1);
    const [view] = contents;
    expect(view).toMatchObject({
      uri: CHART_URI,
      mimeType: MCP_APP_MIME_TYPE,
      _meta: { ui: { csp: {}, prefersBorder: true } },
    });
    const html = view && "text" in view ? view.text : "";
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.endsWith("</html>")).toBe(true);
  });

  it("lists no view when the session cannot call the chart tool", async () => {
    await using session = await connect(["project-management"]);
    const { tools } = await session.client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("render_sentry_chart");
    expect(session.client.getServerCapabilities()?.resources).toBeUndefined();
  });

  it("keeps the chart tool and its view out of stable sessions", async () => {
    await using session = await connect(["inspect"], false);
    const { tools } = await session.client.listTools();

    expect(tools.map((tool) => tool.name)).not.toContain("render_sentry_chart");
    expect(tools.some((tool) => tool._meta?.["ui"] !== undefined)).toBe(false);
    expect(session.client.getServerCapabilities()?.resources).toBeUndefined();
  });
});
