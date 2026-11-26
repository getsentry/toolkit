/**
 * Harness for the `sentry wizard` end-to-end tests, ported from
 * getsentry/sentry-wizard's `e2e-tests/utils`.
 *
 * A test copies one app from `test-applications/` to a temporary git
 * repository ({@link createIsolatedTestEnv}), runs the real CLI's `sentry
 * wizard` in it while answering its prompts ({@link withEnv}), and then checks
 * the files the wizard wrote and that the app still builds and runs.
 *
 * The wizard never talks to sentry.io: runs that need a project set
 * `SENTRY_URL` to the local mock Sentry API that `global-setup.ts` starts, and
 * Spotlight runs (`SENTRY_SPOTLIGHT=1`) need no project at all.
 */

import {
  type ChildProcess,
  execFileSync,
  spawn,
  spawnSync,
} from "node:child_process";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { expect, inject } from "vitest";
import { logger } from "../../src/lib/logger.js";
import type { WizardIntegration } from "../../src/lib/wizard/run.js";
import { BUNDLE_BIN_PATH } from "../e2e/bundle-setup.js";
import { TEST_ARGS } from "./constants.js";

const log = logger.withTag("wizard-e2e");

/** Key sequences to answer clack prompts with. */
export const KEYS = {
  UP: "\u001b[A",
  DOWN: "\u001b[B",
  LEFT: "\u001b[D",
  RIGHT: "\u001b[C",
  ENTER: "\r",
  SPACE: " ",
} as const;

/** Default time to wait for one prompt or output, as in clifty. */
const DEFAULT_STEP_TIMEOUT = 10_000;

/** Time a wizard run may take after its last expected output. */
const EXIT_TIMEOUT = 60_000;

/**
 * The command that runs the CLI: `SENTRY_CLI_BINARY` (a native binary, or a
 * `.cjs`/`.js` bundle run with this Node), else the npm bundle that
 * `pnpm run bundle` writes to `dist/bin.cjs`.
 */
function getCliCommand(): [string, ...string[]] {
  const binary = process.env["SENTRY_CLI_BINARY"] || BUNDLE_BIN_PATH;
  if (!existsSync(binary)) {
    throw new Error(
      `No CLI at ${binary}. Run \`pnpm run bundle\` in packages/cli, or set SENTRY_CLI_BINARY.`,
    );
  }
  return /\.[cm]?js$/i.test(binary) ? [process.execPath, binary] : [binary];
}

/**
 * The `sentry wizard` arguments that set up `integration` for the mock
 * Sentry API's org and project. The run logs in with the environment token
 * that {@link wizardEnv} sets for the mock's `SENTRY_URL`.
 */
export function getWizardCommand(integration: WizardIntegration): string[] {
  return [
    "wizard",
    `${TEST_ARGS.ORG_SLUG}/${TEST_ARGS.PROJECT_SLUG}`,
    integration,
  ];
}

/**
 * This process's environment without Sentry and npm script variables, for
 * the processes a test starts. `pnpm run` sets npm_* variables, which would
 * change how package managers run in the test app.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { NEXT_TELEMETRY_DISABLED: "1" };
  for (const [key, value] of Object.entries(process.env)) {
    if (!(key.startsWith("SENTRY_") || key.startsWith("npm_"))) {
      env[key] = value;
    }
  }
  return env;
}

/**
 * CLI config directory of this test file's runs, so they don't read the
 * user's login. The runs log in with an environment token and keep no state.
 */
const CONFIG_DIR = mkdtempSync(join(tmpdir(), "sentry-wizard-e2e-config-"));

/**
 * The environment of a CLI run: its own config directory, and the mock API's
 * login token for its URL. (The CLI sends an environment token only to the
 * host in `SENTRY_URL`.)
 */
function wizardEnv(): NodeJS.ProcessEnv {
  return {
    ...cleanEnv(),
    SENTRY_CONFIG_DIR: CONFIG_DIR,
    SENTRY_URL: inject("sentryUrl"),
    SENTRY_AUTH_TOKEN: TEST_ARGS.LOGIN_TOKEN,
    SENTRY_CLI_NO_TELEMETRY: "1",
    SENTRY_CLI_NO_UPDATE_CHECK: "1",
  };
}

