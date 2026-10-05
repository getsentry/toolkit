/**
 * Tests for Cloudflare Wrangler command augmentation.
 *
 * These focus on exact command shapes because the helper sits at a process
 * boundary: a misplaced `--` or `--var` means the binding never reaches the
 * Worker even though the child process starts successfully.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { injectWranglerSpotlightBinding } from "../../src/lib/wrangler.js";
import { TEST_TMP_DIR } from "../constants.js";

const SPOTLIGHT_URL = "http://localhost:8969/stream";
const BINDING = `SENTRY_SPOTLIGHT:${SPOTLIGHT_URL}`;
const QUOTED_BINDING = `'${BINDING}'`;

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "wrangler-binding-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

async function addWranglerConfig(
  filename:
    | "wrangler.json"
    | "wrangler.jsonc"
    | "wrangler.toml" = "wrangler.jsonc"
): Promise<void> {
  await writeFile(join(tmpDir, filename), "{}");
}

describe("injectWranglerSpotlightBinding", () => {
  test.each([
    "wrangler.json",
    "wrangler.jsonc",
    "wrangler.toml",
  ] as const)("injects into direct wrangler dev with %s", async (filename) => {
    await addWranglerConfig(filename);

    const result = await injectWranglerSpotlightBinding(
      ["wrangler", "dev"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({
      args: ["wrangler", "dev", "--var", BINDING],
      injected: true,
    });
  });

  test("supports npx and a Wrangler binary path", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["npx", "./node_modules/.bin/wrangler", "dev", "--port", "8787"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "npx",
      "./node_modules/.bin/wrangler",
      "dev",
      "--port",
      "8787",
      "--var",
      BINDING,
    ]);
    expect(result.injected).toBe(true);
  });

  test("does not treat an argument containing wrangler dev as the executable", async () => {
    await addWranglerConfig();
    const args = ["echo", "wrangler", "dev"];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test("supports wrangler pages dev", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["wrangler", "pages", "dev", "./dist"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "wrangler",
      "pages",
      "dev",
      "./dist",
      "--var",
      BINDING,
    ]);
  });

  test("forwards the binding through an explicit npm script", async () => {
    await addWranglerConfig();
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "wrangler dev --port 8787" } })
    );

    const result = await injectWranglerSpotlightBinding(
      ["npm", "run", "dev"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual(["npm", "run", "dev", "--", "--var", BINDING]);
  });

  test("preserves a Spotlight binding declared inside a package script", async () => {
    await addWranglerConfig();
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: {
          dev: "wrangler dev --var SENTRY_SPOTLIGHT:http://localhost:9999/stream",
        },
      })
    );
    const args = ["npm", "run", "dev"];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test("injects before pnpm's literal package-script separator", async () => {
    await addWranglerConfig();
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "wrangler dev" } })
    );

    const result = await injectWranglerSpotlightBinding(
      ["pnpm", "run", "dev", "--", "--port", "8787"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "pnpm",
      "run",
      "dev",
      "--var",
      BINDING,
      "--",
      "--port",
      "8787",
    ]);
  });

  test("augments an auto-detected shell command", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["sh", "-c", "NODE_ENV=development wrangler dev"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "sh",
      "-c",
      `NODE_ENV=development wrangler dev --var ${QUOTED_BINDING}`,
    ]);
  });

  test("injects before a chained command instead of into the last command", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["sh", "-c", "wrangler dev --port 8787 && echo done"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "sh",
      "-c",
      `wrangler dev --port 8787 --var ${QUOTED_BINDING} && echo done`,
    ]);
  });

  test("does not inject into quoted text in a shell command", async () => {
    await addWranglerConfig();
    const args = ["sh", "-c", 'echo "run wrangler dev"'];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test("quotes the binding before adding it to a shell command", async () => {
    await addWranglerConfig();
    const unsafeUrl = "http://localhost:8969/stream'; echo injected";

    const result = await injectWranglerSpotlightBinding(
      ["sh", "-c", "wrangler dev"],
      unsafeUrl,
      tmpDir
    );

    expect(result.args).toEqual([
      "sh",
      "-c",
      "wrangler dev --var 'SENTRY_SPOTLIGHT:http://localhost:8969/stream'\\''; echo injected'",
    ]);
  });

  test("ignores shell operators inside quotes and substitutions", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      [
        "sh",
        "-c",
        'wrangler dev --define MESSAGE:"a && b" --name "$(echo x && echo y)" | tee output.log',
      ],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "sh",
      "-c",
      `wrangler dev --define MESSAGE:"a && b" --name "$(echo x && echo y)" --var ${QUOTED_BINDING} | tee output.log`,
    ]);
  });

  test("injects before a shell redirection", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["sh", "-c", "wrangler dev > wrangler.log 2>&1"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "sh",
      "-c",
      `wrangler dev --var ${QUOTED_BINDING} > wrangler.log 2>&1`,
    ]);
  });

  test("preserves an explicit Spotlight binding inside a shell script", async () => {
    await addWranglerConfig();
    const script =
      "wrangler dev --var SENTRY_SPOTLIGHT:http://localhost:9999/stream && echo done";

    const result = await injectWranglerSpotlightBinding(
      ["sh", "-c", script],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({
      args: ["sh", "-c", script],
      injected: false,
    });
  });

  test("supports Windows cmd and wrangler.cmd paths case-insensitively", async () => {
    await addWranglerConfig();

    const result = await injectWranglerSpotlightBinding(
      ["cmd.exe", "/C", String.raw`C:\repo\node_modules\.bin\WRANGLER.CMD dev`],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([
      "cmd.exe",
      "/C",
      String.raw`C:\repo\node_modules\.bin\WRANGLER.CMD dev --var "SENTRY_SPOTLIGHT:http://localhost:8969/stream"`,
    ]);
  });

  test("respects an explicit config path when no default config exists", async () => {
    const result = await injectWranglerSpotlightBinding(
      ["wrangler", "dev", "--config", "config/worker.jsonc"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.injected).toBe(true);
    expect(result.args).toEqual([
      "wrangler",
      "dev",
      "--config",
      "config/worker.jsonc",
      "--var",
      BINDING,
    ]);
  });

  test("detects a custom config path inside a package script", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { dev: "wrangler dev --config config/worker.jsonc" },
      })
    );

    const result = await injectWranglerSpotlightBinding(
      ["npm", "run", "dev"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual(["npm", "run", "dev", "--", "--var", BINDING]);
  });

  test("does not claim injection into a compound package script", async () => {
    await addWranglerConfig();
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "wrangler dev && node after.js" } })
    );
    const args = ["npm", "run", "dev"];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test.each([
    "pnpm",
    "yarn",
    "bun",
  ])("supports %s shorthand scripts without an npm-style separator", async (manager) => {
    await addWranglerConfig();
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "wrangler dev" } })
    );

    const result = await injectWranglerSpotlightBinding(
      [manager, "dev"],
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result.args).toEqual([manager, "dev", "--var", BINDING]);
  });

  test("does not override a user-supplied Spotlight binding", async () => {
    await addWranglerConfig();
    const custom = "SENTRY_SPOTLIGHT:http://localhost:9999/stream";
    const args = ["wrangler", "dev", "--var", custom];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test("does not change non-Wrangler commands in a Workers project", async () => {
    await addWranglerConfig();
    const args = ["vite", "dev"];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });

  test("does not change wrangler outside a Workers project", async () => {
    const args = ["wrangler", "dev"];

    const result = await injectWranglerSpotlightBinding(
      args,
      SPOTLIGHT_URL,
      tmpDir
    );

    expect(result).toEqual({ args, injected: false });
  });
});
