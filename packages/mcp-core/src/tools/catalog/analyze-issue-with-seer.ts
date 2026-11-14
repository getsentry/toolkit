import { z } from "zod";
import { ApiError, ApiServerError } from "../../api-client/index";
import { retryWithBackoff } from "../../internal/fetch-utils";
import { apiServiceFromContext } from "../../internal/tool-helpers/api";
import { defineTool } from "../../internal/tool-helpers/define";
import {
  assertIssueWithinProjectConstraint,
  parseIssueParams,
} from "../../internal/tool-helpers/issue";
import {
  getActiveAutofixTodo,
  getFailureReasonGuidance,
  getHumanInterventionGuidance,
  getOutputForAutofixRun,
  getSeerPaymentRequiredMessage,
  getSeerSetupRequiredMessage,
  getSeerUnsupportedIssueMessage,
  getStatusDisplayName,
  isSeerSupportedIssue,
  isTerminalStatus,
  SEER_INITIAL_RETRY_DELAY,
  SEER_MAX_RETRIES,
  SEER_POLLING_INTERVAL,
  SEER_TIMEOUT,
} from "../../internal/tool-helpers/seer";
import {
  ParamIssueShortId,
  ParamIssueUrl,
  ParamOrganizationSlug,
  ParamRegionUrl,
} from "../../schema";
import { setTargetTagsAndAttributes } from "../../telem/scope";
import type { ServerContext } from "../../types";

