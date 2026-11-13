/**
 * Tests for DSN file system utilities.
 *
 * Verifies that handleFileError correctly distinguishes expected filesystem
 * errors (ignored, debug-logged) from unexpected ones (reported to Sentry).
 */

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { reportCliError } = vi.hoisted(() => ({
  reportCliError: vi.fn(),
}));

vi.mock("../../../src/lib/error-reporting.js", () => ({ reportCliError }));
vi.mock("@sentry/node", () => ({
  startSpan: (_opts: unknown, fn: () => unknown) => fn(),
}));

const { handleFileError } = await import("../../../src/lib/dsn/fs-utils.js");

/** Create an Error with a `code` property, mimicking Node/Bun errno errors. */
function errnoError(code: string, message?: string): Error {
  const err = new Error(message ?? code) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

describe("handleFileError", () => {
  beforeEach(() => {
    reportCliError.mockClear();
  });

  afterEach(() => {
    reportCliError.mockClear();
  });

  describe("ignorable errors (should NOT report to Sentry)", () => {
    test("ENOENT — file does not exist", () => {
      handleFileError(errnoError("ENOENT"), {
        operation: "test",
        path: "/missing",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("EACCES — permission denied", () => {
      handleFileError(errnoError("EACCES"), {
        operation: "test",
        path: "/secret",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("EPERM — operation not permitted", () => {
      handleFileError(errnoError("EPERM"), {
        operation: "test",
        path: "/locked",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("EISDIR — path is a directory, not a file", () => {
      handleFileError(
        errnoError("EISDIR", "Directories cannot be read like files"),
        {
          operation: "checkEnvForDsn",
          path: "/project/.env",
        },
      );
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("ENOTDIR — path component is not a directory", () => {
      handleFileError(errnoError("ENOTDIR"), {
        operation: "test",
        path: "/file.txt/child",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("ETIMEDOUT — connection timed out on a network mount", () => {
      handleFileError(errnoError("ETIMEDOUT"), {
        operation: "scandir",
        path: "/mnt/cloud-storage",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("ENOTCONN — scandir on a disconnected network or FUSE mount", () => {
      handleFileError(
        errnoError("ENOTCONN", "ENOTCONN: socket is not connected, scandir"),
        {
          operation: "scan.walk.readdir",
          path: "/mnt/remote",
        },
      );
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("UNKNOWN code — non-POSIX error with UNKNOWN code", () => {
      handleFileError(errnoError("UNKNOWN", "Unknown system error -11"), {
        operation: "scandir",
        path: "/Users/austin/Documents/app-audit.trace",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });

    test("Unknown system error — macOS non-POSIX errno with no standard code", () => {
      const err = new Error(
        "Unknown system error -11: Unknown system error -11, scandir '/Users/austin/Documents/app-audit.trace'",
      ) as NodeJS.ErrnoException;
      // No code property — Node.js couldn't map errno to a POSIX name
      handleFileError(err, {
        operation: "scandir",
        path: "/Users/austin/Documents/app-audit.trace",
      });
      expect(reportCliError).not.toHaveBeenCalled();
    });
  });

  describe("unhealthy mounts and virtual filesystems (should NOT report)", () => {
    // Real readdir failures seen in CLI-1ES: /proc (EINVAL), OneDrive FUSE
    // (EIO), stale AppImage / FreeRDP mounts under /tmp (ENOTCONN), macOS
    // .trace bundles (ECANCELED), Bun on cloud-storage dirs (EINTR).
    test.each([
      "EINVAL",
      "EIO",
      "ECANCELED",
      "EINTR",
      "EAGAIN",
      "EBUSY",
      "ESTALE",
      "EHOSTDOWN",
      "ELOOP",
    ])("%s from scandir", (code) => {
      const err = errnoError(code, `${code}: failed, scandir '/mnt/x'`);
      (err as NodeJS.ErrnoException).syscall = "scandir";
      handleFileError(err, { operation: "scan.walk.readdir", path: "/mnt/x" });
      expect(reportCliError).not.toHaveBeenCalled();
    });
  });

  describe("unexpected errors (SHOULD report to Sentry)", () => {
    test.each(["EMFILE", "ENFILE", "EBADF"])(
      "%s — descriptor misuse/exhaustion caused by the CLI",
      (code) => {
        handleFileError(errnoError(code), { operation: "scan.walk.readdir" });
        expect(reportCliError).toHaveBeenCalledTimes(1);
      },
    );

    test("Node ERR_* codes — API misuse in our own code", () => {
      handleFileError(errnoError("ERR_INVALID_ARG_TYPE"), {
        operation: "test",
      });
      expect(reportCliError).toHaveBeenCalledTimes(1);
    });

    test("ENOMEM — out of memory", () => {
      handleFileError(errnoError("ENOMEM"), { operation: "test" });
      expect(reportCliError).toHaveBeenCalledTimes(1);
    });

    test("generic Error without code", () => {
      handleFileError(new Error("something broke"), { operation: "test" });
      expect(reportCliError).toHaveBeenCalledTimes(1);
    });

    test("non-Error value", () => {
      handleFileError("string error", { operation: "test" });
      expect(reportCliError).toHaveBeenCalledTimes(1);
    });
  });

  test("passes context tags and extras to Sentry", () => {
    const error = new Error("unexpected");
    handleFileError(error, {
      operation: "checkEnvForDsn",
      path: "/project/.env",
    });
    expect(reportCliError).toHaveBeenCalledWith(error, {
      tags: { operation: "checkEnvForDsn" },
      extra: { path: "/project/.env" },
    });
  });
});
