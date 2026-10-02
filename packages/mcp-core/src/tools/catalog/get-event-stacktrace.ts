import { z } from "zod";
import { ApiNotFoundError } from "../../api-client";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import { enhanceNotFoundError } from "../../internal/tool-helpers/enhance-error";
import { ensureIssueWithinProjectConstraint } from "../../internal/tool-helpers/issue";
import {
  ParamEventIdOrLatest,
  ParamIssueShortId,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";
import { fetchAndFormatEventStacktrace } from "../support/event-stacktrace";

export default defineTool({
  name: "get_event_stacktrace",
  skills: ["inspect", "triage", "seer"],
  requiredScopes: ["event:read"],
  description: [
    "Get a full thread stacktrace from a specific Sentry event.",
    "",
    "Use this tool when you need to:",
    "- Fetch the full stacktrace for a thread listed in issue details",
    "- Inspect a non-crashed thread from an event with multiple threads",
    "- Get Sentry's default selected thread stacktrace when no thread is specified",
    "",
    "<examples>",
    "get_event_stacktrace(organizationSlug='my-org', issueId='PROJECT-123')",
    "get_event_stacktrace(organizationSlug='my-org', issueId='PROJECT-123', eventId='c49541c747cb4d8aa3efb70ca5aba243', thread=259)",
    "get_event_stacktrace(organizationSlug='my-org', issueId='PROJECT-123', thread='main')",
    "</examples>",
    "",
    "<hints>",
    "- `thread` is optional. If omitted, this returns the same default thread Sentry selects: first crashed thread, then first thread with a stacktrace, then first thread.",
    "- Pass `thread` as a numeric Thread ID or exact thread Name from the issue details thread list.",
    "- If the issue details show only one useful thread, omit `thread`.",
    "</hints>",
  ].join("\n"),
  inputSchema: {
    organizationSlug: ParamOrganizationSlug,
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId,
    eventId: ParamEventIdOrLatest,
    thread: z
      .union([z.number().int(), z.string().trim().min(1)])
      .optional()
      .describe(
        "Optional thread selector. Pass a numeric thread ID, or an exact thread name string. If omitted, returns the same default thread Sentry selects: first crashed thread, then first thread with a stacktrace, then first thread.",
      ),
  },
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

      return await fetchAndFormatEventStacktrace({
        apiService,
        organizationSlug: params.organizationSlug,
        issueId: params.issueId,
        eventId: params.eventId,
        thread: params.thread,
      });
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
