/**
 * Issue comment command integration tests.
 *
 * Exercise routing, issue resolution, the HTTP client, video checks, and
 * output together. Only the external HTTP boundary is mocked.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { run } from "@stricli/core";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { app } from "../../../src/app.js";
import type { SentryContext } from "../../../src/context.js";
import { setAuthToken } from "../../../src/lib/db/auth.js";
import { setOrgRegion } from "../../../src/lib/db/regions.js";
import { mockFetch, useEnvSandbox, useTestConfigDir } from "../../helpers.js";

const getConfigDir = useTestConfigDir("issue-comments-", {
  isolateProjectRoot: true,
});
useEnvSandbox(["SENTRY_AUTH_TOKEN", "SENTRY_TOKEN", "SENTRY_PLAIN_OUTPUT"]);

const REGION_URL = "https://de.sentry.io";
const ISSUE_PATH = "/api/0/organizations/test-org/issues/12345/";
const ISSUE = {
  id: "12345",
  shortId: "FRONT-ABC",
  title: "Example application error",
  count: "1000",
  userCount: 20,
  status: "unresolved",
  project: { id: "42", slug: "frontend", name: "Frontend" },
  permalink: "https://test-org.sentry.io/issues/12345/",
};
const MP4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 0x69]);
const VIDEO_PATH = `${ISSUE_PATH}comment-attachments/7/`;
const VIDEO_BYTES = "video-bytes";

let originalFetch: typeof globalThis.fetch;
let requests: Request[];
let uploads: Array<{ name: string; type: string; size: number }>;
let postedText: string | undefined;
let uploadStatus: number;
let commentsBody: unknown[] | undefined;

beforeEach(() => {
  originalFetch = globalThis.fetch;
  requests = [];
  uploads = [];
  postedText = undefined;
  uploadStatus = 201;
  commentsBody = undefined;
  setAuthToken("test-token");
  setOrgRegion("test-org", REGION_URL);
  globalThis.fetch = mockFetch(async (input, init) => {
    const request = new Request(input, init);
    requests.push(request);
    const { pathname } = new URL(request.url);
    if (pathname === ISSUE_PATH) {
      return Response.json(ISSUE);
    }
    if (pathname === `${ISSUE_PATH}comment-attachments/`) {
      if (uploadStatus !== 201) {
        return Response.json(
          { detail: "File is too large. The maximum size is 100 MB." },
          { status: uploadStatus },
        );
      }
      const file = (await request.formData()).get("file");
      if (!(file instanceof File)) {
        throw new Error("upload without a file");
      }
      uploads.push({ name: file.name, type: file.type, size: file.size });
      return Response.json(
        {
          id: String(uploads.length),
          name: file.name,
          size: file.size,
          contentType: file.type,
          url: `${ISSUE_PATH}comment-attachments/${uploads.length}/`,
        },
        { status: 201 },
      );
    }
    if (pathname === `${ISSUE_PATH}comments/` && request.method === "POST") {
      postedText = ((await request.json()) as { text: string }).text;
      return Response.json({
        id: "900",
        dateCreated: "2026-10-21T12:00:00Z",
        user: { name: "Jane Developer" },
        data: { text: postedText },
      });
    }
    if (pathname === `${ISSUE_PATH}comments/` && commentsBody) {
      return Response.json(commentsBody);
    }
    if (pathname === `${ISSUE_PATH}comments/`) {
      return Response.json([
        {
          id: "901",
          dateCreated: "2026-10-21T12:00:00Z",
          user: { name: "Jane Developer" },
          data: {
            text: `Crash on save\n[repro.mp4](${VIDEO_PATH})\n[docs](https://docs.sentry.io/)`,
          },
        },
        {
          id: "900",
          dateCreated: "2026-10-20T12:00:00Z",
          user: null,
          sentry_app: { name: "Linear" },
          data: { text: "Linked to an external ticket" },
        },
      ]);
    }
    if (pathname === VIDEO_PATH) {
      return new Response(VIDEO_BYTES, {
        headers: { "Content-Type": "video/mp4" },
      });
    }
    throw new Error(`Unexpected request: ${request.method} ${request.url}`);
  });
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function runCli(args: string[]) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const writer = (sink: string[]) => ({
    write(value: string | Uint8Array) {
      sink.push(String(value));
      return true;
    },
  });
  const context: SentryContext = {
    process: {
      ...process,
      stdout: writer(stdout),
      stderr: writer(stderr),
      exitCode: undefined,
    } as unknown as typeof process,
    env: process.env,
    cwd: getConfigDir(),
    homeDir: getConfigDir(),
    configDir: getConfigDir(),
    stdin: process.stdin,
    stdout: writer(stdout),
    stderr: writer(stderr),
  };
  await run(app, args, context);
  return {
    stdout: stdout.join(""),
    stderr: stderr.join(""),
    exitCode: context.process.exitCode ?? 0,
  };
}

function writeFile(name: string, data: Uint8Array | string): string {
  const path = join(getConfigDir(), name);
  writeFileSync(path, data);
  return path;
}

function postRequests() {
  return requests.filter((request) => request.method === "POST");
}

describe("issue comment", () => {
  test("posts a comment", async () => {
    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Fixed in the next deploy",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(postedText).toBe("Fixed in the next deploy");
    expect(JSON.parse(result.stdout)).toEqual({
      id: "900",
      dateCreated: "2026-10-21T12:00:00Z",
      author: "Jane Developer",
      text: "Fixed in the next deploy",
      attachments: [],
    });
  });

  test("uploads videos and links them after the text", async () => {
    const first = writeFile("repro.mp4", MP4);
    const second = writeFile("take2.mov", MP4);

    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Repro below",
      "--attach",
      first,
      "--attach",
      second,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(uploads).toEqual([
      { name: "repro.mp4", type: "video/mp4", size: MP4.length },
      { name: "take2.mov", type: "video/quicktime", size: MP4.length },
    ]);
    expect(postedText).toBe(
      `Repro below\n[repro.mp4](${ISSUE_PATH}comment-attachments/1/)\n[take2.mov](${ISSUE_PATH}comment-attachments/2/)`,
    );
    expect(JSON.parse(result.stdout).attachments).toEqual([
      {
        id: "1",
        name: "repro.mp4",
        url: `${REGION_URL}${ISSUE_PATH}comment-attachments/1/`,
      },
      {
        id: "2",
        name: "take2.mov",
        url: `${REGION_URL}${ISSUE_PATH}comment-attachments/2/`,
      },
    ]);
    const upload = postRequests()[0];
    expect(upload?.headers.get("Authorization")).toBe("Bearer test-token");
    expect(upload?.headers.get("Content-Type")).toMatch(
      /^multipart\/form-data; boundary=/,
    );
  });

  test("refuses a file that is not a video before uploading anything", async () => {
    const video = writeFile("repro.mp4", MP4);
    const key = writeFile("id_rsa.mp4", "-----BEGIN OPENSSH PRIVATE KEY-----");

    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Repro",
      "--attach",
      video,
      "--attach",
      key,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("id_rsa.mp4 is not a supported video");
    expect(postRequests()).toEqual([]);
  });

  test("refuses a missing file", async () => {
    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Repro",
      "--attach",
      join(getConfigDir(), "missing.mp4"),
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("is not a file");
    expect(postRequests()).toEqual([]);
  });

  test("shows the server's size limit and posts nothing", async () => {
    uploadStatus = 413;
    const video = writeFile("big.mp4", MP4);

    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Repro",
      "--attach",
      video,
    ]);

    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("File is too large");
    expect(postedText).toBeUndefined();
  });

  test("--dry-run checks the files without uploading or posting", async () => {
    const video = writeFile(
      "repro.webm",
      Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3]),
    );

    const result = await runCli([
      "issue",
      "comment",
      "test-org/12345",
      "Repro",
      "--attach",
      video,
      "--dry-run",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({
      text: "Repro",
      dryRun: true,
      attachments: [{ name: "repro.webm" }],
    });
    expect(postRequests()).toEqual([]);
  });
});

describe("issue comments", () => {
  test("--download builds the URL from the issue, not the comment link", async () => {
    const dir = join(getConfigDir(), "videos");
    commentsBody = [
      {
        id: "902",
        dateCreated: "2026-10-21T12:00:00Z",
        user: { name: "Mallory" },
        data: {
          text: "[a.mp4](/api/0/organizations/other-org/issues/999/comment-attachments/7/)\n[b.mp4](/api/0/organizations/../issues/1/comment-attachments/8/)",
        },
      },
    ];

    const result = await runCli([
      "issue",
      "comments",
      "test-org/12345",
      "--download",
      dir,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const downloads = requests
      .filter((request) => request.url.includes("comment-attachments"))
      .map((request) => new URL(request.url).pathname);
    expect(downloads).toEqual([VIDEO_PATH]);
    expect(JSON.parse(result.stdout)[0].attachments).toHaveLength(1);
  });

  test("lists comments with their videos", async () => {
    const result = await runCli([
      "issue",
      "comments",
      "test-org/12345",
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([
      {
        id: "901",
        dateCreated: "2026-10-21T12:00:00Z",
        author: "Jane Developer",
        text: `Crash on save\n[repro.mp4](${VIDEO_PATH})\n[docs](https://docs.sentry.io/)`,
        attachments: [
          { id: "7", name: "repro.mp4", url: `${REGION_URL}${VIDEO_PATH}` },
        ],
      },
      {
        id: "900",
        dateCreated: "2026-10-20T12:00:00Z",
        author: "Linear",
        text: "Linked to an external ticket",
        attachments: [],
      },
    ]);
  });

  test("renders comments for people", async () => {
    const result = await runCli(["issue", "comments", "test-org/12345"]);

    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("Jane Developer");
    expect(result.stdout).toContain("repro.mp4");
    expect(result.stdout).toContain(`${REGION_URL}${VIDEO_PATH}`);
  });

  test("--download saves each video into the directory", async () => {
    const dir = join(getConfigDir(), "videos");
    mkdirSync(dir);

    const result = await runCli([
      "issue",
      "comments",
      "test-org/12345",
      "--download",
      dir,
      "--json",
    ]);

    expect(result.exitCode).toBe(0);
    const savedTo = join(dir, "7-repro.mp4");
    expect(existsSync(savedTo)).toBe(true);
    expect(readFileSync(savedTo, "utf8")).toBe(VIDEO_BYTES);
    expect(JSON.parse(result.stdout)[0].attachments[0].savedTo).toBe(savedTo);
    const download = requests.find(
      (request) => new URL(request.url).pathname === VIDEO_PATH,
    );
    expect(download?.headers.get("Authorization")).toBe("Bearer test-token");
  });
});
