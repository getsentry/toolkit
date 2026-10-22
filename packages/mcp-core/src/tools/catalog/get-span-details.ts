import { defineTool } from "../../internal/tool-helpers/define";
import {
  ParamOrganizationSlug,
  ParamRegionUrl,
  ParamSpanId,
  ParamTraceId,
} from "../../schema";
import type { ServerContext } from "../../types";
import getTraceDetails from "./get-trace-details";

export default defineTool({
  name: "get_span_details",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  requiredCapabilities: ["traces"],
  description: [
    "Get detailed information about a specific span within a Sentry trace.",
    "",
    "Use this tool when you need to:",
    "- Inspect a span when you already know its trace ID and span ID",
    "- Focus a trace investigation on one operation",
    "- Review a span's attributes, timing, errors, and child spans",
    "",
    "<examples>",
    "get_span_details(organizationSlug='my-organization', traceId='a4d1aae7216b47ff8117cf4e09ce9d0a', spanId='aa8e7f3384ef4ff5')",
    "</examples>",
    "",
    "<hints>",
    "- Pass traceId and spanId as separate parameters.",
    "- Use get_trace_details for a trace overview when no span is selected.",
    "- Use get_sentry_resource when starting from a Sentry trace or span URL.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    traceId: ParamTraceId,
    spanId: ParamSpanId,
  },
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    return await getTraceDetails.handler(params, context);
  },
});
