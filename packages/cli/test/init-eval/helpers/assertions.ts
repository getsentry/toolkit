import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Platform } from "./platforms.js";
import type { WizardResult } from "./run-wizard.js";

export type AssertionFailure = {
  check: string;
  message: string;
};

/**
 * Run hard pass/fail assertions on the wizard result.
 * Returns an array of failures (empty = all passed).
 */
export function runAssertions(
  projectDir: string,
  platform: Platform,
  result: WizardResult
): AssertionFailure[] {
  const failures: AssertionFailure[] = [];

  // 1. Exit code 0
  if (result.exitCode !== 0) {
    failures.push({
      check: "exit-code",
      message: `Expected exit code 0, got ${result.exitCode}.\nstderr: ${result.stderr.slice(0, 500)}`,
    });
  }

  // 2. SDK in dependencies
  try {
    const depContent = readFileSync(
      join(projectDir, platform.depFile),
      "utf-8"
    );
    if (!depContent.includes(platform.sdkPackage)) {
      failures.push({
        check: "sdk-installed",
        message: `${platform.sdkPackage} not found in ${platform.depFile}`,
      });
    }
  } catch {
    failures.push({
      check: "sdk-installed",
      message: `Could not read ${platform.depFile}`,
    });
  }

  // 3. Sentry.init present in changed or new files
  const allContent = result.diff + Object.values(result.newFiles).join("\n");
  if (!platform.initPattern.test(allContent)) {
    failures.push({
      check: "init-present",
      message: `${platform.initPattern} not found in any changed or new files`,
    });
  }

  // 4. No placeholder DSNs
  const placeholderPatterns = [
    /___PUBLIC_DSN___/,
    /YOUR_DSN_HERE/,
    /https:\/\/examplePublicKey@o0\.ingest\.sentry\.io\/0/,
  ];
  for (const pat of placeholderPatterns) {
    if (pat.test(allContent)) {
      failures.push({
        check: "no-placeholder-dsn",
        message: `Placeholder DSN found: ${pat.source}`,
      });
    }
  }

  // 5. Project builds (if buildCmd set)
  if (platform.buildCmd) {
    try {
      // Install deps first (wizard may have added new ones)
      execSync(platform.installCmd, {
        cwd: projectDir,
        stdio: "pipe",
        timeout: 120_000,
      });
      execSync(platform.buildCmd, {
        cwd: projectDir,
        stdio: "pipe",
        timeout: 120_000,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      failures.push({
        check: "build-succeeds",
        message: `Build failed: ${msg.slice(0, 500)}`,
      });
    }
  }

  return failures;
}
