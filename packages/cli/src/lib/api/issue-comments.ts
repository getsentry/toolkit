/**
 * Issue comments and the videos attached to them.
 *
 * Comments, and the `comment-attachments/` upload and download routes, are
 * not in the public API schema, so these calls build their requests by hand.
 */

import { createWriteStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as NodeReadableStream } from "node:stream/web";
import {
  appendCommentAttachments,
  COMMENT_ATTACHMENT_EXTENSIONS,
  type CommentAttachment,
  commentAttachmentContentType,
  commentAttachmentPath,
} from "@sentry/mcp-core/comment-attachments";
import {
  array,
  type InferOutput,
  looseObject,
  nullish,
  number,
  object,
  parse,
  string,
} from "valibot";
import { isNetworkError, ValidationError } from "../errors.js";
import { resolveOrgRegion } from "../region.js";
import { getSdkConfig } from "../sentry-client.js";
import {
  API_MAX_PER_PAGE,
  apiRequestToRegion,
  autoPaginate,
  paginatedResponse,
  parseLinkHeader,
  throwApiError,
  throwRawApiError,
} from "./infrastructure.js";

/** An issue comment, as the comments endpoint returns it. */
export const IssueCommentSchema = looseObject({
  id: string(),
  dateCreated: string(),
  data: looseObject({ text: nullish(string()) }),
  user: nullish(
    looseObject({
      name: nullish(string()),
      email: nullish(string()),
    }),
  ),
  sentry_app: nullish(looseObject({ name: nullish(string()) })),
});

export type IssueComment = InferOutput<typeof IssueCommentSchema>;

const CommentAttachmentSchema = object({
  id: string(),
  name: string(),
  size: number(),
  contentType: string(),
  url: string(),
});

/** One page of an issue's comments, newest first. */
async function fetchIssueCommentPage(
  regionUrl: string,
  orgSlug: string,
  issueId: string,
  cursor: string | undefined,
) {
  const { data, headers } = await apiRequestToRegion(
    regionUrl,
    `/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/comments/`,
    {
      params: { per_page: API_MAX_PER_PAGE, cursor },
      schema: array(IssueCommentSchema),
    },
  );
  const { nextCursor } = parseLinkHeader(headers.get("link") ?? null);
  return paginatedResponse(data, nextCursor);
}

/** Every comment on an issue, newest first, following pagination. */
export async function listIssueComments(
  orgSlug: string,
  issueId: string,
): Promise<IssueComment[]> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const { data } = await autoPaginate(
    (cursor) => fetchIssueCommentPage(regionUrl, orgSlug, issueId, cursor),
    Number.MAX_SAFE_INTEGER,
  );
  return data;
}

/** Post a comment on an issue. */
export async function createIssueComment(
  orgSlug: string,
  issueId: string,
  text: string,
): Promise<IssueComment> {
  const { data } = await apiRequestToRegion(
    await resolveOrgRegion(orgSlug),
    `/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/comments/`,
    { method: "POST", body: { text }, schema: IssueCommentSchema },
  );
  return data;
}

/** A local video checked and ready to upload. */
export type LocalVideo = {
  name: string;
  contentType: string;
  data: Uint8Array;
};

/**
 * Read a video to attach. Both the extension and the file's leading bytes must
 * be a supported video, so nothing else is uploaded by mistake.
 */
export async function readLocalVideo(path: string): Promise<LocalVideo> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) {
    throw new ValidationError(`${path} is not a file.`, "attach");
  }
  const data = new Uint8Array(await readFile(path));
  const name = basename(path);
  const contentType = commentAttachmentContentType(name, data);
  if (!contentType) {
    throw new ValidationError(
      `${name} is not a supported video. Attach ${COMMENT_ATTACHMENT_EXTENSIONS.join(", ")} files.`,
      "attach",
    );
  }
  return { name, contentType, data };
}

/** Upload a video for an issue comment; the comment then links its `url`. */
export async function uploadIssueCommentAttachment(
  orgSlug: string,
  issueId: string,
  video: LocalVideo,
): Promise<CommentAttachment> {
  const regionUrl = await resolveOrgRegion(orgSlug);
  const url = `${regionUrl.replace(/\/$/, "")}/api/0/organizations/${encodeURIComponent(orgSlug)}/issues/${encodeURIComponent(issueId)}/comment-attachments/`;
  const form = new FormData();
  form.append(
    "file",
    new Blob([new Uint8Array(video.data)], { type: video.contentType }),
    video.name,
  );

  let response: Response;
  try {
    response = await getSdkConfig(regionUrl).fetch(url, {
      method: "POST",
      body: form,
    });
  } catch (error) {
    if (isNetworkError(error)) {
      throwApiError(error, undefined, "Video upload failed");
    }
    throw error;
  }
  if (!response.ok) {
    await throwRawApiError(response, url, "Video upload failed");
  }
  return parse(CommentAttachmentSchema, await response.json());
}

/** Post a comment with videos uploaded first and linked after the text. */
export async function createIssueCommentWithVideos(
  orgSlug: string,
  issueId: string,
  text: string,
  videos: readonly LocalVideo[],
): Promise<{ comment: IssueComment; attachments: CommentAttachment[] }> {
  const attachments: CommentAttachment[] = [];
  for (const video of videos) {
    attachments.push(
      await uploadIssueCommentAttachment(orgSlug, issueId, video),
    );
  }
  const comment = await createIssueComment(
    orgSlug,
    issueId,
    appendCommentAttachments(text, attachments),
  );
  return { comment, attachments };
}

/**
 * Download one attached video to `destPath`, streaming so large recordings
 * never sit in memory.
 *
 * The URL is rebuilt from the issue and the numeric attachment ID instead of
 * the link in the comment, which anyone in the organization can write.
 */
export async function downloadIssueCommentAttachment(
  orgSlug: string,
  issueId: string,
  attachmentId: string,
  destPath: string,
): Promise<void> {
  if (!/^\d+$/.test(attachmentId)) {
    throw new ValidationError(`Invalid attachment ID: ${attachmentId}`);
  }
  const regionUrl = await resolveOrgRegion(orgSlug);
  const url = `${regionUrl.replace(/\/$/, "")}${commentAttachmentPath(orgSlug, issueId, attachmentId)}`;
  const response = await getSdkConfig(regionUrl).fetch(url, {
    method: "GET",
  });
  if (!(response.ok && response.body)) {
    await throwRawApiError(response, url, "Video download failed");
  }
  const body = response.body as NodeReadableStream<Uint8Array<ArrayBuffer>>;
  await pipeline(Readable.fromWeb(body), createWriteStream(destPath));
}
