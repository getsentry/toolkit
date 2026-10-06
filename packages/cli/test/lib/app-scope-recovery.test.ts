import { homedir } from "node:os";
import { run } from "@stricli/core";
import { afterEach, describe, expect, test } from "vitest";
import { app } from "../../src/app.js";
import type { SentryContext } from "../../src/context.js";
import { getConfigDir } from "../../src/lib/db/index.js";
import { ApiError } from "../../src/lib/errors.js";

const originalFetch = globalThis.fetch;

function context(): SentryContext {
  return {
    process,
    env: process.env,
    cwd: process.cwd(),
    homeDir: homedir(),
    configDir: getConfigDir(),
    stdout: { write: () => true },
    stderr: { write: () => true },
    stdin: process.stdin,
  };
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("scope-recovery error boundary", () => {
  test.each([401, 403])("lets API %i escape Stricli", async (status) => {
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ detail: "Denied" }), {
        status,
        headers: { "content-type": "application/json" },
      })) as typeof fetch;

    let thrown: unknown;
    try {
      await run(app, ["org", "list", "--fresh"], context());
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ApiError);
    expect((thrown as ApiError).status).toBe(status);
  });
});
