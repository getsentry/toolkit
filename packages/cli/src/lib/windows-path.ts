/**
 * Windows user PATH persistence.
 *
 * On Windows, the PATH that new terminals inherit lives in the registry
 * (`HKCU\Environment\Path`), not in shell config files. Node has no registry
 * API, so this runs a short script in Windows PowerShell, which ships with
 * every supported Windows version.
 */

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Registry key (under HKEY_CURRENT_USER) that holds user environment variables. */
export const USER_ENVIRONMENT_KEY = "Environment";

/**
 * Prepends `$env:SENTRY_CLI_PATH_DIR` to the `Path` value of
 * `HKCU\<$env:SENTRY_CLI_PATH_KEY>` and prints `added` or `present`.
 *
 * - Reads the raw value so existing `%VAR%` entries stay unexpanded, and
 *   writes it back as REG_EXPAND_SZ so Windows keeps expanding them.
 * - Compares entries after expansion, case-insensitively and ignoring a
 *   trailing backslash, so an equivalent entry is not added twice.
 * - Setting any user variable through .NET broadcasts WM_SETTINGCHANGE, which
 *   makes newly opened terminals pick up the change without signing out.
 */
const ADD_TO_USER_PATH_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$dir = $env:SENTRY_CLI_PATH_DIR
$keyName = $env:SENTRY_CLI_PATH_KEY
$key = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey($keyName)
try {
  $current = "$($key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames))"
  $entries = @($current -split ';' | Where-Object { $_ })
  $target = $dir.TrimEnd('\')
  foreach ($entry in $entries) {
    if ([Environment]::ExpandEnvironmentVariables($entry).TrimEnd('\') -ieq $target) {
      'present'
      return
    }
  }
  $key.SetValue('Path', ((@($dir) + $entries) -join ';'), [Microsoft.Win32.RegistryValueKind]::ExpandString)
} finally {
  $key.Dispose()
}
if ($keyName -eq 'Environment') {
  [Environment]::SetEnvironmentVariable('SENTRY_CLI_PATH_REFRESH', '1', 'User')
  [Environment]::SetEnvironmentVariable('SENTRY_CLI_PATH_REFRESH', $null, 'User')
}
'added'
`;

/** Result of persisting a directory on the Windows user PATH. */
export type WindowsPathResult = {
  /** Whether the user PATH was changed */
  modified: boolean;
  /** Message describing what happened */
  message: string;
  /** Instruction for adding the directory by hand when the update failed */
  manualCommand: string | null;
};

/** Runs a PowerShell script with extra environment variables and returns stdout. */
export type PowerShellRunner = (
  script: string,
  env: Record<string, string>,
) => Promise<string>;

/**
 * Locate Windows PowerShell by absolute path so a PATH missing System32 (or
 * shadowed by another `powershell.exe`) does not break setup.
 */
function getWindowsPowerShell(env: NodeJS.ProcessEnv): string {
  const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? env.windir;
  if (systemRoot) {
    const candidate = join(
      systemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return "powershell.exe";
}

/**
 * Default runner: Windows PowerShell with `-EncodedCommand`, which avoids
 * quoting issues and is not subject to the script execution policy. Values are
 * passed through environment variables, never interpolated into the script.
 */
export const runWindowsPowerShell: PowerShellRunner = async (script, env) => {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  const { stdout } = await execFileAsync(
    getWindowsPowerShell(process.env),
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", encoded],
    {
      env: { ...process.env, ...env },
      encoding: "utf8",
      timeout: 30_000,
      windowsHide: true,
    },
  );
  return stdout;
};

/**
 * Persist `directory` at the front of the current user's PATH on Windows.
 *
 * Never throws: failures come back as an unmodified result with a manual
 * instruction, matching how shell config edits report problems.
 *
 * @param directory - Absolute directory to add (the binary's directory)
 * @param options.run - PowerShell runner; tests inject a fake
 * @param options.key - Registry key under HKCU; tests use a scratch key
 */
export async function addToWindowsUserPath(
  directory: string,
  options: { run?: PowerShellRunner; key?: string } = {},
): Promise<WindowsPathResult> {
  const run = options.run ?? runWindowsPowerShell;
  const manualCommand = `Add ${directory} to your user PATH in System Properties > Environment Variables`;
  let output: string;
  try {
    output = await run(ADD_TO_USER_PATH_SCRIPT, {
      SENTRY_CLI_PATH_DIR: directory,
      SENTRY_CLI_PATH_KEY: options.key ?? USER_ENVIRONMENT_KEY,
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return {
      modified: false,
      message: `Could not update your user PATH: ${reason.split("\n")[0]}`,
      manualCommand,
    };
  }

  const status = output.trim().split(/\r?\n/).at(-1);
  if (status === "present") {
    return {
      modified: false,
      message: `${directory} is already in your user PATH`,
      manualCommand: null,
    };
  }
  if (status === "added") {
    return {
      modified: true,
      message: `Added ${directory} to your user PATH`,
      manualCommand: null,
    };
  }
  return {
    modified: false,
    message: "Could not update your user PATH: unexpected PowerShell output",
    manualCommand,
  };
}
