import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkEnvBuildPlugin,
  checkFileContents,
  checkFileDoesNotExist,
  checkFileExists,
  checkIfBuilds,
  checkIfRunsOnDevMode,
  checkIfRunsOnProdMode,
  checkPackageJson,
  createIsolatedTestEnv,
  getWizardCommand,
  KEYS,
  withEnv,
} from "./utils.js";
import { TEST_ARGS } from "./constants.js";

describe("NextJS-15", () => {
  let wizardExitCode: number;

  const { projectDir, cleanup } = createIsolatedTestEnv("nextjs-15-test-app");

  beforeAll(async () => {
    wizardExitCode = await withEnv({ cwd: projectDir })
      .defineInteraction()
      .expectOutput(
        `Selected project ${TEST_ARGS.ORG_SLUG}/${TEST_ARGS.PROJECT_SLUG}`,
      )
      .whenAsked("Please select your package manager.")
      .respondWith(KEYS.DOWN, KEYS.DOWN, KEYS.DOWN, KEYS.ENTER) // Select pnpm
      .whenAsked(
        "Do you want to reduce this to avoid sending personally identifiable information",
        {
          timeout: 240_000, // package installation can take a while in CI
        },
      )
      .respondWith(KEYS.ENTER) // No
      .whenAsked(
        "Do you want to route Sentry requests in the browser through your Next.js server",
      )
      .respondWith(KEYS.ENTER)
      .whenAsked("to track the performance of your application?")
      .respondWith(KEYS.ENTER)
      .whenAsked(
        "to get a video-like reproduction of errors during a user session?",
      )
      .respondWith(KEYS.ENTER)
      .whenAsked("Do you want to create an example page")
      .respondWith(KEYS.ENTER)
      .whenAsked("Are you using a CI/CD tool")
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Select No
      .whenAsked(
        "Optionally add a project-scoped MCP server configuration for the Sentry MCP?",
      )
      .respondWith(KEYS.ENTER) // Accept MCP config
      .whenAsked("Which editor(s) do you want to configure?")
      .respondWith(KEYS.SPACE, KEYS.ENTER) // Select Cursor
      .expectOutput("Successfully installed the Sentry Next.js SDK!")
      .run(getWizardCommand("nextjs"));
  });

  afterAll(() => {
    cleanup();
  });

  test("exits with exit code 0", () => {
    expect(wizardExitCode).toBe(0);
  });

  test("package.json is updated correctly", () => {
    checkPackageJson(projectDir, "@sentry/nextjs");
  });

  test(".env-sentry-build-plugin is created and contains the auth token", () => {
    checkEnvBuildPlugin(projectDir);
  });

  test("example page exists", () => {
    checkFileExists(`${projectDir}/src/app/sentry-example-page/page.tsx`);
    checkFileExists(`${projectDir}/src/app/api/sentry-example-api/route.ts`);
  });

  test("config files created", () => {
    checkFileExists(`${projectDir}/sentry.server.config.ts`);
    checkFileExists(`${projectDir}/sentry.edge.config.ts`);
  });

  test("config files contain the project's DSN", () => {
    checkFileContents(
      `${projectDir}/sentry.server.config.ts`,
      `dsn: "${TEST_ARGS.PROJECT_DSN}"`,
    );
  });

  test("global error file exists", () => {
    checkFileExists(`${projectDir}/src/app/global-error.tsx`);
  });

  test("instrumentation files exists", () => {
    checkFileExists(`${projectDir}/src/instrumentation.ts`);
    checkFileExists(`${projectDir}/src/instrumentation-client.ts`);
  });

  test("instrumentation file contains Sentry initialization", () => {
    checkFileContents(`${projectDir}/src/instrumentation.ts`, [
      'import * as Sentry from "@sentry/nextjs";',
      `export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("../sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("../sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;`,
    ]);
  });

  test("next.config file contains Sentry wrapper", () => {
    checkFileContents(`${projectDir}/next.config.ts`, [
      'import { withSentryConfig } from "@sentry/nextjs/config"',
      "export default withSentryConfig(nextConfig, {",
    ]);
  });

  test("runs on dev mode correctly", async () => {
    await checkIfRunsOnDevMode(projectDir, "Ready in");
  });

  test("builds correctly", async () => {
    await checkIfBuilds(projectDir);
  });

  test("runs on prod mode correctly", async () => {
    await checkIfRunsOnProdMode(projectDir, "Ready in");
  });

  test("MCP configuration file is created for Cursor", () => {
    checkFileExists(`${projectDir}/.cursor/mcp.json`);
    checkFileContents(`${projectDir}/.cursor/mcp.json`, [
      '"mcpServers"',
      '"Sentry"',
      `"url": "https://mcp.sentry.dev/mcp/${TEST_ARGS.ORG_SLUG}/${TEST_ARGS.PROJECT_SLUG}"`,
    ]);
  });
});