/**
 * Run the CLI with `args` to completion, without answering prompts, such as
 * for `wizard --help`.
 */
export function runCli(args: readonly string[]): {
  exitCode: number | null;
  stdout: string;
  stderr: string;
} {
  const [command, ...commandArgs] = getCliCommand();
  const result = spawnSync(command, [...commandArgs, ...args], {
    env: wizardEnv(),
    encoding: "utf-8",
  });
  return {
    exitCode: result.status,
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

/**
 * Copy the app `testAppName` from `test-applications/` into a new temporary
 * directory and commit it to a new git repository there, so the wizard sees
 * a clean working tree. Each call makes a new directory.
 *
 * Set `SENTRY_WIZARD_E2E_KEEP_TEMP=true` to keep the directory for debugging.
 */
export function createIsolatedTestEnv(testAppName: string): {
  projectDir: string;
  cleanup: () => void;
} {
  const sourceDir = resolve(
    import.meta.dirname,
    "test-applications",
    testAppName,
  );
  const projectDir = mkdtempSync(
    join(tmpdir(), `sentry-wizard-e2e-${testAppName}-`),
  );
  cpSync(sourceDir, projectDir, { recursive: true });
  initGit(projectDir);
  log.info(`Created isolated test env at ${projectDir}`);

  const cleanup = () => {
    if (process.env["SENTRY_WIZARD_E2E_KEEP_TEMP"] === "true") {
      log.info(`Keeping temp directory for debugging: ${projectDir}`);
      return;
    }
    rmSync(projectDir, { recursive: true, force: true });
  };
  return { projectDir, cleanup };
}

/** Commit everything in `projectDir` to a new git repository. */
function initGit(projectDir: string): void {
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: projectDir, stdio: "pipe" });
  git("init", "--quiet");
  git("add", "-A");
  git(
    "-c",
    "user.email=test@test.sentry.io",
    "-c",
    "user.name=Test",
    "-c",
    "commit.gpgsign=false",
    "commit",
    "--quiet",
    "-m",
    "init",
  );
}

type InteractionStep = {
  /** Text the output must contain, after the previous step's match. */
  output: string;
  timeout: number;
  /** Keys to type once `output` appears; unset for `expectOutput`. */
  response?: readonly string[];
};

/**
 * Scripted answers to the wizard's prompts, in the shape of clifty's
 * `defineInteraction()` builder that sentry-wizard's tests used.
 */
class Interaction {
  readonly #steps: InteractionStep[] = [];
  readonly #cwd: string;
  readonly #env: NodeJS.ProcessEnv;
  readonly #debug: boolean;

  constructor(cwd: string, env: NodeJS.ProcessEnv, debug: boolean) {
    this.#cwd = cwd;
    this.#env = env;
    this.#debug = debug;
  }

