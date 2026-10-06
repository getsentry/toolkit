/**
 * sentry proguard uuid <path>
 *
 * Compute and print the deterministic UUID for a ProGuard/R8 mapping file.
 * This is the same UUID that `sentry proguard upload` assigns, derived purely
 * from the file contents. Matches legacy `sentry-cli proguard uuid`.
 */

import { readFile } from "node:fs/promises";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { computeProguardUuid } from "../../lib/proguard.js";

/** Structured result for the proguard uuid command. */
type ProguardUuidResult = {
  /** Absolute or user-supplied path to the mapping file. */
  path: string;
  /** The computed mapping UUID. */
  uuid: string;
};

export const uuidCommand = buildCommand({
  docs: {
    brief: "Compute the UUID for a ProGuard mapping file",
    fullDescription:
      "Compute and print the UUID of a ProGuard/R8 mapping file. The UUID is " +
      "deterministically derived from the file contents and matches the " +
      "value assigned by `sentry proguard upload`.\n\n" +
      "Usage:\n" +
      "  sentry proguard uuid ./app/build/outputs/mapping/release/mapping.txt\n" +
      "  sentry proguard uuid mapping.txt --json",
  },
  // Purely local file operation — no Sentry API calls, no auth needed.
  auth: false,
  output: {
    // Print only the bare UUID for human/plain output (scriptable, matches
    // legacy `sentry-cli proguard uuid`). JSON output includes the path.
    human: (data: ProguardUuidResult) => data.uuid,
    jsonExclude: [],
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Path to the ProGuard mapping file",
          parse: String,
          placeholder: "path",
        },
      ],
    },
    flags: {},
  },
  async *func(
    this: SentryContext,
    _flags: Record<string, never>,
    path: string
  ) {
    if (!path?.trim()) {
      throw new ContextError(
        "Mapping file path",
        "sentry proguard uuid <path>",
        []
      );
    }

    let content: Buffer;
    try {
      content = await readFile(path);
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === "ENOENT") {
        throw new ValidationError(
          `ProGuard mapping file '${path}' does not exist.`,
          "path"
        );
      }
      if (code === "EISDIR") {
        throw new ValidationError(
          `Path '${path}' is a directory, not a ProGuard mapping file.`,
          "path"
        );
      }
      const msg = err instanceof Error ? err.message : String(err);
      throw new ValidationError(
        `Cannot read ProGuard mapping file '${path}': ${msg}`,
        "path"
      );
    }

    const uuid = computeProguardUuid(content);
    yield new CommandOutput<ProguardUuidResult>({ path, uuid });
    return {};
  },
});
