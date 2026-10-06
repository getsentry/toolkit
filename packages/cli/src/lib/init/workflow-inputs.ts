import { MAX_FILE_BYTES } from "./constants.js";
import { detectSentry } from "./tools/detect-sentry.js";
import { listDir } from "./tools/list-dir.js";
import {
  closeProjectFile,
  type OpenedProjectFile,
  openProjectFile,
  projectFileChanged,
} from "./tools/project-file.js";
import type { DirEntry } from "./types.js";

/**
 * Common config files that multiple init steps frequently inspect.
 */
const COMMON_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "pyproject.toml",
  "requirements.txt",
  "requirements-dev.txt",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "Gemfile",
  "Gemfile.lock",
  "go.mod",
  "build.gradle",
  "build.gradle.kts",
  "settings.gradle",
  "settings.gradle.kts",
  "pom.xml",
  "Cargo.toml",
  "pubspec.yaml",
  "mix.exs",
  "composer.json",
  "Podfile",
  "CMakeLists.txt",
  "next.config.js",
  "next.config.mjs",
  "next.config.ts",
  "nuxt.config.ts",
  "nuxt.config.js",
  "angular.json",
  "astro.config.mjs",
  "astro.config.ts",
  "svelte.config.js",
  "remix.config.js",
  "vite.config.ts",
  "vite.config.js",
  "webpack.config.js",
  "metro.config.js",
  "app.json",
  "electron-builder.yml",
  "wrangler.toml",
  "wrangler.jsonc",
  "serverless.yml",
  "serverless.ts",
  "bunfig.toml",
  "manage.py",
  "app.py",
  "main.py",
  "artisan",
  "symfony.lock",
  "wp-config.php",
  "config/packages/sentry.yaml",
  "appsettings.json",
  "Program.cs",
  "Startup.cs",
  "app/build.gradle",
  "app/build.gradle.kts",
  "src/main/resources/application.properties",
  "src/main/resources/application.yml",
  "config/application.rb",
  "main.go",
  "sentry.client.config.ts",
  "sentry.client.config.js",
  "sentry.server.config.ts",
  "sentry.server.config.js",
  "sentry.edge.config.ts",
  "sentry.edge.config.js",
  "sentry.properties",
  "instrumentation.ts",
  "instrumentation.js",
] as const;

const MAX_PREREAD_TOTAL_BYTES = 512 * 1024;

/**
 * Pre-compute the initial directory listing before the first workflow call.
 */
export async function precomputeDirListing(
  directory: string
): Promise<DirEntry[]> {
  const result = await listDir({
    type: "tool",
    operation: "list-dir",
    cwd: directory,
    params: { path: ".", recursive: true, maxDepth: 3, maxEntries: 500 },
  });
  return (result.data as { entries?: DirEntry[] } | undefined)?.entries ?? [];
}

/**
 * Pre-read common config files to avoid repeated suspend/resume round-trips.
 */
export async function preReadCommonFiles(
  directory: string,
  dirListing: DirEntry[]
): Promise<Record<string, string | null>> {
  // `listDir` emits POSIX-normalized paths regardless of host OS,
  // so `COMMON_CONFIG_FILES` (POSIX) membership checks don't need
  // any per-path separator translation.
  const listingPaths = new Set(dirListing.map((entry) => entry.path));
  const toRead = COMMON_CONFIG_FILES.filter((filePath) =>
    listingPaths.has(filePath)
  );

  const cache: Record<string, string | null> = {};
  let totalBytes = 0;

  for (const filePath of toRead) {
    if (totalBytes >= MAX_PREREAD_TOTAL_BYTES) {
      break;
    }
    const result = await readCommonConfigFile(directory, filePath);
    if (result.status === "unreadable") {
      cache[filePath] = null;
      continue;
    }
    if (
      result.status === "read" &&
      totalBytes + result.bytes <= MAX_PREREAD_TOTAL_BYTES
    ) {
      cache[filePath] = result.content;
      totalBytes += result.bytes;
    }
  }

  return cache;
}

type CommonConfigRead =
  | { status: "skipped" | "unreadable" }
  | { bytes: number; content: string; status: "read" };

async function readCommonConfigFile(
  directory: string,
  filePath: string
): Promise<CommonConfigRead> {
  let opened: OpenedProjectFile | undefined;
  // biome-ignore lint/plugin: grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const result = await openProjectFile(directory, filePath);
    if ("error" in result) {
      return { status: "unreadable" };
    }
    opened = result;
    if (opened.stat.size > MAX_FILE_BYTES) {
      return { status: "skipped" };
    }

    const buffer = Buffer.alloc(opened.stat.size);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const readResult = await opened.handle.read(
        buffer,
        bytesRead,
        buffer.length - bytesRead,
        bytesRead
      );
      if (readResult.bytesRead === 0) {
        return { status: "unreadable" };
      }
      bytesRead += readResult.bytesRead;
    }
    if (projectFileChanged(opened.stat, await opened.handle.stat())) {
      return { status: "unreadable" };
    }
    return {
      bytes: bytesRead,
      content: buffer.subarray(0, bytesRead).toString("utf-8"),
      status: "read",
    };
  } catch {
    return { status: "unreadable" };
  } finally {
    if (opened) {
      await closeProjectFile(opened.handle);
    }
  }
}

/**
 * Pre-compute local Sentry detection so the workflow can start with that context.
 */
export async function precomputeSentryDetection(directory: string) {
  return await detectSentry(directory);
}