describe("NextJS-15 Spotlight", () => {
  let wizardExitCode: number;

  const { projectDir, cleanup } = createIsolatedTestEnv("nextjs-15-test-app");

  beforeAll(async () => {
    wizardExitCode = await withEnv({ cwd: projectDir })
      .defineInteraction()
      .expectOutput("Spotlight mode enabled!")
      .whenAsked("Please select your package manager.")
      .respondWith(KEYS.DOWN, KEYS.DOWN, KEYS.DOWN, KEYS.ENTER) // Select pnpm
      .expectOutput("Installing @sentry/nextjs")
      .whenAsked(
        "Do you want to reduce this to avoid sending personally identifiable information",
        {
          timeout: 240_000, // package installation can take a while in CI
        },
      )
      .respondWith(KEYS.ENTER) // No
      .whenAsked(
        "Do you want to route Sentry requests in the browser through your Next.js server",
      )
      .respondWith(KEYS.ENTER)
      .whenAsked("to track the performance of your application?")
      .respondWith(KEYS.ENTER)
      .whenAsked(
        "to get a video-like reproduction of errors during a user session?",
      )
      .respondWith(KEYS.ENTER)
      .whenAsked("Do you want to create an example page")
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Skip example page
      .whenAsked(
        "Optionally add a project-scoped MCP server configuration for the Sentry MCP?",
      )
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Decline MCP config
      .expectOutput("Successfully installed the Sentry Next.js SDK!")
      .run([...getWizardCommand("nextjs"), "--spotlight"]);
  });

  afterAll(() => {
    cleanup();
  });

  test("exits with exit code 0", () => {
    expect(wizardExitCode).toBe(0);
  });

  test("package.json is updated correctly", () => {
    checkPackageJson(projectDir, "@sentry/nextjs");
  });

  test(".env-sentry-build-plugin should NOT exist in spotlight mode", () => {
    checkFileDoesNotExist(`${projectDir}/.env.sentry-build-plugin`);
  });

  test("config files created", () => {
    checkFileExists(`${projectDir}/sentry.server.config.ts`);
    checkFileExists(`${projectDir}/sentry.edge.config.ts`);
  });

  test("server config file contains empty DSN and spotlight flag", () => {
    checkFileContents(`${projectDir}/sentry.server.config.ts`, [
      'dsn: ""',
      "spotlight: true",
    ]);
  });

  test("edge config file contains empty DSN and spotlight flag", () => {
    checkFileContents(`${projectDir}/sentry.edge.config.ts`, [
      'dsn: ""',
      "spotlight: true",
    ]);
  });

  test("instrumentation client file contains empty DSN and spotlight flag", () => {
    checkFileExists(`${projectDir}/src/instrumentation-client.ts`);
    checkFileContents(`${projectDir}/src/instrumentation-client.ts`, [
      'dsn: ""',
      "spotlight: true",
    ]);
  });

  test("builds correctly", async () => {
    await checkIfBuilds(projectDir);
  });

  test("runs on dev mode correctly", async () => {
    await checkIfRunsOnDevMode(projectDir, "Ready in");
  });
});
