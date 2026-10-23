/**
 * Resolve which post-init verification strategy to use.
 *
 * Embedded frameworks (Flutter, Expo) cannot be verified by starting a local
 * Spotlight-backed dev server the way web/node apps can. Prefer wizard
 * platform when present, then fall back to filesystem markers.
 */

import { access, readFile } from "node:fs/promises";
import { join } from "node:path";
import { logger } from "../logger.js";

/** Platform doctor verification (`flutter doctor` / `npx expo doctor`). */
export type DoctorStrategy = {
  kind: "doctor";
  tool: "flutter" | "expo";
  /** Args passed to spawn (executable is first element). */
  args: string[];
  /** Why this strategy was chosen (platform or filesystem marker). */
  source: string;
};

/** Doctor verification, or the default Spotlight + detectDevCommand path. */
type VerifyStrategy = DoctorStrategy | { kind: "local" };

/**
 * Match Flutter's pubspec SDK pin (`sdk: flutter`), typically under
 * `dependencies.flutter` (not the Dart `environment.sdk` constraint).
 */
const FLUTTER_SDK_RE = /^\s*sdk:\s*['"]?flutter['"]?\s*$/m;

/** Match Expo-related platform ids from the remote wizard. */
const EXPO_PLATFORM_RE = /(?:^|[.-])expo(?:$|[.-])/i;

/**
 * Resolve the verification strategy for a completed init run.
 *
 * Priority:
 * 1. Wizard platform (`flutter`, or any id containing `expo`)
 * 2. Filesystem: Flutter via `pubspec.yaml`, else Expo via package.json / app config
 * 3. Default local Spotlight verification
 */
export async function resolveVerifyStrategy(
  platform: string | undefined,
  cwd: string,
): Promise<VerifyStrategy> {
  const normalized = platform?.trim().toLowerCase();

  if (normalized === "flutter") {
    return flutterStrategy(`wizard.platform=${platform}`);
  }
  if (normalized && EXPO_PLATFORM_RE.test(normalized)) {
    return expoStrategy(`wizard.platform=${platform}`);
  }

  if (await hasFlutterProject(cwd)) {
    return flutterStrategy("pubspec.yaml");
  }
  if (await hasExpoProject(cwd)) {
    return expoStrategy("expo project markers");
  }

  return { kind: "local" };
}

function flutterStrategy(source: string): DoctorStrategy {
  return {
    kind: "doctor",
    tool: "flutter",
    args: ["flutter", "doctor"],
    source,
  };
}

function expoStrategy(source: string): DoctorStrategy {
  // `npx expo doctor` uses the project's local Expo CLI when present.
  const npx = process.platform === "win32" ? "npx.cmd" : "npx";
  return {
    kind: "doctor",
    tool: "expo",
    args: [npx, "expo", "doctor"],
    source,
  };
}

/** True when the directory looks like a Flutter app. */
export async function hasFlutterProject(cwd: string): Promise<boolean> {
  try {
    const pubspec = await readFile(join(cwd, "pubspec.yaml"), "utf-8");
    return FLUTTER_SDK_RE.test(pubspec);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug("Failed to read pubspec.yaml for Flutter detection", error);
    }
    return false;
  }
}

/** True when the directory looks like an Expo app. */
export async function hasExpoProject(cwd: string): Promise<boolean> {
  if (await packageJsonDependsOnExpo(cwd)) {
    return true;
  }
  return await hasExpoAppConfig(cwd);
}

async function packageJsonDependsOnExpo(cwd: string): Promise<boolean> {
  try {
    const raw = await readFile(join(cwd, "package.json"), "utf-8");
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    return Boolean(pkg.dependencies?.expo || pkg.devDependencies?.expo);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      logger.debug("Failed to read package.json for Expo detection", error);
    }
    return false;
  }
}

async function hasExpoAppConfig(cwd: string): Promise<boolean> {
  for (const name of ["app.json", "app.config.json"]) {
    try {
      const raw = await readFile(join(cwd, name), "utf-8");
      const parsed = JSON.parse(raw) as { expo?: unknown };
      if (parsed.expo !== undefined) {
        return true;
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug(`Failed to read ${name} for Expo detection`, error);
      }
    }
  }

  for (const name of ["app.config.js", "app.config.ts", "app.config.mjs"]) {
    try {
      await access(join(cwd, name));
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
        logger.debug(`Failed to access ${name} for Expo detection`, error);
      }
    }
  }

  return false;
}
