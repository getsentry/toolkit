import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, test } from "vitest";
import {
  checkEnvBuildPlugin,
  checkFileContents,
  checkFileExists,
  checkIfBuilds,
  checkIfLints,
  checkIfRunsOnDevMode,
  checkIfRunsOnProdMode,
  checkPackageJson,
  createIsolatedTestEnv,
  getWizardCommand,
  KEYS,
  withEnv,
} from "./utils.js";
import { TEST_ARGS } from "./constants.js";

describe("NextJS-16 with cacheComponents", () => {
  let wizardExitCode: number;

  const { projectDir, cleanup } = createIsolatedTestEnv("nextjs-16-test-app");

  beforeAll(async () => {
    wizardExitCode = await withEnv({ cwd: projectDir })
      .defineInteraction()
      .whenAsked("Please select your package manager", {
        timeout: 300_000,
      })
      .respondWith(KEYS.ENTER) // Select npm (first option)
      .expectOutput("Installing @sentry/nextjs")
      .whenAsked(
        "Do you want to reduce this to avoid sending personally identifiable information",
        {
          timeout: 300_000, // package installation can take a while in CI
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
      .whenAsked("Looks like you have Prettier and Biome in your project")
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Skip formatter run
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
    checkFileExists(`${projectDir}/app/sentry-example-page/page.tsx`);
    checkFileExists(`${projectDir}/app/api/sentry-example-api/route.ts`);
  });

  test("config files created", () => {
    checkFileExists(`${projectDir}/sentry.server.config.ts`);
    checkFileExists(`${projectDir}/sentry.edge.config.ts`);
  });

  test("global error file exists", () => {
    checkFileExists(`${projectDir}/app/global-error.tsx`);
  });

  test("instrumentation files exist", () => {
    checkFileExists(`${projectDir}/instrumentation.ts`);
    checkFileExists(`${projectDir}/instrumentation-client.ts`);
  });

  test("next.config file contains Sentry wrapper and keeps cacheComponents", () => {
    checkFileContents(`${projectDir}/next.config.ts`, [
      'import { withSentryConfig } from "@sentry/nextjs/config"',
      "cacheComponents: true",
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

describe("NextJS-16 with Prettier, Biome, and ESLint", () => {
  let wizardExitCode: number;

  const { projectDir, cleanup } = createIsolatedTestEnv("nextjs-16-test-app");

  beforeAll(async () => {
    wizardExitCode = await withEnv({ cwd: projectDir })
      .defineInteraction()
      .whenAsked("Please select your package manager", {
        timeout: 300_000,
      })
      .respondWith(KEYS.ENTER) // Select npm (first option)
      .expectOutput("Installing @sentry/nextjs")
      .whenAsked(
        "Do you want to reduce this to avoid sending personally identifiable information",
        {
          timeout: 300_000, // package installation can take a while in CI
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
      .whenAsked("Are you using a CI/CD tool")
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Select No
      .whenAsked(
        "Optionally add a project-scoped MCP server configuration for the Sentry MCP?",
      )
      .respondWith(KEYS.DOWN, KEYS.ENTER) // Skip MCP config
      .whenAsked("Looks like you have Prettier and Biome in your project")
      .respondWith(KEYS.ENTER) // Accept formatter run
      .expectOutput("Running formatters on your files") // clack drops the trailing dots
      .expectOutput("Formatters have processed your files", { timeout: 60_000 })
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

  test("config files created", () => {
    checkFileExists(`${projectDir}/sentry.server.config.ts`);
    checkFileExists(`${projectDir}/sentry.edge.config.ts`);
  });

  test("global error file exists", () => {
    checkFileExists(`${projectDir}/app/global-error.tsx`);
  });

  test("instrumentation files exist", () => {
    checkFileExists(`${projectDir}/instrumentation.ts`);
    checkFileExists(`${projectDir}/instrumentation-client.ts`);
  });

  test("instrumentation file contains Sentry initialization", () => {
    checkFileContents(`${projectDir}/instrumentation.ts`, [
      'import * as Sentry from "@sentry/nextjs";',
      `export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    await import("./sentry.server.config");
  }

  if (process.env.NEXT_RUNTIME === "edge") {
    await import("./sentry.edge.config");
  }
}

export const onRequestError = Sentry.captureRequestError;`,
    ]);
  });

  test("next.config file contains Sentry wrapper", () => {
    checkFileContents(`${projectDir}/next.config.ts`, [
      'import { withSentryConfig } from "@sentry/nextjs/config"',
      "withSentryConfig(nextConfig, {",
    ]);
  });

  test("Generated code has proper import formatting", () => {
    const configContent = readFileSync(`${projectDir}/next.config.ts`, "utf-8");
    // Verify proper spacing: import { withSentryConfig } from
    expect(configContent).toMatch(/import\s+{\s+\w+\s+}\s+from/);
  });

  test("builds correctly", async () => {
    await checkIfBuilds(projectDir);
  });

  test("lints correctly", async () => {
    await checkIfLints(projectDir);
  });
});
