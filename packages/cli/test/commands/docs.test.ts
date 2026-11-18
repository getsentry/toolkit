import { buildApplication, run } from "@stricli/core";
import { beforeEach, describe, expect, test, vi } from "vitest";
import type { SentryContext } from "../../src/context.js";
import { ValidationError } from "../../src/lib/errors.js";

const { loadDocsIndex } = vi.hoisted(() => ({ loadDocsIndex: vi.fn() }));
vi.mock("../../src/lib/docs-index.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../../src/lib/docs-index.js")>()),
  loadDocsIndex,
}));

import { docsCommand } from "../../src/commands/docs.js";
import { fixtureDocsIndex } from "../fixtures/docs/index.js";

const index = fixtureDocsIndex();

function createContext(): {
  context: SentryContext;
  stdout: () => string;
} {
  const stdoutWrite = vi.fn((_chunk: string) => true);
  return {
    context: {
      configDir: "/tmp",
      cwd: "/project",
      env: process.env,
      homeDir: "/tmp",
      process,
      stderr: { write: vi.fn(() => true) },
      stdin: process.stdin,
      stdout: { write: stdoutWrite },
    },
    stdout: () => stdoutWrite.mock.calls.map((call) => call[0]).join(""),
  };
}

async function runDocs(args: string[]) {
  const harness = createContext();
  const app = buildApplication(docsCommand, { name: "sentry docs" });
  await run(app, args, harness.context);
  return harness;
}

function jsonUrls(output: string): string[] {
  return (JSON.parse(output) as { results: { url: string }[] }).results.map(
    (result) => result.url.replace("https://docs.sentry.io", ""),
  );
}

beforeEach(() => {
  loadDocsIndex.mockReset();
  loadDocsIndex.mockResolvedValue({ index });
});

describe("sentry docs", () => {
  test("prints titles and Markdown URLs", async () => {
    const { stdout } = await runDocs(["nextjs", "tracing", "-n", "1"]);

    expect(stdout()).toBe(
      "Set Up Tracing\n  https://docs.sentry.io/platforms/javascript/guides/nextjs/tracing.md\n",
    );
    expect(loadDocsIndex).toHaveBeenCalledWith({ fresh: false });
  });

  test("outputs results and warnings as JSON", async () => {
    const { stdout } = await runDocs(["djnago", "--json", "-n", "1"]);

    expect(JSON.parse(stdout())).toEqual({
      results: [
        {
          title: "Django",
          description: expect.any(String),
          url: "https://docs.sentry.io/platforms/python/integrations/django.md",
          breadcrumbs: ["Platforms", "Python", "Integrations"],
        },
      ],
      warnings: ['Searched "django" for "djnago".'],
    });
  });

  test.each([
    [["-e", "integrations/(django|celery)$"]],
    [["--regexp", "integrations/(django|celery)$"]],
    [["--regex", "integrations/(django|celery)$"]],
    [["-E", "integrations/(django|celery)$", "-i"]],
    [["-e", "integrations/django$", "-e", "integrations/celery$"]],
  ])("filters with grep-style patterns: %j", async (args) => {
    const { stdout } = await runDocs([...args, "--json"]);

    expect(jsonUrls(stdout())).toEqual([
      "/platforms/python/integrations/celery.md",
      "/platforms/python/integrations/django.md",
    ]);
  });

  test("passes --fresh to the index loader", async () => {
    await runDocs(["celery", "--fresh", "--json"]);

    expect(loadDocsIndex).toHaveBeenCalledWith({ fresh: true });
  });

  test("shows the loader's warning", async () => {
    loadDocsIndex.mockResolvedValue({ index, warning: "Using a stale copy." });

    const { stdout } = await runDocs(["celery", "--json"]);

    expect(JSON.parse(stdout()).warnings).toEqual(["Using a stale copy."]);
  });

  test("succeeds with a hint when nothing matches", async () => {
    const { context, stdout } = await runDocs(["-e", "^nothing-here$"]);

    expect(stdout()).toContain("No documentation pages match");
    expect(context.process.exitCode ?? 0).toBe(0);
  });

  test("asks for words when given none", async () => {
    const { context } = createContext();
    const func = await docsCommand.loader();

    await expect(
      func.call(context, {
        fresh: false,
        ignoreCase: false,
        json: false,
        limit: 8,
      }),
    ).rejects.toThrow(ValidationError);
    expect(loadDocsIndex).not.toHaveBeenCalled();
  });
});
