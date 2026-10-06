/** Human-readable results for linking existing external issues. */

import type { ExternalIssueLinkResult } from "../issue-links.js";
import { renderMarkdown, safeCodeSpan } from "./markdown.js";

/** Render the association outcome without implying that either issue was resolved. */
export function formatIssueLinkResult(result: ExternalIssueLinkResult): string {
  const external = safeCodeSpan(result.externalIssue.url);
  const issue = safeCodeSpan(`${result.org}/${result.issueId}`);
  if (result.dryRun) {
    return renderMarkdown(
      result.linked
        ? `Already linked: ${external}. (dry run)`
        : `Would link ${external} to ${issue}. (dry run)`
    );
  }
  return renderMarkdown(
    result.changed
      ? `Linked ${external} to ${issue}.`
      : `Already linked: ${external}.`
  );
}
