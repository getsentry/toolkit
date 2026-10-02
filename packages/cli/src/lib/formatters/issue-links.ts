/** Human-readable results for linking and unlinking existing external issues. */

import type { ExternalIssueLinkResult } from "../issue-links.js";
import { renderMarkdown, safeCodeSpan } from "./markdown.js";

/** Render the association outcome without implying that either issue was resolved. */
export function formatIssueLinkResult(result: ExternalIssueLinkResult): string {
  const external = safeCodeSpan(result.externalIssue.url);
  const issue = safeCodeSpan(`${result.org}/${result.issueId}`);
  if (result.dryRun) {
    const needsChange =
      result.action === "link" ? !result.linked : result.linked;
    return renderMarkdown(
      needsChange
        ? `Would ${result.action} ${external} ${result.action === "link" ? "to" : "from"} ${issue}. (dry run)`
        : `Already ${result.linked ? "linked" : "unlinked"}: ${external}. (dry run)`
    );
  }
  if (!result.changed) {
    return renderMarkdown(
      `Already ${result.linked ? "linked" : "unlinked"}: ${external}.`
    );
  }
  return renderMarkdown(
    result.linked
      ? `Linked ${external} to ${issue}.`
      : `Unlinked ${external} from ${issue}. The external issue was not deleted.`
  );
}
