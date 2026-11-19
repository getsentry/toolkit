/**
 * Human output for issue comments and their attached videos.
 */

import type { IssueCommentOutput } from "../../output-schemas/issue.js";
import { sanitize } from "./local.js";
import { muted } from "./index.js";

function formatAttachments(comment: IssueCommentOutput): string[] {
  return comment.attachments.map((attachment) => {
    const where = attachment.savedTo
      ? `saved to ${sanitize(attachment.savedTo)}`
      : sanitize(attachment.url);
    return `  ${muted("video")} ${sanitize(attachment.name)}  ${muted(where)}`;
  });
}

/** One comment: who and when, its text, then its videos. */
export function formatIssueComment(comment: IssueCommentOutput): string {
  const heading = comment.dryRun
    ? muted("Would post (dry run)")
    : `${sanitize(comment.author ?? "Unknown")} ${muted(comment.dateCreated ?? "")}`;
  const lines = comment.text.split("\n").map((line) => `  ${sanitize(line)}`);
  return [heading, ...lines, ...formatAttachments(comment)].join("\n") + "\n";
}

/** Comments newest first, separated by a blank line. */
export function formatIssueComments(comments: IssueCommentOutput[]): string {
  if (comments.length === 0) {
    return "No comments on this issue.\n";
  }
  return comments.map(formatIssueComment).join("\n");
}
