/**
 * sentry issue comment / sentry issue comments
 *
 * Post a comment on an issue, optionally with screen recordings attached, and
 * read an issue's comments, optionally saving their videos to disk.
 */

import { mkdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseCommentAttachments } from "@sentry/mcp-core/comment-attachments";
import type { SentryContext } from "../../context.js";
import {
  createIssueCommentWithVideos,
  downloadIssueCommentAttachment,
  type IssueComment,
  listIssueComments,
  readLocalVideo,
} from "../../lib/api-client.js";
import { buildCommand } from "../../lib/command.js";
import {
  parseDirectoryPath,
  parseFilePath,
  parseText,
} from "../../lib/completion-target.js";
import {
  formatIssueComment,
  formatIssueComments,
} from "../../lib/formatters/issue-comments.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import { withProgress } from "../../lib/polling.js";
import { resolveOrgRegion } from "../../lib/region.js";
import { IssueCommentOutputSchema } from "../../generated/output-schemas/issue.js";
import type { IssueCommentOutput } from "../../output-schemas/issue.js";
import {
  type IssueTarget,
  issueParameter,
  issuePositional,
} from "./positional.js";

function commentAuthor(comment: IssueComment): string {
  return (
    comment.user?.name ||
    comment.user?.email ||
    comment.sentry_app?.name ||
    "Sentry"
  );
}

/** Comment output with each linked video's full API URL. */
function toOutput(
  comment: IssueComment,
  regionUrl: string,
): IssueCommentOutput {
  const text = comment.data.text ?? "";
  const origin = regionUrl.replace(/\/$/, "");
  return {
    id: comment.id,
    dateCreated: comment.dateCreated,
    author: commentAuthor(comment),
    text,
    attachments: parseCommentAttachments(text).map((link) => ({
      id: link.id,
      name: link.name,
      url: `${origin}${link.path}`,
    })),
  };
}

type CommentFlags = {
  readonly json: boolean;
  readonly fields?: string[];
  readonly attach?: string[];
  readonly "dry-run": boolean;
};

export const commentCommand = buildCommand({
  docs: {
    brief: "Comment on an issue, optionally attaching videos",
    fullDescription:
      "Post a comment to an issue's activity feed, visible to the whole team.\n\n" +
      "Use --attach to upload screen recordings with the comment. Accepted\n" +
      "formats are MP4, MOV, WebM and Ogg; the server's size limit applies\n" +
      "(100 MB by default). Each video is linked after the comment text and\n" +
      "plays inline in Sentry.\n\n" +
      "Use --dry-run to check the files without uploading or posting anything.",
    examples: [
      {
        description: "Comment on an issue",
        run: 'issue comment my-org/FRONT-ABC "Fixed in the next deploy"',
      },
      {
        description: "Attach a screen recording of the bug",
        run: 'issue comment FRONT-ABC "Repro steps below" --attach repro.mp4',
      },
      {
        description: "Check attachments without posting",
        run: 'issue comment FRONT-ABC "Repro" --attach a.mp4 --attach b.webm --dry-run',
      },
    ],
  },
  output: {
    human: formatIssueComment,
    schema: IssueCommentOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        issueParameter({ command: "comment" }),
        {
          placeholder: "text",
          brief: "Comment text (Markdown)",
          parse: parseText,
        },
      ],
    },
    flags: {
      attach: {
        kind: "parsed",
        parse: parseFilePath,
        brief: "Path of a video to attach (repeatable)",
        optional: true,
        variadic: true,
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, a: "attach" },
  },
  async *func(
    this: SentryContext,
    flags: CommentFlags,
    target: IssueTarget,
    text: string,
  ) {
    const paths = flags.attach ?? [];
    // Read and check every file before anything is uploaded.
    const videos = await Promise.all(paths.map(readLocalVideo));
    const { org, issue } = await target.resolved;

    if (flags["dry-run"]) {
      yield new CommandOutput<IssueCommentOutput>({
        text,
        attachments: videos.map((video) => ({
          id: "",
          name: video.name,
          url: "",
        })),
        dryRun: true,
      });
      return { hint: `Issue: ${issue.shortId}. Nothing was uploaded.` };
    }

    const { comment } = await withProgress(
      {
        message: videos.length
          ? `Uploading ${videos.length} video(s) and posting comment...`
          : "Posting comment...",
        json: flags.json,
      },
      () => createIssueCommentWithVideos(org, issue.id, text, videos),
    );
    yield new CommandOutput(toOutput(comment, await resolveOrgRegion(org)));
    return { hint: `Issue: ${issue.shortId}.` };
  },
});

type CommentsFlags = {
  readonly json: boolean;
  readonly fields?: string[];
  readonly download?: string;
};

export const commentsCommand = buildCommand({
  docs: {
    brief: "List an issue's comments and their videos",
    fullDescription:
      "Show an issue's comments, newest first, with any videos attached to them.\n\n" +
      "Use --download to save every attached video into a directory. Files are\n" +
      "named <attachment-id>-<file name> so videos with the same name do not\n" +
      "overwrite each other.",
    examples: [
      {
        description: "Read the comments on an issue",
        run: "issue comments my-org/FRONT-ABC",
      },
      {
        description: "Save the attached videos to ./videos",
        run: "issue comments FRONT-ABC --download ./videos",
      },
      {
        description: "Get comments and video URLs as JSON",
        run: "issue comments FRONT-ABC --json --fields author,text,attachments",
      },
    ],
  },
  output: {
    human: formatIssueComments,
    schema: IssueCommentOutputSchema,
  },
  parameters: {
    positional: issuePositional({ command: "comments" }),
    flags: {
      download: {
        kind: "parsed",
        parse: parseDirectoryPath,
        brief: "Directory to save attached videos into",
        optional: true,
      },
    },
    aliases: { d: "download" },
  },
  async *func(this: SentryContext, flags: CommentsFlags, target: IssueTarget) {
    const { org, issue } = await target.resolved;
    const [comments, regionUrl] = await withProgress(
      { message: "Fetching comments...", json: flags.json },
      () =>
        Promise.all([listIssueComments(org, issue.id), resolveOrgRegion(org)]),
    );
    const output = comments.map((comment) => toOutput(comment, regionUrl));

    if (flags.download !== undefined) {
      const dir = flags.download;
      await mkdir(dir, { recursive: true });
      for (const comment of output) {
        for (const attachment of comment.attachments) {
          const destPath = join(
            dir,
            `${attachment.id}-${basename(attachment.name)}`,
          );
          await withProgress(
            { message: `Downloading ${attachment.name}...`, json: flags.json },
            () =>
              downloadIssueCommentAttachment(
                org,
                issue.id,
                attachment.id,
                destPath,
              ),
          );
          attachment.savedTo = destPath;
        }
      }
    }

    yield new CommandOutput(output);
    return { hint: `Issue: ${issue.shortId}. ${output.length} comment(s).` };
  },
});
