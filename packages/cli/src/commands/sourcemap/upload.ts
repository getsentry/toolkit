/**
 * sentry sourcemap upload <dir>
 *
 * Upload sourcemaps to Sentry using debug-ID-based matching.
 * Org/project are resolved via the standard cascade (DSN auto-detection,
 * env vars, config defaults) — no slash-separated arg parsing needed.
 */

import { relative, resolve } from "node:path";
import {
  dirname as posixDirname,
  relative as posixRelative,
} from "node:path/posix";
import type { SentryContext } from "../../context.js";
import {
  type ArtifactFile,
  uploadSourcemaps,
} from "../../lib/api/sourcemaps.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ValidationError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { resolveOrgAndProject } from "../../lib/resolve-target.js";
import {
  assertDirectoryReadable,
  buildEmptyDiscoveryError,
  buildIgnoreMatcher,
  diagnoseEmptyDiscovery,
  discoverFilePairs,
  type InjectResult,
  injectDirectory,
} from "../../lib/sourcemap/inject.js";

/** Result type for the upload command. */
type UploadCommandResult = {
  /** Organization slug. Omitted when --allow-empty short-circuits before
   * org/project resolution. */
  org?: string;
  /** Project slug. Omitted in the same short-circuit case. */
  project?: string;
  /** Release version, if provided. */
  release?: string;
  /** Distribution identifier, if provided. */
  dist?: string;
  /** Number of file pairs uploaded. */
  filesUploaded: number;
};

/** Format human-readable output for upload results. */
function formatUploadResult(data: UploadCommandResult): string {
  const rows: [string, string][] = [];
  if (data.org) {
    rows.push(["Organization", data.org]);
  }
  if (data.project) {
    rows.push(["Project", data.project]);
  }
  rows.push(["Files uploaded", String(data.filesUploaded)]);
  if (data.release) {
    rows.push(["Release", data.release]);
  }
  if (data.dist) {
    rows.push(["Dist", data.dist]);
  }
  return renderMarkdown(mdKvTable(rows));
}

const USAGE_HINT = "sentry sourcemap upload <directory>";

/**
 * Compute the longest common directory prefix across a list of paths.
 *
 * Strips at directory boundaries only — `["a/bc.js", "a/bd.js"]`
 * yields `"a/"` (not `"a/b"`). Returns `""` when no common dir prefix.
 */
function computeCommonPrefix(paths: string[]): string {
  if (paths.length === 0) {
    return "";
  }
  const sorted = [...paths].sort();
  const first = sorted[0];
  const last = sorted.at(-1);
  if (!(first && last)) {
    return "";
  }
  let common = 0;
  for (let i = 0; i < first.length && i < last.length; i += 1) {
    if (first[i] !== last[i]) {
      break;
    }
    if (first[i] === "/") {
      common = i + 1;
    }
  }
  return first.slice(0, common);
}

/**
 * Strip a prefix from a file path. If the path doesn't start with
 * the prefix, returns it unchanged.
 */
function stripPrefix(path: string, prefix: string): string {
  if (prefix && path.startsWith(prefix)) {
    return path.slice(prefix.length);
  }
  return path;
}

/** Context shared across artifact-file construction for one upload. */
type ArtifactContext = {
  /** Absolute upload directory (paths are made relative to this). */
  resolvedDir: string;
  /** URL prefix applied to every artifact URL (e.g. `"~/"`). */
  urlPrefix: string;
  /** Directory prefix to strip from relative paths (may be empty). */
  pathPrefixToStrip: string;
  /** True when `--no-rewrite` is set (upload as-is, no debug IDs injected). */
  noRewrite: boolean;
};

/** Compute a JS file's URL-space relative path (post-strip, forward slashes). */
function jsRelativePath(jsPath: string, ctx: ArtifactContext): string {
  const rel = relative(ctx.resolvedDir, jsPath).replaceAll("\\", "/");
  return ctx.pathPrefixToStrip ? stripPrefix(rel, ctx.pathPrefixToStrip) : rel;
}

/**
 * Build the `minified_source` + `source_map` artifact pair for a discovered
 * file, dispatching on whether the sourcemap is inline or an external file.
 */
