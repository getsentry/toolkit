/**
 * sentry debug-files find <id>...
 *
 * Locate debug-information files for one or more debug identifiers by searching
 * well-known locations (Xcode DerivedData), the current directory, and any
 * extra `--path` directories. Local-only — no API calls.
 *
 * Exits non-zero when any requested id could not be located, mirroring the
 * legacy `sentry-cli difutil find`.
 */

import { stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SentryContext } from "../../context.js";
import { buildCommand } from "../../lib/command.js";
import {
  FIND_DIF_TYPES,
  type FindResult,
  findDebugFiles,
} from "../../lib/dif/find.js";
import { ValidationError } from "../../lib/errors.js";
import { colorTag, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { logger } from "../../lib/logger.js";

const log = logger.withTag("debug-files.find");

/** Xcode's DerivedData location (well-known dSYM store on macOS). */
const DERIVED_DATA = "Library/Developer/Xcode/DerivedData";

/** Flags accepted by `debug-files find`. */
type FindFlags = {
  type?: string[];
  "no-well-known"?: boolean;
  "no-cwd"?: boolean;
  path?: string[];
};

/** Human-readable formatter for the find result. */
function formatFindResult(data: FindResult): string {
  const sections: string[] = [];
  if (data.matches.length > 0) {
    sections.push(
      data.matches
        .map(
          (m) =>
            `${colorTag("muted", m.id)} \`${m.path}\` [${colorTag(
              "yellow",
              m.type
            )}]`
        )
        .join("\n")
    );
  } else {
    sections.push(colorTag("muted", "No debug information files found."));
  }
  if (data.missing.length > 0) {
    const lines = data.missing.map((m) => `  ${m.id} (${m.hint})`).join("\n");
    sections.push(
      `${colorTag("yellow", "Missing debug information files:")}\n${lines}`
    );
  }
  return renderMarkdown(sections.join("\n\n"));
}

/** Resolve the requested types, validating each against the known set. */
function resolveTypes(flags: FindFlags): string[] {
  if (!(flags.type && flags.type.length > 0)) {
    return [...FIND_DIF_TYPES];
  }
  const types = flags.type.map((t) => t.trim().toLowerCase());
  for (const type of types) {
    if (!FIND_DIF_TYPES.includes(type)) {
      throw new ValidationError(
        `Unknown debug file type '${type}'. Valid types: ${FIND_DIF_TYPES.join(
          ", "
        )}`,
        "type"
      );
    }
  }
  return types;
}

/** Build the ordered, de-duplicated list of directories to search. */
async function resolveSearchPaths(
  flags: FindFlags,
  types: string[],
  cwd: string
): Promise<string[]> {
  const paths: string[] = [];
  // dSYMs live in Xcode DerivedData; only search it when dSYMs are wanted.
  if (!flags["no-well-known"] && types.includes("dsym")) {
    const derived = join(homedir(), DERIVED_DATA);
    const info = await stat(derived).catch(() => null);
    if (info?.isDirectory()) {
      paths.push(derived);
    }
  }
  if (!flags["no-cwd"]) {
    paths.push(cwd);
  }
  if (flags.path) {
    paths.push(...flags.path);
  }
  return paths;
}

export const findCommand = buildCommand({
  docs: {
    brief: "Locate debug files for given debug identifiers",
    fullDescription:
      "Locate debug-information files for one or more debug identifiers.\n\n" +
      "Searches Xcode's DerivedData (for dSYMs), the current directory, and " +
      "any extra `--path` directories, matching each file's embedded debug id " +
      "against the requested ids. Local-only — no API calls.\n\n" +
      "Exits non-zero if any id could not be located.\n\n" +
      "Usage:\n" +
      "  sentry debug-files find <debug-id> [<debug-id>...]\n" +
      "  sentry debug-files find <id> --type dsym --path ./build\n" +
      "  sentry debug-files find <id> --no-cwd --no-well-known -p /symbols",
  },
  // Purely local filesystem search — no Sentry API calls, no auth needed.
  auth: false,
  output: {
    human: formatFindResult,
  },
  parameters: {
    positional: {
      kind: "array",
      parameter: {
        placeholder: "id",
        brief: "Debug identifier(s) to search for",
        parse: String,
      },
    },
    flags: {
      type: {
        kind: "parsed",
        parse: String,
        variadic: true,
        brief:
          "Only consider debug files of the given type (repeatable). Default: all",
        optional: true,
      },
      "no-well-known": {
        kind: "boolean",
        brief: "Do not look for debug files in well-known locations",
        optional: true,
      },
      "no-cwd": {
        kind: "boolean",
        brief: "Do not look for debug files in the current directory",
        optional: true,
      },
      path: {
        kind: "parsed",
        parse: String,
        variadic: true,
        brief: "Add a directory to search recursively (repeatable)",
        optional: true,
      },
    },
    aliases: {
      t: "type",
      p: "path",
    },
  },
  async *func(this: SentryContext, flags: FindFlags, ...ids: string[]) {
    if (ids.length === 0) {
      yield new CommandOutput<FindResult>({ matches: [], missing: [] });
      return { hint: "Provide one or more debug identifiers to search for." };
    }

    const types = resolveTypes(flags);
    const paths = await resolveSearchPaths(flags, types, this.cwd);

    const result = await findDebugFiles({ ids, types, paths });
    log.debug(
      `Located ${result.matches.length} file(s); ${result.missing.length} id(s) missing`
    );

    yield new CommandOutput(result);
    if (result.missing.length > 0) {
      // Mirror the legacy CLI: a missing id is a non-zero exit.
      this.process.exitCode = 1;
      return {
        hint: `${result.missing.length} debug identifier(s) could not be located.`,
      };
    }
    return { hint: "All requested debug files were located." };
  },
});
