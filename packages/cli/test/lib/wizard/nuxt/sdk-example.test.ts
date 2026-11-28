import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { WizardExitError } from "../../../../src/lib/errors.js";
import { reportCliError } from "../../../../src/lib/error-reporting.js";
import {
  createExampleComponent,
  createExamplePage,
  supportsExamplePage,
} from "../../../../src/lib/wizard/nuxt/sdk-example.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
  outro: vi.fn(),
}));

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));

const options = {
  org: "my-org",
  project: "my-project",
  projectId: "1",
  url: "https://sentry.io/",
};

let projectDir: string;
let originalCwd: string;

beforeEach(() => {
  originalCwd = process.cwd();
  projectDir = mkdtempSync(path.join(tmpdir(), "wizard-nuxt-example-"));
  process.chdir(projectDir);
});

afterEach(() => {
  process.chdir(originalCwd);
  rmSync(projectDir, { recursive: true, force: true });
});

describe("createExamplePage", () => {
  it("creates the API route when the example page already exists", async () => {
    mkdirSync("pages");
    writeFileSync("pages/sentry-example-page.vue", "<!-- user's page -->");

    await createExamplePage(false, options);

    expect(readFileSync("pages/sentry-example-page.vue", "utf8")).toBe(
      "<!-- user's page -->",
    );
    expect(existsSync("server/api/sentry-example-api.js")).toBe(true);
  });

  it("keeps an existing API route", async () => {
    mkdirSync("server/api", { recursive: true });
    writeFileSync("tsconfig.json", "{}");
    writeFileSync("server/api/sentry-example-api.ts", "// user's route");

    await createExamplePage(false, options);

    expect(existsSync("pages/sentry-example-page.vue")).toBe(true);
    expect(readFileSync("server/api/sentry-example-api.ts", "utf8")).toBe(
      "// user's route",
    );
  });
});

describe("createExampleComponent", () => {
  it("reports the error and exits cleanly when the component can't be written", async () => {
    // A file where the components directory should be makes the write fail.
    writeFileSync("components", "");

    await expect(createExampleComponent(false)).rejects.toBeInstanceOf(
      WizardExitError,
    );
    expect(reportCliError).toHaveBeenCalled();
  });
});

describe("supportsExamplePage", () => {
  it.each([
    ["<NuxtPage />", true],
    ["<NuxtPage/>", true],
    ["<nuxt-page />", true],
    ["<nuxt-page></nuxt-page>", true],
    ["<NuxtPageWrapper />", false],
    ["<NuxtLayout />", false],
  ])("returns %s => %s for app.vue", async (tag, expected) => {
    writeFileSync("app.vue", `<template>${tag}</template>`);

    await expect(supportsExamplePage(false)).resolves.toBe(expected);
  });
});

describe("Nuxt 4 src directory", () => {
  it("uses the root app.vue when there is no app/ directory", async () => {
    writeFileSync("app.vue", "<template><NuxtLayout /></template>");

    await expect(supportsExamplePage(true)).resolves.toBe(false);

    await createExampleComponent(true);
    expect(existsSync("components/SentryErrorButton.vue")).toBe(true);
    expect(existsSync("app")).toBe(false);
  });

  it("uses app/ when it exists, even with a root app.vue", async () => {
    mkdirSync("app");
    writeFileSync("app.vue", "<template><NuxtLayout /></template>");

    await expect(supportsExamplePage(true)).resolves.toBe(true);

    await createExampleComponent(true);
    expect(existsSync("app/components/SentryErrorButton.vue")).toBe(true);
  });

  it("defaults to app/ in a project with neither", async () => {
    await createExamplePage(true, options);

    expect(existsSync("app/pages/sentry-example-page.vue")).toBe(true);
  });

  it("keeps the root for Nuxt 3", async () => {
    mkdirSync("app");

    await createExampleComponent(false);

    expect(existsSync("components/SentryErrorButton.vue")).toBe(true);
  });
});
