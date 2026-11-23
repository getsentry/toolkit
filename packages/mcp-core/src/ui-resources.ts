/**
 * MCP Apps views: `ui://` HTML resources that a host renders inline for a
 * tool result. A tool opts in with `_meta: uiToolMeta(resource)`, and the
 * server lists each resource that a registered tool references.
 * Views are generated HTML strings, so they need no file system at runtime.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */
import type { McpServer } from "@modelcontextprotocol/server";

/** The MIME type of an MCP Apps view. */
export const UI_RESOURCE_MIME_TYPE = "text/html;profile=mcp-app";

/** `_meta.ui` on a tool: the view that renders its results. */
export interface UiToolMeta {
  resourceUri: string;
}

/**
 * `_meta.ui` on a view resource. Each `csp` list names origins that the host
 * may allow; an empty `csp` means the view loads nothing from the network.
 */
export interface UiResourceMeta {
  csp: {
    connectDomains?: string[];
    resourceDomains?: string[];
    frameDomains?: string[];
    baseUriDomains?: string[];
  };
  prefersBorder?: boolean;
}

export interface UiResource {
  /** Hosts cache a view by its URI, so bump the version when the HTML changes. */
  uri: `ui://${string}`;
  name: string;
  title: string;
  description: string;
  /**
   * SHA-256 of the HTML that `uri` serves. A test fails when the HTML changes
   * and this does not, so a change also bumps the version in `uri`.
   */
  htmlSha256: string;
  /** Most bytes the HTML may take. The view's generator fails over it. */
  budgetBytes: number;
  /**
   * Loads the self-contained HTML5 document (inline scripts and styles only)
   * on the first `resources/read`, so sessions that never render a view do
   * not load it.
   */
  loadHtml(): Promise<string>;
  meta: UiResourceMeta;
}

/**
 * The chart view for render_sentry_chart and render_issue_chart. Built from
 * chart-app/ by generate-chart-app.
 */
export const CHART_UI_RESOURCE: UiResource = {
  uri: "ui://sentry/chart/v5.html",
  name: "sentry_chart",
  title: "Sentry Chart",
  description:
    "Interactive time series chart for render_sentry_chart and render_issue_chart results, with a range picker, fullscreen, and a link to Sentry.",
  htmlSha256:
    "7957519bcbf3a3855250904467784362573af55eb36cc11bac53d0625c2d2d22",
  // About 1.5x the current view, so a new dependency cannot slip in.
  budgetBytes: 24 * 1024,
  loadHtml: async () =>
    (await import("./ui/chart-app.generated")).CHART_APP_HTML,
  // Self-contained, so it loads nothing from the network.
  meta: { csp: {}, prefersBorder: true },
};

export const UI_RESOURCES: readonly UiResource[] = [CHART_UI_RESOURCE];

/**
 * `_meta` for a tool whose result renders in `resource`. ChatGPT reads
 * `openai/outputTemplate`; MCP Apps hosts read `ui.resourceUri`.
 */
export function uiToolMeta(resource: UiResource): {
  ui: UiToolMeta;
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
    server.registerResource(
      resource.name,
      resource.uri,
      {
        title: resource.title,
        description: resource.description,
        mimeType: UI_RESOURCE_MIME_TYPE,
        _meta: { ui: resource.meta },
      },
      async () => ({
        contents: [
          {
            uri: resource.uri,
            mimeType: UI_RESOURCE_MIME_TYPE,
            text: await resource.loadHtml(),
            _meta: { ui: resource.meta },
          },
        ],
      }),
    );
  }
  // Registration enables this by default, but the set of views is fixed.
  if (resources.length > 0) {
    server.server.registerCapabilities({ resources: { listChanged: false } });
  }
}
