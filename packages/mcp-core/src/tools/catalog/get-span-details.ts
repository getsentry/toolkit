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
  title: "Get Span Details",
  skills: ["inspect"],
  requiredScopes: ["event:read"],
  requiredCapabilities: ["traces"],
  description:
    "Get one span in a Sentry trace by trace ID and span ID: its attributes, timing, errors, and child spans. For a whole-trace overview, use get_trace_details.",
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
