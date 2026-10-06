import type fs from "node:fs";
import { TextDecoder } from "node:util";
import type {
  ReadFileErrorCode,
  ReadFilesPayload,
  ReadFilesV2Data,
  ReadFileV2Result,
  ToolResult,
} from "../types.js";
import {
  normalizeProjectFilePath,
  type OpenedProjectFile,
  openProjectFile,
  projectFileChanged,
} from "./project-file.js";
import type { InitToolDefinition } from "./types.js";

const MAX_READ_OUTPUT_BYTES = 40_000;
const MAX_READ_PATHS = 20;
const FILE_READ_CHUNK_BYTES = 64 * 1024;
const PATH_SEGMENT_RE = /[/\\\\]/u;

type ReadWindow = {
  outputBytes: number;
  startLine: number;
};

type LineScan = {
  consumedBytes: number;
  found: boolean;
  skippedLines: number;
};

/**
 * Read one or more files from the sandboxed project directory.
 *
 * Returns independent, bounded line ranges. Callers may issue another read or
 * use grep when they need different evidence. The CLI keeps no continuation
 * state between calls.
 */
export async function readFiles(
  payload: ReadFilesPayload
): Promise<ToolResult> {
  const validated = validateReadRequest(payload);
  if ("error" in validated) {
    return { error: validated.error, ok: false };
  }
  const perFileOutputBytes = Math.max(
    1,
    Math.floor(MAX_READ_OUTPUT_BYTES / validated.paths.length)
  );
  const window = {
    outputBytes: perFileOutputBytes,
    startLine: validated.startLine,
  } satisfies ReadWindow;
  const results = await Promise.all(
    validated.paths.map(async (filePath) => {
      const result = await readSingleFileV2(payload.cwd, filePath, window);
      return [filePath, result] as const;
    })
  );

  return {
    data: {
      files: Object.fromEntries(results),
      version: 2,
    } satisfies ReadFilesV2Data,
    ok: true,
  };
}

async function readSingleFileV2(
  cwd: string,
  filePath: string,
  window: ReadWindow
): Promise<ReadFileV2Result> {
  let opened: OpenedProjectFile | undefined;
  try {
    const result = await openProjectFile(cwd, filePath);
    if ("error" in result) {
      return { error: result.error, status: "error" };
    }
    opened = result;
    if (opened.stat.size === 0) {
      if (projectFileChanged(opened.stat, await opened.handle.stat())) {
        return { error: "unreadable", status: "error" };
      }
      return window.startLine === 1
        ? {
            content: "",
            status: "ok",
            truncated: false,
          }
        : { error: "invalid-range", status: "error" };
    }

    const page = await readTextPage(opened.handle, opened.stat.size, window);
    if (projectFileChanged(opened.stat, await opened.handle.stat())) {
      return { error: "unreadable", status: "error" };
    }
    return page;
  } catch (error) {
    return { error: readErrorCode(error), status: "error" };
  } finally {
    // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    await opened?.handle.close().catch(() => {
      // Preserve the primary read result when descriptor cleanup fails.
    });
  }
}

async function readTextPage(
  handle: fs.promises.FileHandle,
  fileSize: number,
  window: ReadWindow
): Promise<ReadFileV2Result> {
  const located = await locateLineStart(handle, fileSize, window.startLine);
  if ("error" in located) {
    return { error: located.error, status: "error" };
  }

  const pageBytes = Math.min(window.outputBytes, fileSize - located.offset);
  const page = Buffer.alloc(pageBytes);
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytesRead = 0;
  while (bytesRead < pageBytes) {
    const result = await handle.read(
      page,
      bytesRead,
      pageBytes - bytesRead,
      located.offset + bytesRead
    );
    if (result.bytesRead === 0) {
      return { error: "unreadable", status: "error" };
    }
    const nextBytesRead = bytesRead + result.bytesRead;
    if (
      !isTextChunk(
        decoder,
        page.subarray(bytesRead, nextBytesRead),
        located.offset + nextBytesRead < fileSize
      )
    ) {
      return { error: "not-text", status: "error" };
    }
    bytesRead = nextBytesRead;
  }

  if (located.offset + bytesRead === fileSize) {
    return {
      content: page.toString("utf-8"),
      status: "ok",
      truncated: false,
    };
  }

  const lastNewline = page.lastIndexOf(0x0a);
  if (lastNewline === -1) {
    return { error: "line-too-long", status: "error" };
  }
  return {
    content: page.subarray(0, lastNewline + 1).toString("utf-8"),
    status: "ok",
    truncated: true,
  };
}

async function locateLineStart(
  handle: fs.promises.FileHandle,
  fileSize: number,
  startLine: number
): Promise<
  { offset: number } | { error: "invalid-range" | "not-text" | "unreadable" }
