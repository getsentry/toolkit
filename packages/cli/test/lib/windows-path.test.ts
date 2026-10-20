/**
 * Windows user PATH persistence.
 *
 * The first block uses a fake PowerShell runner and runs everywhere. The
 * second runs the real script against a scratch registry key and only runs on
 * Windows (CI covers it in the Install Scripts workflow).
 */

import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import {
  addToWindowsUserPath,
  type PowerShellRunner,
  runWindowsPowerShell,
  USER_ENVIRONMENT_KEY,
} from "../../src/lib/windows-path.js";

describe("addToWindowsUserPath", () => {
  test("reports an added directory and passes values through the environment", async () => {
    const run = vi.fn<PowerShellRunner>().mockResolvedValue("added\r\n");

    const result = await addToWindowsUserPath("C:\\Users\\me\\.local\\bin", {
      run,
    });

    expect(result).toEqual({
      modified: true,
      message: "Added C:\\Users\\me\\.local\\bin to your user PATH",
      manualCommand: null,
    });
    const [script, env] = run.mock.calls[0]!;
    expect(env).toEqual({
      SENTRY_CLI_PATH_DIR: "C:\\Users\\me\\.local\\bin",
      SENTRY_CLI_PATH_KEY: USER_ENVIRONMENT_KEY,
    });
    // Values never get interpolated into the script itself.
    expect(script).not.toContain("C:\\Users\\me");
  });

  test("reports a directory that is already present", async () => {
    const run = vi.fn<PowerShellRunner>().mockResolvedValue("present\n");

    const result = await addToWindowsUserPath("C:\\bin", { run });

    expect(result).toEqual({
      modified: false,
      message: "C:\\bin is already in your user PATH",
      manualCommand: null,
    });
  });

  test("returns a manual step when PowerShell fails", async () => {
    const run = vi
      .fn<PowerShellRunner>()
      .mockRejectedValue(new Error("spawn powershell.exe ENOENT\nmore"));

    const result = await addToWindowsUserPath("C:\\bin", { run });

    expect(result.modified).toBe(false);
    expect(result.message).toBe(
      "Could not update your user PATH: spawn powershell.exe ENOENT",
    );
    expect(result.manualCommand).toContain("C:\\bin");
  });

  test("returns a manual step on unexpected output", async () => {
    const run = vi.fn<PowerShellRunner>().mockResolvedValue("");

    const result = await addToWindowsUserPath("C:\\bin", { run });

    expect(result.modified).toBe(false);
    expect(result.manualCommand).toContain("C:\\bin");
  });
});

describe.runIf(process.platform === "win32")(
  "addToWindowsUserPath against the registry",
  () => {
    let key: string;

    const ps = (script: string, env: Record<string, string> = {}) =>
      runWindowsPowerShell(script, { SENTRY_TEST_KEY: key, ...env });

    /** Raw (unexpanded) Path value and its registry kind. */
    async function readPath(): Promise<{ value: string; kind: string }> {
      const out = await ps(String.raw`
        $k = [Microsoft.Win32.Registry]::CurrentUser.OpenSubKey($env:SENTRY_TEST_KEY)
        try {
          $k.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
          $k.GetValueKind('Path').ToString()
        } finally { $k.Dispose() }
      `);
      const [value = "", kind = ""] = out.trim().split(/\r?\n/);
      return { value, kind };
    }

    async function seedPath(value: string): Promise<void> {
      await ps(
        String.raw`
          $k = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($env:SENTRY_TEST_KEY)
          try {
            $k.SetValue('Path', $env:SENTRY_TEST_VALUE, [Microsoft.Win32.RegistryValueKind]::ExpandString)
          } finally { $k.Dispose() }
        `,
        { SENTRY_TEST_VALUE: value },
      );
    }

    beforeEach(() => {
      key = `Software\\SentryCliTest\\${randomUUID()}`;
    });

    afterEach(async () => {
      await ps(
        "[Microsoft.Win32.Registry]::CurrentUser.DeleteSubKeyTree($env:SENTRY_TEST_KEY, $false)",
      );
    });

    test("creates the Path value as REG_EXPAND_SZ", async () => {
      const dir = join(tmpdir(), "sentry-bin");

      const result = await addToWindowsUserPath(dir, { key });

      expect(result.modified).toBe(true);
      expect(await readPath()).toEqual({ value: dir, kind: "ExpandString" });
    });

    test("prepends without expanding existing %VAR% entries", async () => {
      await seedPath("%USERPROFILE%\\tools;C:\\Other");
      const dir = join(tmpdir(), "sentry-bin");

      const result = await addToWindowsUserPath(dir, { key });

      expect(result.modified).toBe(true);
      expect(await readPath()).toEqual({
        value: `${dir};%USERPROFILE%\\tools;C:\\Other`,
        kind: "ExpandString",
      });
    });

    test("treats an equivalent %VAR% entry as already present", async () => {
      await seedPath("%USERPROFILE%\\.local\\bin\\;C:\\Other");
      const dir = join(process.env.USERPROFILE ?? "", ".local", "BIN");

      const result = await addToWindowsUserPath(dir, { key });

      expect(result.modified).toBe(false);
      expect(result.manualCommand).toBeNull();
      expect((await readPath()).value).toBe(
        "%USERPROFILE%\\.local\\bin\\;C:\\Other",
      );
    });
  },
);
