import { describe, expect, test } from "vitest";
import {
  DOCS_CONTEXT_MANIFESTS,
  detectDocsContextFromReader,
} from "../../src/lib/docs-context.js";

describe("detectDocsContextFromReader", () => {
  test("returns only normalized framework and language signals", async () => {
    const requested: string[] = [];
    const context = await detectDocsContextFromReader({
      async readManifest(name) {
        requested.push(name);
        if (name === "package.json") {
          return JSON.stringify({
            dependencies: { "@sentry/nextjs": "9.0.0", next: "15.0.0" },
            scripts: { secret: "not sent" },
          });
        }
        if (name === "pyproject.toml") {
          return "[project]\ndependencies = ['django']";
        }
        return;
      },
      async hasConfig(name) {
        return name === "sentry.client.config.ts";
      },
    });

    expect(context).toEqual({
      frameworks: ["django", "nextjs"],
      languages: ["javascript", "python"],
      sentryConfigured: true,
    });
    expect(requested).toEqual(DOCS_CONTEXT_MANIFESTS);
    expect(requested).not.toContain(".env");
    expect(requested).not.toContain("package-lock.json");
  });

  test("degrades to an empty context when manifests cannot be read", async () => {
    const context = await detectDocsContextFromReader({
      async readManifest() {
        throw new Error("permission denied");
      },
      async hasConfig() {
        return false;
      },
    });

    expect(context).toEqual({
      frameworks: [],
      languages: [],
      sentryConfigured: false,
    });
  });

  test("does not infer Next.js from an unrelated substring", async () => {
    const context = await detectDocsContextFromReader({
      async readManifest(name) {
        return name === "package.json"
          ? '{"description":"context"}'
          : undefined;
      },
      async hasConfig() {
        return false;
      },
    });

    expect(context.frameworks).toEqual([]);
  });
});
