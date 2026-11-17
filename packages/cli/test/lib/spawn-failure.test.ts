/** Tests for the error shown when `local run` or `monitor run` cannot start a command. */

import { describe, expect, test, vi } from "vitest";
import {
  CliError,
  COMMAND_LINE_BREAK_FIELD,
  COMMAND_NOT_FOUND_FIELD,
  ValidationError,
} from "../../src/lib/errors.js";
import { spawnFailureError } from "../../src/lib/spawn-failure.js";
import { whichSync } from "../../src/lib/which.js";

vi.mock("../../src/lib/which.js", () => ({ whichSync: vi.fn() }));

/** A spawn ENOENT, as Node reports it for the program it actually ran. */
function enoent(program: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`spawn ${program} ENOENT`), {
    code: "ENOENT",
  });
}

describe("spawnFailureError", () => {
  test("names the command the user typed, not the resolved target", () => {
    // On Windows a .cmd target runs through cmd.exe, so the errno message
    // names cmd.exe; the user only knows `npm`.
    vi.mocked(whichSync).mockReturnValue(null);
    const error = spawnFailureError("npm", enoent("cmd.exe"));
    expect(error).toBeInstanceOf(ValidationError);
    expect((error as ValidationError).field).toBe(COMMAND_NOT_FOUND_FIELD);
    expect(error.exitCode).toBe(21);
    expect(error.message).toBe(
      "Command not found: npm\n\nCheck that it is installed and on your PATH.",
    );
  });

  test("suggests python3 when python is missing but python3 is on PATH", () => {
    vi.mocked(whichSync).mockImplementation((cmd) =>
      cmd === "python3" ? "/usr/bin/python3" : null,
    );
    expect(spawnFailureError("python", enoent("python")).message).toBe(
      "Command not found: python\n\nDid you mean python3?",
    );
  });

  test("returns a CliError unchanged", () => {
    // e.g. the line-break ValidationError that spawnUserCommand throws.
    const error = new ValidationError("bad argument", COMMAND_LINE_BREAK_FIELD);
    expect(spawnFailureError("npm", error)).toBe(error);
  });

  test("keeps the errno message for other failures", () => {
    const error = spawnFailureError(
      "npm",
      Object.assign(new Error("spawn EACCES"), { code: "EACCES" }),
    );
    expect(error).not.toBeInstanceOf(ValidationError);
    expect(error).toBeInstanceOf(CliError);
    expect(error.message).toBe('Failed to start "npm": spawn EACCES');
  });
});