  /** Wait for the prompt `output`, then answer it with `respondWith`. */
  whenAsked(
    output: string,
    options: { timeout?: number } = {},
  ): { respondWith: (...keys: string[]) => Interaction } {
    return {
      respondWith: (...keys: string[]) => {
        this.#steps.push({
          output,
          timeout: options.timeout ?? DEFAULT_STEP_TIMEOUT,
          response: keys,
        });
        return this;
      },
    };
  }

  /** Wait for `output` without answering anything. */
  expectOutput(output: string, options: { timeout?: number } = {}): this {
    this.#steps.push({
      output,
      timeout: options.timeout ?? DEFAULT_STEP_TIMEOUT,
    });
    return this;
  }

  /**
   * Run the CLI with `args`, go through the steps, and resolve to its exit
   * code. Rejects when a step's output doesn't appear in time.
   */
  async run(args: readonly string[]): Promise<number> {
    const [command, ...commandArgs] = getCliCommand();
    const child = spawn(command, [...commandArgs, ...args], {
      cwd: this.#cwd,
      env: this.#env,
      stdio: "pipe",
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    if (this.#debug) {
      child.stdout.pipe(process.stdout);
      child.stderr.pipe(process.stderr);
    }
    const exited = new Promise<number>((resolveExit, rejectExit) => {
      child.once("error", rejectExit);
      child.once("close", (code, signal) =>
        code === null
          ? rejectExit(new Error(`Wizard was killed by ${signal ?? "?"}`))
          : resolveExit(code),
      );
    });

    try {
      let cursor = 0;
      for (const step of this.#steps) {
        cursor = await waitForOutput(() => stdout, cursor, step, exited);
        for (const key of step.response ?? []) {
          child.stdin.write(key);
        }
      }
      child.stdin.end();
      const exitCode = await withTimeout(
        exited,
        EXIT_TIMEOUT,
        "Wizard did not exit after its last step",
      );
      if (exitCode !== 0) {
        log.error(
          `Wizard exited with ${exitCode}.\nstdout:\n${stdout}\nstderr:\n${stderr}`,
        );
      }
      return exitCode;
    } catch (error) {
      child.kill("SIGKILL");
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n\nstdout:\n${stdout}\nstderr:\n${stderr}`,
      );
    }
  }
}

/**
 * Wait until `read()` contains `step.output` at or after `cursor`, and
 * return the index just after the match. Rejects on timeout, or when the
 * process exits first.
 */
async function waitForOutput(
  read: () => string,
  cursor: number,
  step: InteractionStep,
  exited: Promise<number>,
): Promise<number> {
  const deadline = Date.now() + step.timeout;
  let exitCode: number | undefined;
  exited.then(
    (code) => {
      exitCode = code;
    },
    () => {
      exitCode = -1;
    },
  );
  for (;;) {
    const index = read().indexOf(step.output, cursor);
    if (index !== -1) {
      return index + step.output.length;
    }
    if (exitCode !== undefined) {
      throw new Error(
        `Wizard exited with ${exitCode} while waiting for: ${step.output}`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(
        `Timed out after ${step.timeout} ms waiting for: ${step.output}`,
      );
    }
    await new Promise((resolveSleep) => setTimeout(resolveSleep, 50));
  }
}

/** `promise`, or a rejection with `message` after `ms`. */
async function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  message: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, rejectTimeout) => {
        timer = setTimeout(() => rejectTimeout(new Error(message)), ms);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Start describing a wizard run in `cwd`, with `env` added to its
 * environment. Set `debug` (or `SENTRY_WIZARD_E2E_DEBUG=true`) to stream the
 * wizard's output.
 */
export function withEnv(options: {
  cwd: string;
  env?: NodeJS.ProcessEnv;
  debug?: boolean;
}): {
  defineInteraction: () => Interaction;
} {
  return {
    defineInteraction: () =>
      new Interaction(
        options.cwd,
        { ...wizardEnv(), ...options.env },
        options.debug ?? process.env["SENTRY_WIZARD_E2E_DEBUG"] === "true",
      ),
  };
}

/** A command started in a test app, such as `npm run dev`. */
class ProcessRunner {
  readonly #child: ChildProcess;
  #output = "";

  constructor(
    command: string,
    args: readonly string[],
    options: { cwd: string },
  ) {
    this.#child = spawn(command, args, {
      cwd: options.cwd,
      env: cleanEnv(),
      stdio: "pipe",
      // Own process group, so kill() also stops the servers npm starts.
      detached: process.platform !== "win32",
    });
    this.#child.stdout?.on("data", (chunk: Buffer) => {
      this.#output += chunk.toString();
    });
    this.#child.stderr?.on("data", (chunk: Buffer) => {
      this.#output += chunk.toString();
    });
  }

  /** Resolves to whether the command exits with `statusCode` in time. */
  async waitForStatusCode(
    statusCode: number,
    options: { timeout?: number } = {},
  ): Promise<boolean> {
    const exited = new Promise<number | null>((resolveExit, rejectExit) => {
      this.#child.once("error", rejectExit);
      this.#child.once("exit", resolveExit);
    });
    try {
      const code = await withTimeout(
        exited,
        options.timeout ?? 60_000,
        `Timed out waiting for exit code ${statusCode}`,
      );
      if (code !== statusCode) {
        log.error(`Exited with ${code ?? "a signal"}:\n${this.#output}`);
      }
      return code === statusCode;
    } finally {
      this.kill();
    }
  }

  /** Resolves to whether the command prints `output` in time. */
  async waitForOutput(
    output: string,
    options: { timeout?: number } = {},
  ): Promise<boolean> {
    const deadline = Date.now() + (options.timeout ?? 60_000);
    while (Date.now() < deadline) {
      if (this.#output.includes(output)) {
        return true;
      }
      if (this.#child.exitCode !== null) {
        break;
      }
      await new Promise((resolveSleep) => setTimeout(resolveSleep, 100));
    }
    log.error(`Did not print "${output}":\n${this.#output}`);
    return false;
  }

  /** Stop the command and everything it started. */
  kill(): void {
    if (this.#child.exitCode !== null || this.#child.pid === undefined) {
      return;
    }
    try {
      if (process.platform === "win32") {
        this.#child.kill();
      } else {
        process.kill(-this.#child.pid, "SIGKILL");
      }
    } catch (error) {
      log.debug("Could not stop process", error);
    }
  }
}

/** Check that `filePath` contains each of `content`. */
export function checkFileContents(
  filePath: string,
  content: string | readonly string[],
): void {
  const fileContent = readFileSync(filePath, "utf-8");
  for (const c of typeof content === "string" ? [content] : content) {
    expect(fileContent).toContain(c);
  }
}

export function checkFileExists(filePath: string): void {
  expect(existsSync(filePath), `${filePath} exists`).toBe(true);
}

export function checkFileDoesNotExist(filePath: string): void {
  expect(existsSync(filePath), `${filePath} does not exist`).toBe(false);
}

/**
 * Check that the project's `package.json` lists `packageName` in its
 * dependencies (or, with `devDependency`, its dev dependencies).
 */
export function checkPackageJson(
  projectDir: string,
  packageName: string,
  devDependency = false,
): void {
  const packageJson = JSON.parse(
    readFileSync(join(projectDir, "package.json"), "utf-8"),
  ) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const version =
    packageJson.dependencies?.[packageName] ??
    (devDependency ? packageJson.devDependencies?.[packageName] : undefined);
  expect(version, `${packageName} in package.json`).toBeTruthy();
}

/** Check that `.env.sentry-build-plugin` has the minted org auth token. */
export function checkEnvBuildPlugin(projectDir: string): void {
  checkFileContents(
    join(projectDir, ".env.sentry-build-plugin"),
    `SENTRY_AUTH_TOKEN=${TEST_ARGS.AUTH_TOKEN}`,
  );
}

/** Check that `npm run build` succeeds. */
export async function checkIfBuilds(projectDir: string): Promise<void> {
  const runner = new ProcessRunner("npm", ["run", "build"], {
    cwd: projectDir,
  });
  expect(await runner.waitForStatusCode(0, { timeout: 120_000 })).toBe(true);
}

/** Check that `npm run lint` succeeds. */
export async function checkIfLints(projectDir: string): Promise<void> {
  const runner = new ProcessRunner("npm", ["run", "lint"], {
    cwd: projectDir,
  });
  expect(await runner.waitForStatusCode(0, { timeout: 120_000 })).toBe(true);
}

/** Check that `npm run dev` prints `expectedOutput`. */
export async function checkIfRunsOnDevMode(
  projectDir: string,
  expectedOutput: string,
): Promise<void> {
  const runner = new ProcessRunner("npm", ["run", "dev"], { cwd: projectDir });
  try {
    expect(
      await runner.waitForOutput(expectedOutput, { timeout: 120_000 }),
    ).toBe(true);
  } finally {
    runner.kill();
  }
}

/** Check that `npm run <startCommand>` prints `expectedOutput`. */
export async function checkIfRunsOnProdMode(
  projectDir: string,
  expectedOutput: string,
  startCommand = "start",
): Promise<void> {
  const runner = new ProcessRunner("npm", ["run", startCommand], {
    cwd: projectDir,
  });
  try {
    expect(
      await runner.waitForOutput(expectedOutput, { timeout: 120_000 }),
    ).toBe(true);
  } finally {
    runner.kill();
  }
}
