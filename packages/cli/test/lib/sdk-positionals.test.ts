/**
 * Unit Tests for Generated SDK Positional Arguments
 *
 * Commands whose positionals are declared as a tuple of several parameters must forward one argv
 * token per parameter. The generator used to join their placeholders into a single param, so the
 * whole string arrived as argv[0] and every later argument was missing - `release deploy` and
 * `snapshots diff` failed outright because their second positional is required.
 *
 * These tests drive the generated method tree with a recording invoker, so they fail if the
 * generator regresses without anyone having to read the generated output.
 */

import { describe, expect, test } from "vitest";
import { createSDKMethods } from "../../src/sdk.generated.js";

type RecordedCall = { path: string[]; positional: string[] };

function createRecordingSDK(): {
  calls: RecordedCall[];
  sdk: ReturnType<typeof createSDKMethods>;
} {
  const calls: RecordedCall[] = [];
  const invoke = ((path: string[], _flags: unknown, positional: string[]) => {
    calls.push({ path, positional });
    return Promise.resolve(undefined);
  }) as Parameters<typeof createSDKMethods>[0];

  return { calls, sdk: createSDKMethods(invoke) };
}

describe("generated SDK positional arguments", () => {
  test("release deploy passes version, environment and name as separate tokens", async () => {
    const { calls, sdk } = createRecordingSDK();

    await sdk.release.deploy({
      orgVersion: "1.0.0",
      environment: "production",
      name: "Deploy #42",
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]?.path).toEqual(["release", "deploy"]);
    expect(calls[0]?.positional).toEqual(["1.0.0", "production", "Deploy #42"]);
  });

  test("release deploy omits a trailing optional positional", async () => {
    const { calls, sdk } = createRecordingSDK();

    await sdk.release.deploy({
      orgVersion: "1.0.0",
      environment: "production",
    });

    expect(calls[0]?.positional).toEqual(["1.0.0", "production"]);
  });

  test("a missing middle positional keeps later arguments in their own slots", async () => {
    const { calls, sdk } = createRecordingSDK();

    // Dropping the hole instead would make "Deploy #42" the environment, quietly recording the
    // deploy against an environment the caller never named.
    await sdk.release.deploy({ orgVersion: "1.0.0", name: "Deploy #42" });

    expect(calls[0]?.positional).toEqual(["1.0.0", "", "Deploy #42"]);
  });

  test("snapshots diff passes both directories", async () => {
    const { calls, sdk } = createRecordingSDK();

    await sdk.snapshots.diff({ baseDir: "./base", headDir: "./head" });

    expect(calls[0]?.positional).toEqual(["./base", "./head"]);
  });

  test("commands with a single compound positional still pass one token", async () => {
    const { calls, sdk } = createRecordingSDK();

    // "org/version" is one placeholder that the command splits itself, not two positionals.
    await sdk.release.finalize({ orgVersion: "my-org/1.0.0" });

    expect(calls[0]?.positional).toEqual(["my-org/1.0.0"]);
  });

  test("a command with no positionals passes none", async () => {
    const { calls, sdk } = createRecordingSDK();

    await sdk.release.deploy({});

    expect(calls[0]?.positional).toEqual([]);
  });
});
