/**
 * MCP Apps views: `ui://` HTML resources that a host renders inline for a
 * tool result. A tool opts in with `_meta: uiToolMeta(resource)`, and the
 * server lists each resource that a registered tool references.
 *
 * Spec: https://github.com/modelcontextprotocol/ext-apps/blob/main/specification/2026-01-26/apps.mdx
 */
import type {
  McpUiResourceMeta,
  McpUiToolMeta,
} from "@modelcontextprotocol/ext-apps";
import { RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import type { McpServer } from "@modelcontextprotocol/server";

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

export const UI_RESOURCES: readonly UiResource[] = [];

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
