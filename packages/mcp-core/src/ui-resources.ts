/**
 * MCP Apps views: `ui://` HTML resources that a host renders inline for a
 * tool result. A tool opts in with `_meta: uiToolMeta(resource)`, and the
 * server lists each resource that a registered tool references.
 * Views are generated HTML strings, so they need no file system at runtime.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */
import type {
  McpUiResourceMeta,
  McpUiToolMeta,
} from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";
import { CHART_APP_HTML } from "./ui/chart-app.generated";

export interface UiResource {
  /** Hosts cache a view by its URI, so bump the version when the HTML changes. */
  uri: `ui://${string}`;
  name: string;
  title: string;
  description: string;
  /** A self-contained HTML5 document: inline scripts and styles only. */
  html: string;
  meta: McpUiResourceMeta;
}

/** The render_sentry_chart view. Built from chart-app/ by generate-chart-app. */
export const CHART_UI_RESOURCE: UiResource = {
  uri: "ui://sentry/chart/v1.html",
  name: "sentry_chart",
  title: "Sentry Chart",
  description:
    "Interactive time series chart for render_sentry_chart results, with a range picker and a link to Sentry.",
  html: CHART_APP_HTML,
  // Self-contained, so it loads nothing from the network.
  meta: { csp: {}, prefersBorder: true },
};

export const UI_RESOURCES: readonly UiResource[] = [CHART_UI_RESOURCE];

/**
 * `_meta` for a tool whose result renders in `resource`. ChatGPT reads
 * `openai/outputTemplate`; MCP Apps hosts read `ui.resourceUri`.
 */
export function uiToolMeta(resource: UiResource): {
  ui: McpUiToolMeta;
  "openai/outputTemplate": string;
} {
  return {
    ui: { resourceUri: resource.uri },
    "openai/outputTemplate": resource.uri,
  };
}

function referencedResourceUri(
  meta: Record<string, unknown> | undefined,
): string | undefined {
  const ui = meta?.["ui"];
  if (typeof ui !== "object" || ui === null || !("resourceUri" in ui)) {
    return undefined;
  }
  return typeof ui.resourceUri === "string" ? ui.resourceUri : undefined;
}

/** Lists the views that the registered tools reference. */
export function registerUiResources(
  server: McpServer,
  tools: readonly { _meta?: Record<string, unknown> | undefined }[],
): void {
  const referenced = new Set(
    tools.map((tool) => referencedResourceUri(tool._meta)),
  );
  const resources = UI_RESOURCES.filter((resource) =>
    referenced.has(resource.uri),
  );
  for (const resource of resources) {
    const content = {
      uri: resource.uri,
      mimeType: RESOURCE_MIME_TYPE,
      text: resource.html,
      _meta: { ui: resource.meta },
    };
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: RESOURCE_MIME_TYPE,
        _meta: { ui: resource.meta },
      },
      () => ({ contents: [content] }),
    );
  }
  // Registration enables this by default, but the set of views is fixed.
  if (resources.length > 0) {
    server.server.registerCapabilities({ resources: { listChanged: false } });
  }
}