function buildArtifactPair(
  result: InjectResult,
  ctx: ArtifactContext
): ArtifactFile[] {
  const { jsPath, map, debugId } = result;
  const jsRelative = jsRelativePath(jsPath, ctx);
  const debugIdField = debugId ? { debugId } : {};

  if (map.kind === "inline") {
    // Resolve the map bytes to upload:
    // - rewrite path: inject produced the debug-ID-injected map.
    // - --no-rewrite: upload the original inline map decoded at discovery.
    // - rewrite aborted (directive not found): no `injectedMapContent` and not
    //   --no-rewrite → the JS was left unmodified, so upload nothing for it
    //   rather than attaching a debug ID / map the bundle doesn't carry.
    let content = result.injectedMapContent;
    if (!content) {
      if (ctx.noRewrite) {
        content = Buffer.from(map.decoded.json);
      } else {
        return [];
      }
    }
    // Synthetic map URL — the server matches by debug ID, so the filename is
    // cosmetic. Derived from the (post-strip) JS URL.
    const mapRelative = `${jsRelative}.map`;
    return [
      {
        path: jsPath,
        ...debugIdField,
        type: "minified_source",
        url: `${ctx.urlPrefix}${jsRelative}`,
        sourcemapFilename: posixRelative(posixDirname(jsRelative), mapRelative),
      },
      {
        // path is informational for inline maps; content is used instead.
        path: jsPath,
        content,
        ...debugIdField,
        type: "source_map",
        url: `${ctx.urlPrefix}${mapRelative}`,
      },
    ];
  }

  // External map on disk.
  let mapRelative = relative(ctx.resolvedDir, map.mapPath).replaceAll(
    "\\",
    "/"
  );
  if (ctx.pathPrefixToStrip) {
    mapRelative = stripPrefix(mapRelative, ctx.pathPrefixToStrip);
  }
  return [
    {
      path: jsPath,
      // Empty debugId when --no-rewrite: files uploaded without debug IDs,
      // relying on release/URL-based matching instead.
      ...debugIdField,
      type: "minified_source",
      url: `${ctx.urlPrefix}${jsRelative}`,
      // Sourcemap header is resolved relative to the JS file's URL. Compute
      // from post-strip URL-space paths so --strip-prefix doesn't break it.
      sourcemapFilename: posixRelative(posixDirname(jsRelative), mapRelative),
    },
    {
      path: map.mapPath,
      ...debugIdField,
      type: "source_map",
      url: `${ctx.urlPrefix}${mapRelative}`,
    },
  ];
}

