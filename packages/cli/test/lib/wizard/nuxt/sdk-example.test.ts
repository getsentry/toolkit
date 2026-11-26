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

import { createExamplePage } from "../../../../src/lib/wizard/nuxt/sdk-example.js";

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  },
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
