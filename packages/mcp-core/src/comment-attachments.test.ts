import { describe, expect, it } from "vitest";
import {
  appendCommentAttachments,
  commentAttachmentContentType,
  commentAttachmentMarkdown,
  parseCommentAttachments,
} from "./comment-attachments";

const MP4 = new Uint8Array([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69]);
const WEBM = new Uint8Array([0x1a, 0x45, 0xdf, 0xa3, 0x01]);
const OGG = new Uint8Array([0x4f, 0x67, 0x67, 0x53, 0x00]);
const TEXT = new TextEncoder().encode("-----BEGIN OPENSSH PRIVATE KEY-----");

const PATH = "/api/0/organizations/my-org/issues/123/comment-attachments/5/";

describe("commentAttachmentContentType", () => {
  it.each([
    ["clip.mp4", MP4, "video/mp4"],
    ["clip.M4V", MP4, "video/mp4"],
    ["clip.mov", MP4, "video/quicktime"],
    ["clip.webm", WEBM, "video/webm"],
    ["clip.ogv", OGG, "video/ogg"],
  ])("accepts %s", (name, bytes, expected) => {
    expect(commentAttachmentContentType(name, bytes)).toBe(expected);
  });

  it.each([
    ["a key renamed to a video", "id_rsa.mp4", TEXT],
    ["a video with the wrong extension", "clip.webm", MP4],
    ["an unsupported extension", "notes.txt", MP4],
    ["a file without an extension", "clip", MP4],
    ["an empty file", "clip.mp4", new Uint8Array()],
  ])("rejects %s", (_label, name, bytes) => {
    expect(commentAttachmentContentType(name, bytes)).toBeNull();
  });
});

describe("parseCommentAttachments", () => {
  it("reads attachment links and ignores other links", () => {
    expect(
      parseCommentAttachments(
        `Repro below\n[repro.mp4](${PATH})\nSee [docs](https://docs.sentry.io/)`,
      ),
    ).toEqual([{ id: "5", name: "repro.mp4", path: PATH }]);
  });

  it("unescapes brackets in the file name", () => {
    expect(parseCommentAttachments(`[take \\[2\\].mp4](${PATH})`)).toEqual([
      { id: "5", name: "take [2].mp4", path: PATH },
    ]);
  });

  it.each([
    "[x](/api/0/organizations/../issues/1/comment-attachments/5/)",
    "[x](/api/0/organizations/my-org/issues/..%2F..%2Fusers/comment-attachments/5/)",
    "[x](/api/0/organizations/my-org/issues/1/comment-attachments/5/../../)",
    "[x](https://evil.example/api/0/organizations/o/issues/1/comment-attachments/5/)",
  ])("ignores a link that is not a plain attachment path: %s", (text) => {
    expect(parseCommentAttachments(text)).toEqual([]);
  });

  it("returns nothing for empty text", () => {
    expect(parseCommentAttachments(null)).toEqual([]);
    expect(parseCommentAttachments("")).toEqual([]);
  });
});

describe("appendCommentAttachments", () => {
  it("adds one link per video after the text", () => {
    expect(
      appendCommentAttachments("Repro  ", [
        { name: "a.mp4", url: PATH },
        { name: "b].mp4", url: PATH },
      ]),
    ).toBe(`Repro\n[a.mp4](${PATH})\n[b\\].mp4](${PATH})`);
  });

  it("round-trips through parseCommentAttachments", () => {
    const text = appendCommentAttachments("x", [
      { name: "we[ir]d\\.mp4", url: PATH },
    ]);
    expect(parseCommentAttachments(text)[0]?.name).toBe("we[ir]d\\.mp4");
  });

  it("escapes link text", () => {
    expect(commentAttachmentMarkdown({ name: "[x]", url: PATH })).toBe(
      `[\\[x\\]](${PATH})`,
    );
  });
});
