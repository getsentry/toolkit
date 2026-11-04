/**
 * Loader for the Ink select picker.
 *
 * The picker itself lives in a self-contained sidecar (`ink-app.tsx`, built
 * to `ink-app.js` with ink, react, and yoga-layout inlined) so React stays
 * out of the main CLI bundle. {@link selectWithFilter} imports the sidecar
 * on first use and mounts the picker.
 *
 * **Stdin.** The picker reads keys from a freshly opened `/dev/tty`
 * `ReadStream` and closes it after the selection, so its raw-mode reads
 * never touch `process.stdin`, which later prompts in the same run still
 * use. It was added for runtimes whose `process.stdin` accepts
 * `setRawMode(true)` but never delivers `readable` events
 * (vadimdemedes/ink#636).
 */

import { openSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { ReadStream } from "node:tty";
import { stripAnsi } from "../formatters/plain-detect.js";
import type { SelectOptions, SelectPrompt } from "./types.js";

const _require = createRequire(import.meta.url);

// The sidecar's path for this runtime; `loadInkApp` explains each case.
// @ts-expect-error: `with { type: "file" }` handled by text-import-plugin at build time
import inkAppPath from "./ink-app.tsx" with { type: "file" };

/**
 * Open a fresh `/dev/tty` `ReadStream` for Ink to consume. Returns
 * `null` when `/dev/tty` isn't available (non-TTY environment, or
 * platforms that don't expose it — Windows). The caller falls back
 * to `process.stdin` in that case.
 */
function openFreshTtyForInk(): ReadStream | null {
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    const fd = openSync("/dev/tty", "r");
    return new ReadStream(fd);
  } catch {
    return null;
  }
}

/** Load the self-contained Ink sidecar without importing React into the CLI bundle. */
async function loadInkApp(): Promise<typeof import("./ink-app.js")> {
  // Import the Ink App sidecar. Three runtime contexts:
  //
  // 1. Node SEA binary: the sidecar is embedded as a SEA asset.
  //    Extract it via node:sea.getAsset(), write to a temp file,
  //    and import() it.
  //
  // 2. Node/npm (npx sentry@latest): inkAppPath is a relative path
  //    like "./ink-app.js" (emitted by text-import-plugin as a
  //    string literal). Resolve it to an absolute file:// URL using
  //    import.meta.url so Node's dynamic import() can load the
  //    self-contained ESM sidecar from the dist/ directory.
  //
  // 3. Dev mode (pnpm run cli): inkAppPath is the absolute
  //    filesystem path to ink-app.tsx.
  let importPath: string;
  let seaTmpDir: string | undefined;

  // Check if running inside a Node SEA binary
  let isSea = false;
  // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
  try {
    // oxlint-disable-next-line typescript/no-explicit-any -- node:sea types not yet in @types/node
    const sea = _require("node:sea") as any;
    isSea = sea.isSea?.() === true;
  } catch {
    // node:sea not available (older Node or non-SEA context)
  }

  if (isSea) {
    // Extract the embedded sidecar to a temp file and import it.
    // The asset key matches what fossilize registered via --assets.
    // oxlint-disable-next-line typescript/no-explicit-any -- node:sea types not yet in @types/node
    const sea = _require("node:sea") as any;
    const { writeFileSync, mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const tmpDir = mkdtempSync(join(tmpdir(), "sentry-ink-"));
    const tmpFile = join(tmpDir, "ink-app.js");
    writeFileSync(tmpFile, sea.getAsset("dist-build/ink-app.js", "utf-8"));
    // Node's dynamic import() requires file:// URLs for absolute paths on Windows
    const { pathToFileURL } = await import("node:url");
    importPath = pathToFileURL(tmpFile).href;
    seaTmpDir = tmpDir;
  } else if (inkAppPath.startsWith("./")) {
    // Node/npm bundle — resolve relative to the bundle location
    importPath = new URL(inkAppPath, import.meta.url).href;
  } else {
    // Dev mode — absolute filesystem path
    importPath = inkAppPath;
  }
  const app = (await import(importPath)) as typeof import("./ink-app.js");

  // Clean up SEA temp file — module is cached in memory after import()
  if (seaTmpDir) {
    // oxlint-disable-next-line sentry-cli/no-silent-catch -- grandfathered silent catch — see #1531; drain by adding log.debug()/log.warn() or re-throwing.
    try {
      const { rmSync } = await import("node:fs");
      rmSync(seaTmpDir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }

  return app;
}

/** Build the prompt the sidecar renders from the caller's options. */
function createSelectPrompt(
  opts: SelectOptions<string>,
  resolve: (value: string | null) => void,
): SelectPrompt {
  return {
    message: stripAnsi(opts.message),
    options: opts.options.map((option) => ({
      value: option.value,
      label: option.label,
      ...(option.hint ? { hint: option.hint } : {}),
    })),
    initialIndex:
      opts.initialValue !== undefined
        ? Math.max(
            0,
            opts.options.findIndex(
              (option) => option.value === opts.initialValue,
            ),
          )
        : 0,
    resolve,
  };
}

/**
 * Show an inline entity picker with type-to-filter. Loads the sidecar
 * lazily and releases terminal resources after selection.
 *
 * @param opts - Choices, prompt copy, and initial selection. Filtering is always enabled.
 * @returns The selected value, or `null` on cancellation or exit without a choice.
 * @throws Propagates loading, rendering, and terminal cleanup failures.
 */
export async function selectWithFilter(
  opts: SelectOptions<string>,
): Promise<string | null> {
  const app = await loadInkApp();
  const freshStdin = openFreshTtyForInk();
  const stdin = freshStdin ?? process.stdin;
  const wasRaw = stdin.isRaw ?? false;
  let instance: InkInstance | undefined;
  let resolveSelection!: (value: string | null) => void;
  const selection = new Promise<string | null>((resolve) => {
    resolveSelection = resolve;
  });
  const cancel = () => resolveSelection(null);
  process.once("SIGINT", cancel);
  try {
    instance = app.mountSelectPrompt(
      createSelectPrompt(opts, resolveSelection),
      { stdin, exitOnCtrlC: false, patchConsole: false },
    );
    // Surface renderer failures instead of waiting forever for a selection.
    return await Promise.race([
      selection,
      instance.waitUntilExit().then(() => null),
    ]);
  } finally {
    process.removeListener("SIGINT", cancel);
    // Each resource must be released even if an earlier cleanup step fails.
    try {
      instance?.clear();
    } finally {
      try {
        instance?.unmount();
        await instance?.waitUntilExit();
      } finally {
        try {
          stdin.setRawMode?.(wasRaw);
        } finally {
          if (freshStdin) {
            try {
              freshStdin.pause();
            } finally {
              freshStdin.destroy();
            }
          }
        }
      }
    }
  }
}

/**
 * Subset of the Ink `Instance` type we actually use.
 *
 * Defined structurally rather than imported from `ink` so the
 * dynamic-import boundary doesn't leak Ink types into this module.
 */
type InkInstance = {
  unmount: () => void;
  waitUntilExit: () => Promise<unknown>;
  /** Clears the picker from the terminal when it closes. */
  clear: () => void;
};
