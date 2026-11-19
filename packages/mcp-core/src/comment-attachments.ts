/**
 * Videos attached to issue comments.
 *
 * Sentry stores each upload through the issue's `comment-attachments/`
 * endpoint and the comment text links to it as Markdown. The CLI and the MCP
 * server share these helpers so both accept the same files and read the same
 * links back out of comment text.
 */

/** Video types Sentry accepts for comment attachments, keyed by extension. */
const VIDEO_TYPES_BY_EXTENSION: Readonly<Record<string, string>> = {
  mp4: "video/mp4",
  m4v: "video/mp4",
  mov: "video/quicktime",
  webm: "video/webm",
  ogv: "video/ogg",
  ogg: "video/ogg",
};

/** File extensions accepted for comment attachments, for help text. */
export const COMMENT_ATTACHMENT_EXTENSIONS = Object.keys(
  VIDEO_TYPES_BY_EXTENSION,
);

function startsWith(
  bytes: Uint8Array,
  signature: readonly number[],
  offset = 0,
) {
  return signature.every((byte, index) => bytes[offset + index] === byte);
}

/** True when the bytes begin like a container of the given video type. */
function hasVideoSignature(contentType: string, bytes: Uint8Array): boolean {
  switch (contentType) {
    case "video/mp4":
    case "video/quicktime":
      // ISO base media: a box size, then the `ftyp` box type.
      return startsWith(bytes, [0x66, 0x74, 0x79, 0x70], 4);
    case "video/webm":
      // EBML header.
      return startsWith(bytes, [0x1a, 0x45, 0xdf, 0xa3]);
    case "video/ogg":
      return startsWith(bytes, [0x4f, 0x67, 0x67, 0x53]); // "OggS"
    default:
      return false;
  }
}

/**
 * Content type to upload a file as, or null when it is not a supported video.
 *
 * Both the extension and the file's leading bytes must match, so a renamed
 * text file, key or document is never sent as a video.
 */
export function commentAttachmentContentType(
  fileName: string,
  bytes: Uint8Array,
): string | null {
  const extension = fileName.split(".").pop()?.toLowerCase() ?? "";
  const contentType = VIDEO_TYPES_BY_EXTENSION[extension];
  if (!contentType || !hasVideoSignature(contentType, bytes)) {
    return null;
  }
  return contentType;
}

/** A video uploaded to an issue, as the upload endpoint returns it. */
export type CommentAttachment = {
  id: string;
  name: string;
  size: number;
  contentType: string;
  /** API path, e.g. `/api/0/organizations/org/issues/1/comment-attachments/5/`. */
  url: string;
};

/** A video linked from comment text. */
export type CommentAttachmentLink = {
  id: string;
  name: string;
  /** API path of the video, as written in the comment. */
  path: string;
};

// Org and issue segments are slugs, numeric IDs or short IDs, so `.`/`..`
// segments and encoded characters never match: a link written by anyone in
// the org cannot point a download at another API route.
const ATTACHMENT_LINK =
  /\[((?:\\.|[^\]\\])*)\]\((\/api\/0\/organizations\/[\w-]+\/issues\/[\w-]+\/comment-attachments\/(\d+)\/)\)/g;

/**
 * API path of a video attached to an issue's comments. Built from the issue
 * being read rather than taken from the comment link, which anyone in the
 * organization can write.
 */
export function commentAttachmentPath(
  organizationSlug: string,
  issueId: string,
  attachmentId: string,
): string {
  return `/api/0/organizations/${encodeURIComponent(organizationSlug)}/issues/${encodeURIComponent(issueId)}/comment-attachments/${encodeURIComponent(attachmentId)}/`;
}

/** Markdown link for an uploaded video, with link-text brackets escaped. */
export function commentAttachmentMarkdown(attachment: {
  name: string;
  url: string;
}): string {
  const label = attachment.name.replace(/([\\[\]])/g, "\\$1");
  return `[${label}](${attachment.url})`;
}

/** Videos linked from a comment's text, in the order they appear. */
export function parseCommentAttachments(
  text: string | null | undefined,
): CommentAttachmentLink[] {
  if (!text) {
    return [];
  }
  return Array.from(text.matchAll(ATTACHMENT_LINK), (match) => ({
    id: match[3] ?? "",
    name: (match[1] ?? "").replace(/\\([\\[\]])/g, "$1"),
    path: match[2] ?? "",
  }));
}

/** Comment text with each uploaded video's link appended on its own line. */
export function appendCommentAttachments(
  text: string,
  attachments: ReadonlyArray<{ name: string; url: string }>,
): string {
  const links = attachments.map(commentAttachmentMarkdown);
  return [text.trimEnd(), ...links].filter((line) => line !== "").join("\n");
}
