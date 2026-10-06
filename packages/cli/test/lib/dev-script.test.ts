/**
 * Unit tests for detectDevCommand.
 *
 * Note: Core invariants (script priority detection for arbitrary script names)
 * are tested via property-based tests in dev-script.property.test.ts. These
 * tests focus on filesystem integration, fallback chains, and priority ordering.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { detectDevCommand } from "../../src/lib/dev-script.js";
import { TEST_TMP_DIR } from "../constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "dev-script-test-"));
});

afterEach(async () => {
  try {
    await rm(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore cleanup errors
  }
});

describe("detectDevCommand", () => {
  test("detects package.json scripts.dev", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } })
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["next", "dev"]);
    expect(result!.source).toBe("package.json scripts.dev");
  });

  test("detects package.json scripts.start when dev is absent", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node server.js" } })
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["node", "server.js"]);
    expect(result!.source).toBe("package.json scripts.start");
  });

  test("falls through package.json with no scripts", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ name: "test", version: "1.0.0" })
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).toBeNull();
  });

  test("detects manage.py (Django)", async () => {
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "manage.py", "runserver"]);
    expect(result!.source).toBe("manage.py");
  });

  test("detects app.py", async () => {
    await writeFile(join(tmpDir, "app.py"), "from flask import Flask");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "app.py"]);
    expect(result!.source).toBe("app.py");
  });

  test("detects main.py", async () => {
    await writeFile(join(tmpDir, "main.py"), "print('hello')");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["python", "main.py"]);
    expect(result!.source).toBe("main.py");
  });

  test("detects go.mod", async () => {
    await writeFile(join(tmpDir, "go.mod"), "module example.com/myapp");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["go", "run", "."]);
    expect(result!.source).toBe("go.mod");
  });

  test("detects docker-compose.yml", async () => {
    await writeFile(join(tmpDir, "docker-compose.yml"), "version: '3'");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["docker", "compose", "up"]);
    expect(result!.source).toBe("docker-compose.yml");
  });

  test("detects compose.yml", async () => {
    await writeFile(join(tmpDir, "compose.yml"), "version: '3'");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.args).toEqual(["docker", "compose", "up"]);
    expect(result!.source).toBe("compose.yml");
  });

  test("returns null for empty directory", async () => {
    const result = await detectDevCommand(tmpDir);
    expect(result).toBeNull();
  });

  test("package.json takes priority over manage.py", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "vite" } })
    );
    await writeFile(join(tmpDir, "manage.py"), "#!/usr/bin/env python");
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.dev");
  });

  test("prefers dev over start in package.json", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { start: "node index.js", dev: "vite" } })
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.dev");
    expect(result!.args).toEqual(["vite"]);
  });

  test("prefers develop over serve", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({
        scripts: { serve: "serve dist", develop: "gatsby develop" },
      })
    );
    const result = await detectDevCommand(tmpDir);
    expect(result).not.toBeNull();
    expect(result!.source).toBe("package.json scripts.develop");
  });
});
