import { execSync, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve as resolvePath } from "node:path";
import { getCliCommand } from "../../fixture.js";
import type { Platform } from "./platforms.js";

function noop(): void {
  // Intentionally empty — absorbs async spawn errors
}

/** Root of the CLI repo (three levels up from this file). */
const CLI_ROOT = resolvePath(import.meta.dirname, "../../..");

export type WizardResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  diff: string;
  newFiles: Record<string, string>;
};

/**
 * Run `sentry init --yes` on a project directory and capture results.
 * When `features` is provided, passes `--features <comma-separated>` to the wizard.
 */
export async function runWizard(
  projectDir: string,
  platform: Platform,
  features?: string[]
): Promise<WizardResult> {
  // Resolve relative paths (e.g. "src/bin.ts") against the CLI repo root,
  // since the wizard spawns with cwd set to the temp project directory.
  const cmd = getCliCommand().map((part) =>
    part.includes("/") ? resolvePath(CLI_ROOT, part) : part
  );
  const mastraUrl = process.env.MASTRA_API_URL;
  if (!mastraUrl) {
    throw new Error("MASTRA_API_URL env var is required to run init evals");
  }

  // Install dependencies first so the wizard sees a realistic project
  try {
    execSync(platform.installCmd, {
      cwd: projectDir,
      stdio: "pipe",
      timeout: 120_000,
    });
    // Commit lock files so they don't show up in the diff
    execSync("git add -A && git commit -m deps --no-gpg-sign --allow-empty", {
      cwd: projectDir,
      stdio: "pipe",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "test",
        GIT_AUTHOR_EMAIL: "test@test.com",
        GIT_COMMITTER_NAME: "test",
        GIT_COMMITTER_EMAIL: "test@test.com",
      },
    });
  } catch {
    // Some templates (e.g. Python) might not need install
  }

  const initArgs = [...cmd, "init", "--yes"];
  if (features && features.length > 0) {
    initArgs.push("--features", features.join(","));
  }

  const [initCmd, ...initRestArgs] = initArgs;
  const proc = spawn(initCmd, initRestArgs, {
    cwd: projectDir,
    stdio: ["pipe", "pipe", "pipe"],
    env: {
      ...process.env,
      // Override the hardcoded Mastra URL to point at local/test server
      MASTRA_API_URL: mastraUrl,
      // Disable telemetry
      SENTRY_CLI_NO_TELEMETRY: "1",
    },
  });
  proc.on("error", noop);

  let stdout = "";
  let stderr = "";
  proc.stdout.on("data", (d: Buffer) => {
    stdout += d;
  });
  proc.stderr.on("data", (d: Buffer) => {
    stderr += d;
  });

  const exitCode = await new Promise<number>((resolve) =>
    proc.on("close", (code) => resolve(code ?? 1))
  );

  // Capture git diff (staged + unstaged changes since last commit)
  let diff = "";
  try {
    diff = execSync("git diff HEAD", {
      cwd: projectDir,
      encoding: "utf-8",
      maxBuffer: 1024 * 1024,
    });
  } catch {
    // No diff available
  }

  // Capture new untracked files
  const newFiles: Record<string, string> = {};
  try {
    const untracked = execSync("git ls-files --others --exclude-standard", {
      cwd: projectDir,
      encoding: "utf-8",
    }).trim();

    for (const file of untracked.split("\n").filter(Boolean)) {
      try {
        newFiles[file] = readFileSync(join(projectDir, file), "utf-8");
      } catch {
        // Binary or unreadable
      }
    }
  } catch {
    // No untracked files
  }

  return { exitCode, stdout, stderr, diff, newFiles };
}