export default defineTool({
  name: "analyze_issue_with_seer",
  title: "Analyze Issue with Seer",
  skills: ["seer"], // Only available in seer skill
  requiredScopes: [], // No Sentry API scopes required - authorization via 'seer' skill
  description:
    "Run Seer AI root cause analysis on a Sentry issue and return the root cause, affected code locations, and a suggested code fix. Returns an existing analysis at once; a new one takes minutes, so call it only when the user asks for Seer or a fix, or the issue details do not show the cause. Does not support metric alert issues.",
  inputSchema: {
    organizationSlug: ParamOrganizationSlug.optional(),
    regionUrl: ParamRegionUrl.nullable().default(null),
    issueId: ParamIssueShortId.optional(),
    issueUrl: ParamIssueUrl.optional(),
    instruction: z
      .string()
      .describe("Extra guidance for the analysis.")
      .optional(),
  },
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  },
  async handler(params, context: ServerContext) {
    const apiService = apiServiceFromContext(context, {
      regionUrl: params.regionUrl ?? undefined,
    });
    const { organizationSlug: orgSlug, issueId: parsedIssueId } =
      parseIssueParams({
        organizationSlug: params.organizationSlug,
        issueId: params.issueId,
        issueUrl: params.issueUrl,
      });

    setTargetTagsAndAttributes({ organizationSlug: orgSlug });

    const issue = await apiService.getIssue({
      organizationSlug: orgSlug,
      issueId: parsedIssueId,
    });

    assertIssueWithinProjectConstraint({
      issue,
      projectSlug: context.constraints.projectSlug,
    });

    if (!isSeerSupportedIssue(issue)) {
      return getSeerUnsupportedIssueMessage(issue);
    }

    let output = `# Seer Analysis for Issue ${parsedIssueId}\n\n`;

    // Step 1: Check if analysis already exists
    let autofixState = await retryWithBackoff(
      () =>
        apiService.getAutofixState({
          organizationSlug: orgSlug,
          issueId: parsedIssueId,
        }),
      {
        maxRetries: SEER_MAX_RETRIES,
        initialDelay: SEER_INITIAL_RETRY_DELAY,
        shouldRetry: (error) => {
          // Retry on server errors (5xx) or non-API errors (network issues)
          return (
            error instanceof ApiServerError || !(error instanceof ApiError)
          );
        },
      },
    );

    // Step 2: Start analysis if none exists or the last one failed, so a run
    // that stopped (e.g. out of credits) can be retried.
    const previousRun = autofixState.autofix;
    if (!previousRun || previousRun.status === "error") {
      let startResult: Awaited<ReturnType<typeof apiService.startAutofix>>;
      try {
        startResult = await apiService.startAutofix({
          organizationSlug: orgSlug,
          issueId: parsedIssueId,
          instruction: params.instruction,
        });
      } catch (error) {
        // Sentry answers 402 before starting a run when the org is out of
        // Seer credits or quota.
        if (error instanceof ApiError && error.status === 402) {
          output += `## Analysis Not Started\n\n${getSeerPaymentRequiredMessage(error.responseBody)}\n`;
          // The failed run may already hold paid-for analysis, e.g. a root
          // cause found before the org ran out of credits.
          const previousOutput = previousRun
            ? getOutputForAutofixRun(previousRun)
            : "";
          if (previousRun && previousOutput) {
            output += `\nThe previous analysis (Run ID: ${previousRun.run_id}) failed before it finished. Its partial results:\n\n${previousOutput}`;
          }
          return output;
        }
        // Sentry answers 409 with a setup code when the org has no SCM
        // integration or the project has no linked repositories.
        if (error instanceof ApiError && error.status === 409) {
          const setupMessage = getSeerSetupRequiredMessage(error.responseBody);
          if (setupMessage) {
            output += `## Analysis Not Started\n\n${setupMessage}\n`;
            return output;
          }
        }
        throw error;
      }
      output += previousRun
        ? `Previous analysis (Run ID: ${previousRun.run_id}) failed, starting a new one...\n\n`
        : `Starting new analysis...\n\n`;
      output += `Analysis started with Run ID: ${startResult.run_id}\n\n`;

      // Give it a moment to initialize
      await new Promise((resolve) => setTimeout(resolve, 1000));

      // Refresh state with retry logic
      autofixState = await retryWithBackoff(
        () =>
          apiService.getAutofixState({
            organizationSlug: orgSlug,
            issueId: parsedIssueId,
          }),
        {
          maxRetries: SEER_MAX_RETRIES,
          initialDelay: SEER_INITIAL_RETRY_DELAY,
          shouldRetry: (error) => {
            // Retry on server errors (5xx) or non-API errors (network issues)
            return (
              error instanceof ApiServerError || !(error instanceof ApiError)
            );
          },
        },
      );
    } else {
      output += `Found existing analysis (Run ID: ${previousRun.run_id})\n\n`;

      // Completed and waiting-for-input runs are returned as they are
      const existingStatus = previousRun.status;
      if (isTerminalStatus(existingStatus)) {
        output += `## Analysis ${getStatusDisplayName(existingStatus)}\n\n`;
        output += getOutputForAutofixRun(previousRun);

        if (existingStatus !== "completed") {
          output += `\n**Status**: ${existingStatus}\n`;
          output += getHumanInterventionGuidance(existingStatus);
          output += "\n";
        }

        return output;
      }
    }

    // Step 3: Poll until complete or timeout (only for non-terminal states)
    const startTime = Date.now();
    let lastStatus = "";
    let consecutiveErrors = 0;

    while (Date.now() - startTime < SEER_TIMEOUT) {
      if (!autofixState.autofix) {
        output += `Error: Analysis state lost. Please try again by running:\n`;
        output += `\`\`\`\n`;
        output += params.issueUrl
          ? `analyze_issue_with_seer(issueUrl="${params.issueUrl}")`
          : `analyze_issue_with_seer(organizationSlug="${orgSlug}", issueId="${parsedIssueId}")`;
        output += `\n\`\`\`\n`;
        return output;
      }

      const status = autofixState.autofix.status;

      // Check if completed (terminal state)
      if (isTerminalStatus(status)) {
        output += `## Analysis ${getStatusDisplayName(status)}\n\n`;
        output += getOutputForAutofixRun(autofixState.autofix);

        if (status !== "completed") {
          output += `\n**Status**: ${status}\n`;
          output += getFailureReasonGuidance(
            autofixState.autofix.failure_reason,
          );
          output += getHumanInterventionGuidance(status);
        }

        return output;
      }

      // Update status if changed
      if (status !== lastStatus) {
        const activeTodo = getActiveAutofixTodo(autofixState.autofix);
        if (activeTodo) {
          output += `Processing: ${activeTodo}...\n`;
        }
        lastStatus = status;
      }

      // Wait before next poll
      await new Promise((resolve) =>
        setTimeout(resolve, SEER_POLLING_INTERVAL),
      );

      // Refresh state with error handling
      try {
        autofixState = await retryWithBackoff(
          () =>
            apiService.getAutofixState({
              organizationSlug: orgSlug,
              issueId: parsedIssueId,
            }),
          {
            maxRetries: SEER_MAX_RETRIES,
            initialDelay: SEER_INITIAL_RETRY_DELAY,
            shouldRetry: (error) => {
              // Retry on server errors (5xx) or non-API errors (network issues)
              return (
                error instanceof ApiServerError || !(error instanceof ApiError)
              );
            },
          },
        );
        consecutiveErrors = 0; // Reset error counter on success
      } catch (error) {
        consecutiveErrors++;

        // If we've had too many consecutive errors, give up
        if (consecutiveErrors >= 3) {
          output += `\n## Error During Analysis\n\n`;
          output += `Unable to retrieve analysis status after multiple attempts.\n`;
          output += `Error: ${error instanceof Error ? error.message : String(error)}\n\n`;
          output += `You can check the status later by running the same command again:\n`;
          output += `\`\`\`\n`;
          output += params.issueUrl
            ? `analyze_issue_with_seer(issueUrl="${params.issueUrl}")`
            : `analyze_issue_with_seer(organizationSlug="${orgSlug}", issueId="${parsedIssueId}")`;
          output += `\n\`\`\`\n`;
          return output;
        }

        // Log the error but continue polling
        output += `Temporary error retrieving status (attempt ${consecutiveErrors}/3), retrying...\n`;
      }
    }

    // Show current progress
    if (autofixState.autofix) {
      output += `**Current Status**: ${getStatusDisplayName(autofixState.autofix.status)}\n\n`;
      output += getOutputForAutofixRun(autofixState.autofix);
    }

    // Timeout reached
    output += `\n## Analysis Timed Out\n\n`;
    output += `The analysis is taking longer than expected (>${SEER_TIMEOUT / 1000}s).\n\n`;

    output += `\nYou can check the status later by running the same command again:\n`;
    output += `\`\`\`\n`;
    output += params.issueUrl
      ? `analyze_issue_with_seer(issueUrl="${params.issueUrl}")`
      : `analyze_issue_with_seer(organizationSlug="${orgSlug}", issueId="${parsedIssueId}")`;
    output += `\n\`\`\`\n`;

    return output;
  },
});
