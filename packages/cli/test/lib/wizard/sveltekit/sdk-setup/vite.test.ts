import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@clack/prompts", () => ({
  log: {
    warn: vi.fn(),
    warning: vi.fn(),
    success: vi.fn(),
    info: vi.fn(),
    step: vi.fn(),
  },
  select: vi.fn(() => Promise.resolve(true)),
}));

vi.mock("../../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));

vi.mock("../../../../../src/lib/wizard/utils/clack/index.js", () => ({
  abortIfCancelled: vi.fn((v: unknown) => v),
}));

import { log } from "@clack/prompts";
import { modifyViteConfig } from "../../../../../src/lib/wizard/sveltekit/sdk-setup/vite.js";
import type { ProjectInfo } from "../../../../../src/lib/wizard/sveltekit/sdk-setup/types.js";

const baseViteConfig = `import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sveltekit()]
});
`;

describe("modifyViteConfig", () => {
  let tmpDir: string;
  let viteConfigPath: string;

  const projectInfo = (overrides: Partial<ProjectInfo>): ProjectInfo => ({
    dsn: "https://public@dsn.ingest.sentry.io/1337",
    org: "my-org",
    project: "my-project",
    selfHosted: false,
    url: "https://sentry.io/",
    vitePluginImportPath: "@sentry/sveltekit/vite",
    reduceDataCollection: false,
    ...overrides,
  });

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "sveltekit-vite-test-"));
    viteConfigPath = path.join(tmpDir, "vite.config.js");
    writeFileSync(viteConfigPath, baseViteConfig);
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("imports sentrySvelteKit from the given path and writes sentryUrl for self-hosted", async () => {
    await modifyViteConfig(
      viteConfigPath,
      projectInfo({
        selfHosted: true,
        url: "https://sentry.example.com/",
        vitePluginImportPath: "@sentry/sveltekit/vite",
      }),
    );

    const result = readFileSync(viteConfigPath, "utf-8");
    expect(result).toContain(
      'import { sentrySvelteKit } from "@sentry/sveltekit/vite";',
    );
    expect(result).toContain("sentrySvelteKit({");
    expect(result).toContain('org: "my-org"');
    expect(result).toContain('project: "my-project"');
    expect(result).toContain('sentryUrl: "https://sentry.example.com/"');
    expect(result).not.toMatch(/\burl:/);
    // registered before sveltekit()
    expect(result.indexOf("sentrySvelteKit(")).toBeLessThan(
      result.indexOf("sveltekit()"),
    );
  });

  it("imports from the root export when the installed SDK requires it", async () => {
    await modifyViteConfig(
      viteConfigPath,
      projectInfo({ vitePluginImportPath: "@sentry/sveltekit" }),
    );

    const result = readFileSync(viteConfigPath, "utf-8");
    expect(result).toContain(
      'import { sentrySvelteKit } from "@sentry/sveltekit";',
    );
    expect(result).not.toContain("@sentry/sveltekit/vite");
    expect(result).not.toContain("sentryUrl");
  });

  it("leaves a config that already contains Sentry code untouched", async () => {
    const existing = `import { sentrySvelteKit } from "@sentry/sveltekit";
import { sveltekit } from '@sveltejs/kit/vite';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [sentrySvelteKit({ org: "old" }), sveltekit()]
});
`;
    writeFileSync(viteConfigPath, existing);

    await modifyViteConfig(viteConfigPath, projectInfo({}));

    expect(readFileSync(viteConfigPath, "utf-8")).toBe(existing);
  });

  it("does not report success when the automatic edit fails", async () => {
    vi.clearAllMocks();
    // A config that magicast can parse but `addVitePlugin` cannot handle.
    writeFileSync(viteConfigPath, "export default 42;\n");

    await modifyViteConfig(viteConfigPath, projectInfo({}));

    expect(log.warning).toHaveBeenCalledWith(
      expect.stringContaining("Couldn't automatically modify"),
    );
    expect(log.success).not.toHaveBeenCalled();
  });
});
