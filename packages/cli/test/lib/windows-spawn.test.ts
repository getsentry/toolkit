/**
 * Tests for resolveSpawnTarget: how `sentry local run` and `sentry monitor
 * run` spawn the user's command on Windows (CLI-3T4). Windows is simulated
 * with the `platform` argument; the PATH lookup uses real files in a temp dir.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { augmentPathForNode } from "../../src/commands/local/run.js";
import { ValidationError } from "../../src/lib/errors.js";
import { resolveSpawnTarget } from "../../src/lib/windows-spawn.js";
import { TEST_TMP_DIR } from "../constants.js";

let tmpDir: string;
let nodeDir: string;
let binDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(TEST_TMP_DIR, "windows-spawn-test-"));
  nodeDir = join(tmpDir, "nodejs");
  binDir = join(tmpDir, "node_modules", ".bin");
  await mkdir(nodeDir, { recursive: true });
  await mkdir(binDir, { recursive: true });
  // npm installs an extensionless sh script next to npm.cmd; Windows must
  // not pick it.
  await writeFile(join(nodeDir, "npm"), "");
  await writeFile(join(nodeDir, "npm.cmd"), "");
  await writeFile(join(nodeDir, "node.exe"), "");
  await writeFile(join(binDir, "next.cmd"), "");
  await writeFile(join(nodeDir, "tool.js"), "");
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

/** Resolve as Windows would, with a Windows-style env (`Path`, not `PATH`). */
function onWindows(command: string, args: string[], path = nodeDir) {
  return resolveSpawnTarget(
    command,
    args,
    {
      cwd: tmpDir,
      env: { Path: path, PATHEXT: ".COM;.EXE;.BAT;.CMD", ComSpec: "cmd.exe" },
    },
    "win32",
  );
}

describe("resolveSpawnTarget", () => {
  test("leaves the command alone on other platforms", () => {
    expect(
      resolveSpawnTarget("npm", ["run", "dev"], { cwd: tmpDir, env: {} }),
    ).toEqual({ command: "npm", args: ["run", "dev"] });
  });

  test.each(["npm", "npm.cmd"])(
    "runs %s through cmd.exe instead of failing with EINVAL or ENOENT",
    (command) => {
      expect(onWindows(command, ["run", "dev"])).toEqual({
        command: "cmd.exe",
        args: [
          "/d",
          "/e:ON",
          "/v:OFF",
          "/s",
          "/c",
          `""${join(nodeDir, "npm.cmd")}" "run" "dev""`,
        ],
        windowsVerbatimArguments: true,
      });
    },
  );

  test("runs an .exe directly by its full path", () => {
    expect(onWindows("node", ["server.js"])).toEqual({
      command: join(nodeDir, "node.exe"),
      args: ["server.js"],
    });
  });

  test("runs other PATHEXT matches through cmd.exe, like cross-spawn", () => {
    const target = resolveSpawnTarget(
      "tool",
      [],
      { cwd: tmpDir, env: { Path: nodeDir, PATHEXT: ".EXE;.JS" } },
      "win32",
    );
    expect(target.command).toBe("cmd.exe");
    expect(target.args.at(-1)).toBe(`""${join(nodeDir, "tool.js")}""`);
  });

  test("strips quotes around PATH entries", () => {
    const target = onWindows("npm", [], `"${nodeDir}"`);
    expect(target.args.at(-1)).toBe(`""${join(nodeDir, "npm.cmd")}""`);
  });

  test("finds node_modules/.bin shims on the PATH local run builds", () => {
    // A Windows env copy spells the key `Path`; augmentPathForNode must
    // prepend to it, not add a second `PATH` holding only node_modules/.bin.
    const env = augmentPathForNode(
      { Path: nodeDir, PATHEXT: ".COM;.EXE;.BAT;.CMD" },
      tmpDir,
      "win32",
    );
    expect(env).toEqual({
      Path: `${binDir};${nodeDir}`,
      PATHEXT: ".COM;.EXE;.BAT;.CMD",
    });
    const target = resolveSpawnTarget(
      "next",
      ["dev"],
      { cwd: tmpDir, env },
      "win32",
    );
    expect(target.args.at(-1)).toContain(join(binDir, "next.cmd"));
    expect(
      resolveSpawnTarget("node", [], { cwd: tmpDir, env }, "win32").command,
    ).toBe(join(nodeDir, "node.exe"));
  });

  test("returns an unknown command unchanged so spawn reports ENOENT", () => {
    expect(onWindows("nosuchbinary123", ["x"])).toEqual({
      command: "nosuchbinary123",
      args: ["x"],
    });
  });

  test("quotes batch arguments so cmd.exe cannot run any part of them", () => {
    // BatBadBut (CVE-2024-24576): cmd.exe ignores \" when the batch file
    // re-reads %*, so `"` is doubled instead and every argument is quoted.
    // `%` gets a guard that expands to nothing, so %PATH% stays literal.
    const line = onWindows("npm", [
      'say "a&b"',
      'x"&echo INJECTED&"',
      "C:\\dir\\",
      'a\\"b',
      "100%",
      "%PATH%",
      "a^b",
    ]).args.at(-1);
    expect(line).toBe(
      `""${join(nodeDir, "npm.cmd")}" "say ""a&b""" "x""&echo INJECTED&"""` +
        ` "C:\\dir\\\\" "a\\\\""b" "100%%cd:~,%" "%%cd:~,%PATH%%cd:~,%" "a^b""`,
    );
  });

  test.each(["a\nb", "a\rb"])(
    "rejects a line break in a batch argument (%j)",
    (arg) => {
      expect(() => onWindows("npm", [arg])).toThrow(ValidationError);
    },
  );
});
