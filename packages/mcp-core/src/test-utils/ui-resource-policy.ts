/**
 * The MCP Apps rules from design/mcp-apps.md that hold between tools and
 * views: every `_meta.ui.resourceUri` names a known view, every view has a
 * tool, a view's `ui://` URI is versioned and changes with its HTML, and its
 * `csp` allows no origins.
 */
import { createHash } from "node:crypto";
import type { UiResource } from "../ui-resources";

interface ToolWithMeta {
  name: string;
  _meta?: Record<string, unknown> | undefined;
}

function resourceUri(tool: ToolWithMeta): unknown {
  const ui = tool._meta?.["ui"];
  return typeof ui === "object" && ui !== null && "resourceUri" in ui
    ? ui.resourceUri
    : undefined;
}

/** Returns one message per broken rule; empty when every rule holds. */
export async function uiResourceProblems(
  tools: readonly ToolWithMeta[],
  resources: readonly UiResource[],
): Promise<string[]> {
  const problems: string[] = [];
  const uris = new Set<string>(resources.map((resource) => resource.uri));
  const referenced = new Set<unknown>();
  for (const tool of tools) {
    const uri = resourceUri(tool);
    if (uri === undefined) continue;
    referenced.add(uri);
    if (typeof uri !== "string" || !uris.has(uri)) {
      problems.push(
        `${tool.name} names view ${JSON.stringify(uri)}, which is not a UI resource.`,
      );
    }
  }
  if (uris.size !== resources.length) {
    problems.push("Two UI resources share a URI.");
  }
  for (const resource of resources) {
    if (!referenced.has(resource.uri)) {
      problems.push(`No tool names ${resource.uri}, so it is never listed.`);
    }
    if (!/^ui:\/\/[^/]+\/.*v\d+/.test(resource.uri)) {
      problems.push(
        `${resource.uri} has no version. Hosts cache views by URI, so it needs one, such as v1.`,
      );
    }
    const domains = Object.entries(resource.meta.csp).filter(
      ([, list]) => list.length > 0,
    );
    if (domains.length > 0) {
      problems.push(
        `${resource.uri} allows ${domains.map(([key]) => key).join(", ")} in its csp. A view loads nothing from the network.`,
      );
    }
    const sha256 = createHash("sha256")
      .update(await resource.loadHtml())
      .digest("hex");
    if (sha256 !== resource.htmlSha256) {
      problems.push(
        `The HTML of ${resource.uri} changed. Hosts cache views by URI, so bump its version and set htmlSha256 to "${sha256}".`,
      );
    }
  }
  return problems;
}
