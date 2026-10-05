import fs from "node:fs";
import path from "node:path";
import { ApiError } from "../../errors.js";
import type { ToolPayload, ToolResult } from "../types.js";

/**
 * Resolve a path relative to cwd and verify it stays inside the project root.
 */
export function safePath(cwd: string, relative: string): string {
  const resolved = path.resolve(cwd, relative);
  const normalizedCwd = path.resolve(cwd);
  if (
    !resolved.startsWith(normalizedCwd + path.sep) &&
    resolved !== normalizedCwd
  ) {
    throw new Error(`Path "${relative}" resolves outside project directory`);
  }

  let realCwd: string;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    realCwd = fs.realpathSync(normalizedCwd);
  } catch {
    return resolved;
  }

  let checkPath = resolved;
  for (;;) {
    try {
      const real = fs.realpathSync(checkPath);
      if (!real.startsWith(realCwd + path.sep) && real !== realCwd) {
        throw new Error(
          `Path "${relative}" resolves outside project directory via symlink`
        );
      }
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        throw error;
      }

      const parent = path.dirname(checkPath);
      if (parent === checkPath) {
        break;
      }
      checkPath = parent;
    }
  }

  return resolved;
}

/**
 * Resolve a tool cwd inside the selected project root, or reject it.
 *
 * The returned real path pins any safe cwd symlink before tool execution.
 */
export function validateToolSandbox(
  payload: Pick<ToolPayload, "cwd">,
  directory: string
): { cwd: string } | ToolResult {
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const realDirectory = fs.realpathSync(path.resolve(directory));
    const realCwd = fs.realpathSync(path.resolve(payload.cwd));
    const relativeCwd = path.relative(realDirectory, realCwd);
    const isInsideDirectory =
      relativeCwd === "" ||
      (relativeCwd !== ".." &&
        !relativeCwd.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relativeCwd));

    if (isInsideDirectory && fs.statSync(realCwd).isDirectory()) {
      // Execute against the resolved directory so a symlinked cwd cannot be
      // retargeted between this boundary check and the tool implementation.
      return { cwd: realCwd };
    }
  } catch {
    // Missing or unreadable roots fail closed at the shared tool boundary.
  }

  return {
    ok: false,
    error: `Blocked: cwd "${payload.cwd}" is outside project directory "${directory}" or cannot be resolved`,
  };
}

/**
 * Format thrown tool errors into user-facing strings.
 */
export function formatToolError(error: unknown): string {
  if (error instanceof ApiError) {
    return error.format();
  }
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}
