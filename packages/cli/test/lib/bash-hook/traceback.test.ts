/**
 * Tests for the bash-hook traceback parser and event builder.
 *
 * Tests parseTracebackContent (pure function) and buildBashErrorEvent
 * (async, reads files from disk).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  buildBashErrorEvent,
  parseTracebackContent,
} from "../../../src/lib/bash-hook/traceback.js";

describe("parseTracebackContent", () => {
  test("parses frames with function, file, and line", () => {
    const content =
      "main:/home/user/script.sh:10\nhelper:/home/user/lib.sh:5\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(2);
    expect(result.frames[0]).toMatchObject({
      function: "main",
      filename: "/home/user/script.sh",
      lineno: 10,
    });
    expect(result.frames[1]).toMatchObject({
      function: "helper",
      filename: "/home/user/lib.sh",
      lineno: 5,
    });
  });

  test("extracts command metadata", () => {
    const content = "@command:curl https://example.com\n@exit_code:127\n";
    const result = parseTracebackContent(content);

    expect(result.command).toBe("curl https://example.com");
    expect(result.exitCode).toBe(127);
  });

  test("defaults to unknown command and exit code 1", () => {
    const content = "main:/script.sh:1\n";
    const result = parseTracebackContent(content);

    expect(result.command).toBe("unknown");
    expect(result.exitCode).toBe(1);
  });

  test("filters out internal sentry hook frames", () => {
    const content = [
      "_sentry_err_trap:/script.sh:1",
      "_sentry_exit_trap:/script.sh:2",
      "_sentry_traceback:/script.sh:3",
      "real_function:/script.sh:10",
      "@command:failing_cmd",
      "@exit_code:1",
    ].join("\n");

    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.function).toBe("real_function");
  });

  test("skips blank lines", () => {
    const content = "\nmain:/script.sh:1\n\n\nhelper:/lib.sh:5\n\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(2);
  });

  test("skips unknown @-prefixed metadata lines", () => {
    const content = "@unknown:value\nmain:/script.sh:1\n@command:test\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(1);
    expect(result.command).toBe("test");
  });

  test("handles non-matching lines gracefully", () => {
    const content = "this is not a frame line\nmain:/script.sh:1\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(1);
  });

  test("handles empty content", () => {
    const result = parseTracebackContent("");

    expect(result.frames).toHaveLength(0);
    expect(result.command).toBe("unknown");
    expect(result.exitCode).toBe(1);
  });

  test("handles frame with empty function name", () => {
    const content = ":/script.sh:10\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(1);
    // Empty function name becomes undefined
    expect(result.frames[0]?.function).toBeUndefined();
    expect(result.frames[0]?.filename).toBe("/script.sh");
  });

  test("handles invalid exit code gracefully", () => {
    const content = "@exit_code:not_a_number\n";
    const result = parseTracebackContent(content);

    // Falls back to default
    expect(result.exitCode).toBe(1);
  });

  test("handles file paths with colons", () => {
    // The regex is non-greedy on function name, so C:\path works
    const content = "main:C:\\Users\\test\\script.sh:42\n";
    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(1);
    expect(result.frames[0]?.filename).toBe("C:\\Users\\test\\script.sh");
    expect(result.frames[0]?.lineno).toBe(42);
  });

  test("full realistic traceback", () => {
    const content = [
      "deploy:/opt/ci/deploy.sh:45",
      "run_tests:/opt/ci/test.sh:12",
      "main:/opt/ci/pipeline.sh:8",
      "@command:npm test",
      "@exit_code:2",
    ].join("\n");

    const result = parseTracebackContent(content);

    expect(result.frames).toHaveLength(3);
    expect(result.command).toBe("npm test");
    expect(result.exitCode).toBe(2);
    expect(result.frames[0]?.function).toBe("deploy");
    expect(result.frames[2]?.function).toBe("main");
  });
});

describe("buildBashErrorEvent", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await mkdtemp(join(tmpdir(), "bash-hook-test-"));
  });

  afterEach(async () => {
    await rm(tempDir, { recursive: true, force: true });
  });

  test("builds event from traceback file", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(
      tracebackPath,
      "main:/script.sh:10\n@command:curl\n@exit_code:1\n"
    );

    const event = await buildBashErrorEvent({ tracebackPath });

    expect(event.event_id).toBeDefined();
    expect(event.level).toBe("error");
    expect(event.platform).toBe("other");
    expect(event.exception?.values).toHaveLength(1);
    expect(event.exception?.values?.[0]?.type).toBe("BashError");
    expect(event.exception?.values?.[0]?.value).toBe(
      "command curl exited with status 1"
    );
    expect(event.exception?.values?.[0]?.stacktrace?.frames).toHaveLength(1);
  });

  test("attaches log file as breadcrumbs", async () => {
    const tracebackPath = join(tempDir, "traceback");
    const logPath = join(tempDir, "log");
    await writeFile(tracebackPath, "main:/script.sh:1\n@command:test\n");
    await writeFile(logPath, "line 1\nline 2\nline 3\n");

    const event = await buildBashErrorEvent({ tracebackPath, logPath });

    expect(event.breadcrumbs).toHaveLength(3);
    expect(event.breadcrumbs?.[0]?.message).toBe("line 1");
    expect(event.breadcrumbs?.[0]?.category).toBe("log");
  });

  test("attaches tags to event", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(tracebackPath, "@command:test\n@exit_code:1\n");

    const event = await buildBashErrorEvent({
      tracebackPath,
      tags: { env: "prod", tier: "backend" },
    });

    expect(event.tags).toEqual({ env: "prod", tier: "backend" });
  });

  test("attaches release to event", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(tracebackPath, "@command:test\n");

    const event = await buildBashErrorEvent({
      tracebackPath,
      release: "1.0.0",
    });

    expect(event.release).toBe("1.0.0");
  });

  test("throws ValidationError for missing traceback file", async () => {
    await expect(
      buildBashErrorEvent({ tracebackPath: join(tempDir, "nonexistent") })
    ).rejects.toThrow("Traceback file not found");
  });

  test("omits breadcrumbs when no log file", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(tracebackPath, "@command:test\n");

    const event = await buildBashErrorEvent({ tracebackPath });

    expect(event.breadcrumbs).toBeUndefined();
  });

  test("omits tags when empty", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(tracebackPath, "@command:test\n");

    const event = await buildBashErrorEvent({ tracebackPath, tags: {} });

    expect(event.tags).toBeUndefined();
  });

  test("handles empty log file gracefully", async () => {
    const tracebackPath = join(tempDir, "traceback");
    const logPath = join(tempDir, "log");
    await writeFile(tracebackPath, "@command:test\n");
    await writeFile(logPath, "");

    const event = await buildBashErrorEvent({ tracebackPath, logPath });

    // Empty log file means no breadcrumbs
    expect(event.breadcrumbs).toBeUndefined();
  });

  test("reverses frames to Sentry oldest-to-youngest order", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(
      tracebackPath,
      "inner:/script.sh:10\nmiddle:/script.sh:5\nouter:/script.sh:1\n@command:test\n"
    );

    const event = await buildBashErrorEvent({ tracebackPath });

    const frames = event.exception?.values?.[0]?.stacktrace?.frames;
    expect(frames).toHaveLength(3);
    // Sentry expects oldest (outer) first, crash frame (inner) last
    expect(frames?.[0]?.function).toBe("outer");
    expect(frames?.[1]?.function).toBe("middle");
    expect(frames?.[2]?.function).toBe("inner");
  });

  test("includes username in event", async () => {
    const tracebackPath = join(tempDir, "traceback");
    await writeFile(tracebackPath, "@command:test\n");

    const event = await buildBashErrorEvent({ tracebackPath });

    // Should have a user with username (from os.userInfo)
    expect(event.user?.username).toBeDefined();
    expect(event.user?.ip_address).toBe("{{auto}}");
  });
});