> {
  if (startLine === 1) {
    return { offset: 0 };
  }

  const buffer = Buffer.alloc(Math.min(FILE_READ_CHUNK_BYTES, fileSize));
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let linesToSkip = startLine - 1;
  let position = 0;
  while (position < fileSize) {
    const result = await handle.read(
      buffer,
      0,
      Math.min(buffer.length, fileSize - position),
      position
    );
    if (result.bytesRead === 0) {
      return { error: "unreadable" };
    }

    const chunk = buffer.subarray(0, result.bytesRead);
    const scan = scanLineBreaks(chunk, linesToSkip);
    const nextPosition = position + scan.consumedBytes;
    if (
      !isTextChunk(
        decoder,
        chunk.subarray(0, scan.consumedBytes),
        !scan.found && nextPosition < fileSize
      )
    ) {
      return { error: "not-text" };
    }
    if (scan.found) {
      return nextPosition < fileSize
        ? { offset: nextPosition }
        : { error: "invalid-range" };
    }
    linesToSkip -= scan.skippedLines;
    position += result.bytesRead;
  }
  return { error: "invalid-range" };
}

function scanLineBreaks(buffer: Buffer, linesToSkip: number): LineScan {
  let offset = 0;
  for (let skippedLines = 0; skippedLines < linesToSkip; skippedLines += 1) {
    const newline = buffer.indexOf(0x0a, offset);
    if (newline === -1) {
      return {
        consumedBytes: buffer.length,
        found: false,
        skippedLines,
      };
    }
    offset = newline + 1;
  }
  return {
    consumedBytes: offset,
    found: true,
    skippedLines: linesToSkip,
  };
}

function validateReadRequest(
  payload: ReadFilesPayload
): { error: string } | { paths: string[]; startLine: number } {
  const params = (payload as { params?: unknown }).params;
  if (typeof params !== "object" || params === null) {
    return { error: "read-files params must be an object" };
  }
  const { paths, resultVersion, startLine } = params as Partial<
    ReadFilesPayload["params"]
  >;
  if (resultVersion !== 2) {
    return { error: "read-files requires resultVersion 2" };
  }
  const supportedKeys = new Set(["paths", "resultVersion", "startLine"]);
  if (Object.keys(params).some((key) => !supportedKeys.has(key))) {
    return { error: "read-files params include unsupported fields" };
  }
  const normalizedPaths = normalizeReadPaths(paths);
  if ("error" in normalizedPaths) {
    return normalizedPaths;
  }
  if (isInvalidPositiveInteger(startLine)) {
    return {
      error: "read-files startLine must be a positive safe integer",
    };
  }
  const normalizedStartLine = startLine ?? 1;
  if (normalizedStartLine > 1 && normalizedPaths.paths.length !== 1) {
    return { error: "read-files range reads require exactly one path" };
  }
  return { paths: normalizedPaths.paths, startLine: normalizedStartLine };
}

function normalizeReadPaths(
  paths: unknown
): { error: string } | { paths: string[] } {
  if (
    !Array.isArray(paths) ||
    paths.length === 0 ||
    paths.length > MAX_READ_PATHS
  ) {
    return {
      error: `read-files requires between 1 and ${MAX_READ_PATHS} paths`,
    };
  }
  if (
    paths.some(
      (filePath) =>
        typeof filePath !== "string" ||
        filePath.length === 0 ||
        filePath.length > 1000
    )
  ) {
    return { error: "read-files paths must be non-empty bounded strings" };
  }
  const normalizedPaths = (paths as string[]).map(normalizeProjectFilePath);
  if (normalizedPaths.some((filePath) => filePath === undefined)) {
    return {
      error:
        "read-files paths must be portable filesystem-root-relative paths without aliases",
    };
  }
  const canonicalPaths = normalizedPaths as string[];
  if (new Set(canonicalPaths).size !== canonicalPaths.length) {
    return {
      error: "read-files paths must be unique after path normalization",
    };
  }
  return { paths: canonicalPaths };
}

function isInvalidPositiveInteger(value: unknown): boolean {
  return (
    value !== undefined &&
    (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1)
  );
}

function isTextChunk(
  decoder: TextDecoder,
  buffer: Buffer,
  hasMoreBytes: boolean
): boolean {
  if (
    buffer.some(
      (byte) =>
        byte === 0x7f || (byte < 0x20 && ![0x09, 0x0a, 0x0d].includes(byte))
    )
  ) {
    return false;
  }
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    decoder.decode(buffer, { stream: hasMoreBytes });
    return true;
  } catch {
    return false;
  }
}

function readErrorCode(error: unknown): ReadFileErrorCode {
  if (typeof error === "object" && error !== null && "code" in error) {
    if (error.code === "ENOENT") {
      return "not-found";
    }
    if (error.code === "EISDIR") {
      return "not-file";
    }
  }
  return "unreadable";
}

/**
 * Tool definition for batched file reads.
 */
export const readFilesTool: InitToolDefinition<"read-files"> = {
  operation: "read-files",
  describe: (payload) => {
    const [first, second] = payload.params.paths;
    if (!first) {
      return "Reading files...";
    }
    if (!second && payload.params.paths.length === 1) {
      return `Reading \`${pathBase(first)}\`...`;
    }
    if (payload.params.paths.length === 2 && second) {
      return `Reading \`${pathBase(first)}\`, \`${pathBase(second)}\`...`;
    }
    return `Reading ${payload.params.paths.length} files (\`${pathBase(first)}\`${second ? `, \`${pathBase(second)}\`` : ""}, ...)...`;
  },
  execute: readFiles,
};

function pathBase(filePath: string): string {
  const parts = filePath.split(PATH_SEGMENT_RE);
  return parts.at(-1) ?? filePath;
}
