import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { enhanceNotFoundError } from "../../internal/tool-helpers/enhance-error";
import { ensureIssueWithinProjectConstraint } from "../../internal/tool-helpers/issue";
import { structuredResult } from "../../internal/tool-helpers/results";
import {
  ParamEventIdOrLatest,
  ParamIssueShortId,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import {
  eventStacktraceOutputSchema,
  fetchEventStacktrace,
} from "../support/event-stacktrace";

export default defineTool({
  name: "get_event_stacktrace",
  title: "Get Event Stacktrace",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read"],
  description:
    "Get the full stack trace (stacktrace) of one thread in a Sentry event, such as a non-crashed thread listed in the issue details. Lists the threads when the selector matches none or several.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId,
    eventId: ParamEventIdOrLatest,
    thread: z
      .union([z.number().int(), z.string().trim().min(1)])
      .optional()
      .describe(
        "Numeric thread ID or exact thread name from the issue details. Omit for Sentry's default: the crashed thread, else the first with a stack trace.",
      ),
  },
  outputSchema: eventStacktraceOutputSchema,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });

    setTargetTagsAndAttributes(params);

    try {
      await ensureIssueWithinProjectConstraint({
        apiService,
        organizationSlug: params.organizationSlug,
        issueId: params.issueId,
        projectSlug: context.constraints.projectSlug,
      });

      return structuredResult(
        await fetchEventStacktrace({
          apiService,
          organizationSlug: params.organizationSlug,
          issueId: params.issueId,
          eventId: params.eventId,
          thread: params.thread,
        }),
      );
    } catch (error) {
      if (error instanceof ApiNotFoundError) {
        throw enhanceNotFoundError(error, {
          organizationSlug: params.organizationSlug,
          issueId: params.issueId,
          eventId: params.eventId,
        });
      }
      throw error;
    }
  },
});