export const uploadCommand = buildCommand({
  docs: {
    brief: "Upload sourcemaps to Sentry",
    fullDescription:
      "Upload JavaScript sourcemaps and source files to Sentry using " +
      "debug-ID-based matching.\n\n" +
      "Automatically injects missing debug IDs and runtime registration snippets, preserving existing IDs.\n" +
      "Org/project are auto-detected from DSN, env vars, or config defaults.\n\n" +
      "Exits with an error if zero JS + sourcemap pairs are discovered " +
      "(typical cause: bundler not emitting .map files). Pass " +
      "--allow-empty to suppress this check for directories that may " +
      "legitimately be empty.\n\n" +
      "Usage:\n" +
      "  sentry sourcemap upload ./dist\n" +
      "  sentry sourcemap upload ./dist --release 1.0.0\n" +
      "  sentry sourcemap upload ./dist --release 1.0.0 --dist 12345\n" +
      "  sentry sourcemap upload ./dist --url-prefix '~/static/js/'\n" +
      "  sentry sourcemap upload ./dist --no-rewrite\n" +
      "  sentry sourcemap upload ./dist --ext .js,.mjs\n" +
      "  sentry sourcemap upload ./maybe-empty --allow-empty",
  },
  output: {
    human: formatUploadResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "Directory containing sourcemaps",
          parse: String,
          placeholder: "directory",
        },
      ],
    },
    flags: {
      release: {
        kind: "parsed",
        parse: String,
        brief: "Release version to associate with the upload",
        optional: true,
      },
      dist: {
        kind: "parsed",
        parse: String,
        brief:
          "Distribution identifier to disambiguate builds within a release",
        optional: true,
      },
      "url-prefix": {
        kind: "parsed",
        parse: String,
        brief: "URL prefix for uploaded files (default: ~/)",
        optional: true,
        default: "~/",
      },
      ext: {
        kind: "parsed",
        parse: String,
        brief:
          "Comma-separated file extensions to process (default: .js,.cjs,.mjs)",
        optional: true,
      },
      ignore: {
        kind: "parsed",
        parse: String,
        brief: "Comma-separated glob patterns to exclude (gitignore-style)",
        optional: true,
      },
      "ignore-file": {
        kind: "parsed",
        parse: String,
        brief: "Path to a file with gitignore-style patterns to exclude",
        optional: true,
      },
      "strip-prefix": {
        kind: "parsed",
        parse: String,
        brief: "Strip a prefix from uploaded file paths (e.g. 'build/')",
        optional: true,
      },
      "strip-common-prefix": {
        kind: "boolean",
        brief:
          "Automatically strip the longest common path prefix from all files",
        optional: true,
        default: false,
      },
      "no-rewrite": {
        kind: "boolean",
        brief: "Upload files as-is without injecting debug IDs",
        optional: true,
        default: false,
      },
      "allow-empty": {
        kind: "boolean",
        brief:
          "Exit successfully when no JS + sourcemap pairs are found " +
          "(default: error out to catch silent build misconfigurations)",
        optional: true,
        default: false,
      },
    },
  },
  async *func(
    this: SentryContext,
    flags: {
      release?: string;
      dist?: string;
      "url-prefix"?: string;
      ext?: string;
      ignore?: string;
      "ignore-file"?: string;
      "strip-prefix"?: string;
      "strip-common-prefix"?: boolean;
      "no-rewrite"?: boolean;
      "allow-empty"?: boolean;
    },
    dir: string
  ) {
    // Validate the directory and discover pairs read-only first so we
    // don't write debug IDs when the upload won't proceed (empty dir,
    // typoed path, missing credentials).
    await assertDirectoryReadable(dir);

    const extensions = flags.ext?.split(",").map((e) => e.trim());
    const extSet = extensions
      ? new Set(extensions.map((e) => (e.startsWith(".") ? e : `.${e}`)))
      : undefined;

    const ignorePatterns = flags.ignore
      ? flags.ignore.split(",").map((p) => p.trim())
      : undefined;
    const ignoreMatcher = await buildIgnoreMatcher(
      ignorePatterns,
      flags["ignore-file"]
    );

    const pairs = await discoverFilePairs(dir, extSet, ignoreMatcher);

    if (pairs.length === 0) {
      if (!flags["allow-empty"]) {
        const diag = await diagnoseEmptyDiscovery(dir, { extensions });
        throw buildEmptyDiscoveryError(dir, diag);
      }
      // --allow-empty: nothing to upload, so don't require Sentry
      // credentials. This makes the flag actually usable in the
      // library-only / conditional-release-skip cases the docs name.
      yield new CommandOutput<UploadCommandResult>({
        release: flags.release,
        dist: flags.dist,
        filesUploaded: 0,
      });
      return {
        hint:
          "No JS + sourcemap pairs found in the target directory. " +
          "If this is unexpected, check your bundler emits .map files.",
      };
    }

    // Validate mutually exclusive flags before any file mutation
    if (flags["strip-prefix"] && flags["strip-common-prefix"]) {
      throw new ValidationError(
        "--strip-prefix and --strip-common-prefix are mutually exclusive"
      );
    }

    const resolved = await resolveOrgAndProject({
      cwd: this.cwd,
      usageHint: USAGE_HINT,
    });
    if (!resolved) {
      throw new ContextError("Organization and project", USAGE_HINT);
    }
    const { org, project } = resolved;

    const results: InjectResult[] = flags["no-rewrite"]
      ? pairs.map((p) => ({
          jsPath: p.jsPath,
          map: p.map,
          mapPath: p.map.kind === "external" ? p.map.mapPath : undefined,
          injected: false,
          debugId: "",
        }))
      : await injectDirectory(dir, {
          extensions,
          ignoreMatcher,
        });

    const urlPrefix = flags["url-prefix"] ?? "~/";

    // Build artifact file list with paths relative to the upload directory
    const resolvedDir = resolve(dir);
    // Normalize --strip-prefix to end with "/" so it strips at directory
    // boundaries. Without this, "build" would strip from "build/app.js"
    // leaving "/app.js" instead of "app.js".
    let pathPrefixToStrip = flags["strip-prefix"] ?? "";
    if (pathPrefixToStrip && !pathPrefixToStrip.endsWith("/")) {
      pathPrefixToStrip = `${pathPrefixToStrip}/`;
    }
    if (flags["strip-common-prefix"]) {
      // Only the JS path participates for inline maps (no standalone .map file).
      const allRelative = results.flatMap((r) => {
        const rels = [relative(resolvedDir, r.jsPath).replaceAll("\\", "/")];
        if (r.mapPath) {
          rels.push(relative(resolvedDir, r.mapPath).replaceAll("\\", "/"));
        }
        return rels;
      });
      pathPrefixToStrip = computeCommonPrefix(allRelative);
    }

    const artifactFiles: ArtifactFile[] = results.flatMap((result) =>
      buildArtifactPair(result, {
        resolvedDir,
        urlPrefix,
        pathPrefixToStrip,
        noRewrite: flags["no-rewrite"] ?? false,
      })
    );

    await uploadSourcemaps({
      org,
      project,
      release: flags.release,
      dist: flags.dist,
      files: artifactFiles,
    });

    // Count actually-uploaded pairs (one minified_source entry per pair).
    // buildArtifactPair returns no entries for inline pairs whose rewrite was
    // aborted, so this excludes skipped pairs that results.length would count.
    const filesUploaded = artifactFiles.filter(
      (f) => f.type === "minified_source"
    ).length;

    yield new CommandOutput<UploadCommandResult>({
      org,
      project,
      release: flags.release,
      dist: flags.dist,
      filesUploaded,
    });
  },
});
