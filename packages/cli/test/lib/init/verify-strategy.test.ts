/**
 * Tests for post-init verification strategy selection (Flutter / Expo / local).
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  hasExpoProject,
  hasFlutterProject,
  resolveVerifyStrategy,
} from "../../../src/lib/init/verify-strategy.js";
import { TEST_TMP_DIR } from "../../constants.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "verify-strategy-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("resolveVerifyStrategy", () => {
  test("uses flutter doctor when wizard platform is flutter", async () => {
    const strategy = await resolveVerifyStrategy("flutter", tmpDir);
    expect(strategy).toEqual({
      kind: "doctor",
      tool: "flutter",
      args: ["flutter", "doctor"],
      source: "wizard.platform=flutter",
    });
  });

  test("uses expo doctor when wizard platform contains expo", async () => {
    const strategy = await resolveVerifyStrategy("javascript-expo", tmpDir);
    expect(strategy.kind).toBe("doctor");
    if (strategy.kind !== "doctor") {
      return;
    }
    expect(strategy.tool).toBe("expo");
    expect(strategy.args.slice(1)).toEqual(["expo", "doctor"]);
    expect(strategy.source).toBe("wizard.platform=javascript-expo");
  });

  test("prefers wizard flutter platform over expo filesystem markers", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { expo: "~52.0.0" } }),
    );
    const strategy = await resolveVerifyStrategy("flutter", tmpDir);
    expect(strategy).toMatchObject({ kind: "doctor", tool: "flutter" });
  });

  test("detects Flutter from pubspec.yaml when platform is unset", async () => {
    await writeFile(
      join(tmpDir, "pubspec.yaml"),
      "name: demo\nenvironment:\n  sdk: flutter\n",
    );
    const strategy = await resolveVerifyStrategy(undefined, tmpDir);
    expect(strategy).toEqual({
      kind: "doctor",
      tool: "flutter",
      args: ["flutter", "doctor"],
      source: "pubspec.yaml",
    });
  });

  test("detects Expo from package.json when platform is unset", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { expo: "51.0.0", react: "18.0.0" } }),
    );
    const strategy = await resolveVerifyStrategy(undefined, tmpDir);
    expect(strategy).toMatchObject({
      kind: "doctor",
      tool: "expo",
      source: "expo project markers",
    });
  });

  test("detects Expo from app.json expo key", async () => {
    await writeFile(
      join(tmpDir, "app.json"),
      JSON.stringify({ expo: { name: "demo", slug: "demo" } }),
    );
    expect(await hasExpoProject(tmpDir)).toBe(true);
    const strategy = await resolveVerifyStrategy("react-native", tmpDir);
    expect(strategy).toMatchObject({ kind: "doctor", tool: "expo" });
  });

  test("prefers Flutter filesystem markers over Expo when both exist", async () => {
    await writeFile(
      join(tmpDir, "pubspec.yaml"),
      "name: demo\ndependencies:\n  flutter:\n    sdk: flutter\n",
    );
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ dependencies: { expo: "51.0.0" } }),
    );
    const strategy = await resolveVerifyStrategy(undefined, tmpDir);
    expect(strategy).toMatchObject({ kind: "doctor", tool: "flutter" });
  });

  test("falls back to local verification for ordinary JS projects", async () => {
    await writeFile(
      join(tmpDir, "package.json"),
      JSON.stringify({ scripts: { dev: "next dev" } }),
    );
    expect(await resolveVerifyStrategy("javascript-nextjs", tmpDir)).toEqual({
      kind: "local",
    });
  });
});

describe("hasFlutterProject", () => {
  test("requires an sdk: flutter constraint", async () => {
    await writeFile(
      join(tmpDir, "pubspec.yaml"),
      "name: pure_dart\nenvironment:\n  sdk: '>=3.0.0 <4.0.0'\n",
    );
    expect(await hasFlutterProject(tmpDir)).toBe(false);
  });
});
