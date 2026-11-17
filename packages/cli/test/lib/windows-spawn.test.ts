/**
 * Tests for resolveSpawnTarget: how `sentry local run` and `sentry monitor
 * run` spawn the user's command on Windows (CLI-3T4). Windows is simulated
 * with the `platform` argument; the PATH lookup uses real files in a temp dir.
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
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
      const target = onWindows(command, ["run", "dev"]);
      expect(target.command).toBe("cmd.exe");
      expect(target.windowsVerbatimArguments).toBe(true);
      expect(target.args).toEqual([
        "/d",
        "/s",
        "/c",
        `"${join(nodeDir, "npm.cmd")} ^"run^" ^"dev^""`,
      ]);
    },
  );

  test("runs an .exe directly by its full path", () => {
    expect(onWindows("node", ["server.js"])).toEqual({
      command: join(nodeDir, "node.exe"),
      args: ["server.js"],
    });
  });

  test("finds node_modules/.bin shims on the child's PATH", () => {
    const target = onWindows("next", ["dev"], `${binDir};${nodeDir}`);
    expect(target.args.at(-1)).toContain(join(binDir, "next.cmd"));
  });

  test("reads the PATH key Node gives the child when both Path and PATH exist", () => {
    // local run spreads process.env (`Path` on Windows), then adds `PATH`
    // with node_modules/.bin; Node keeps the key that sorts first (`PATH`).
    const target = resolveSpawnTarget(
      "next",
      ["dev"],
      { cwd: tmpDir, env: { Path: nodeDir, PATH: `${binDir};${nodeDir}` } },
      "win32",
    );
    expect(target.args.at(-1)).toContain(join(binDir, "next.cmd"));
  });

  test("returns an unknown command unchanged so spawn reports ENOENT", () => {
    expect(onWindows("nosuchbinary123", ["x"])).toEqual({
      command: "nosuchbinary123",
      args: ["x"],
    });
  });

  test("quotes arguments so cmd.exe passes them through intact", () => {
    const [, , , line] = onWindows("npm", [
      "run",
      "dev",
      "--",
      "--port",
      "3000 & calc",
      'say "hi"',
      "C:\\dir\\",
      "100%",
    ]).args;
    // Spaces, &, %, and quotes are ^-escaped, so cmd.exe neither splits nor
    // runs them; embedded quotes and trailing backslashes follow the MSVCRT
    // rules the program uses to split its command line.
    expect(line).toBe(
      `"${join(nodeDir, "npm.cmd")} ^"run^" ^"dev^" ^"--^" ^"--port^"` +
        ` ^"3000^ ^&^ calc^" ^"say^ \\^"hi\\^"^" ^"C:\\dir\\\\^" ^"100^%^""`,
    );
  });

  test("escapes metacharacters twice for node_modules/.bin shims", () => {
    const [, , , line] = onWindows("next", ["a&b"], binDir).args;
    expect(line).toBe(`"${join(binDir, "next.cmd")} ^^^"a^^^&b^^^""`);
  });
});
