import { execSync } from "node:child_process";
import { cpSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export type TestEnv = {
  projectDir: string;
  cleanup: () => void;
};

/**
 * Copy a template project into an isolated temp directory with git initialized.
 * Returns the project dir and a cleanup function.
 */
export function createTestEnv(templateDir: string): TestEnv {
  const rand = Math.random().toString(36).slice(2, 8);
  const name = templateDir.split("/").pop() ?? "project";
  const projectDir = join(tmpdir(), "sentry-init-eval", `${name}-${rand}`);

  mkdirSync(projectDir, { recursive: true });
  cpSync(templateDir, projectDir, { recursive: true });

  // Initialize git so we can diff after the wizard runs
  execSync("git init && git add -A && git commit -m init --no-gpg-sign", {
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

  const cleanup = () => {
    if (process.env.KEEP_TEMP) return;
    try {
      rmSync(projectDir, { recursive: true, force: true });
    } catch {
      // ignore
    }
  };

  return { projectDir, cleanup };
}
