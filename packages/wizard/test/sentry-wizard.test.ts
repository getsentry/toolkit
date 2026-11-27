import { type ChildProcess, spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, test } from "vitest";

const SOURCE_BIN = fileURLToPath(
  new URL("../bin/sentry-wizard.js", import.meta.url),
);
const NOTICE =
  "`@sentry/wizard` is deprecated. Use `npx sentry wizard` instead.\n";

// A stand-in for the `sentry` package's bin. It prints its arguments,
// SENTRY_URL and SENTRY_SPOTLIGHT, then behaves as FAKE_SENTRY says: exit with a code, die from a signal, or wait
// and report the signals it gets.
const FAKE_SENTRY_BIN = `
const [mode, value] = (process.env.FAKE_SENTRY ?? "exit:0").split(":");
process.stdout.write(
  JSON.stringify({
    args: process.argv.slice(2),
    url: process.env.SENTRY_URL,
    spotlight: process.env.SENTRY_SPOTLIGHT,
  }) + "\\n",
);
if (mode === "exit") process.exit(Number(value));
if (mode === "kill") process.kill(process.pid, value);
if (mode === "wait") {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    process.on(signal, () => {
      process.stdout.write(signal + "\\n");
      process.exit(Number(value));
    });
  }
  process.stdout.write("ready\\n");
  setInterval(() => {}, 1000);
}
`;

/** Install the forwarder, and the fake `sentry` unless `withSentry` is false. */
function install(dir: string, withSentry = true): string {
  const wizardDir = join(dir, "node_modules", "@sentry", "wizard");
  const bin = join(wizardDir, "bin", "sentry-wizard.js");
  mkdirSync(dirname(bin), { recursive: true });
  writeFileSync(
    join(wizardDir, "package.json"),
    JSON.stringify({ name: "@sentry/wizard", type: "module" }),
  );
  copyFileSync(SOURCE_BIN, bin);
  if (withSentry) {
    const sentryDir = join(dir, "node_modules", "sentry");
    mkdirSync(join(sentryDir, "dist"), { recursive: true });
    writeFileSync(
      join(sentryDir, "package.json"),
      // Like the real package, its `exports` don't include package.json.
      JSON.stringify({
        name: "sentry",
        main: "./dist/index.cjs",
        exports: { ".": { require: "./dist/index.cjs" } },
        bin: { sentry: "./dist/bin.cjs" },
      }),
    );
    writeFileSync(join(sentryDir, "dist", "index.cjs"), "");
    writeFileSync(join(sentryDir, "dist", "bin.cjs"), FAKE_SENTRY_BIN);
  }
  return bin;
}

type Run = {
  child: ChildProcess;
  stdout: () => string;
  stderr: () => string;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
};

function run(bin: string, args: string[], fake = "exit:0"): Run {
  // `pnpm run` sets NODE_PATH to its store, where Node would find the
  // workspace CLI instead of the fake.
  const {
    NODE_PATH: _nodePath,
    SENTRY_URL: _sentryUrl,
    SENTRY_SPOTLIGHT: _sentrySpotlight,
    ...env
  } = process.env;
  const child = spawn(process.execPath, [bin, ...args], {
    env: { ...env, FAKE_SENTRY: fake },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk: Buffer) => (stdout += chunk.toString()));
  child.stderr.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
  const done = once(child, "close").then(([code, signal]) => ({
    code: code as number | null,
    signal: signal as NodeJS.Signals | null,
  }));
  return { child, stdout: () => stdout, stderr: () => stderr, done };
}

async function waitFor(check: () => boolean): Promise<void> {
  while (!check()) {
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

let root: string;
let bin: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "sentry-wizard-test-"));
  bin = install(join(root, "project"));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("sentry-wizard", () => {
  test("prints the deprecation notice and translates -i, --org and --project", async () => {
    const result = run(bin, [
      "-i",
      "nextjs",
      "--org",
      "my-org",
      "--project",
      "my-app",
    ]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(result.stderr()).toBe(NOTICE);
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "my-org/my-app", "nextjs"],
    });
  });

  test("reads --flag=value forms, and --org alone as an org target", async () => {
    const result = run(bin, ["--integration=nextjs", "--org=my-org"]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "my-org/", "nextjs"],
    });
  });

  test("turns --force-install and --ignore-git-changes into one -f", async () => {
    const result = run(bin, [
      "--force-install",
      "-i",
      "nextjs",
      "--ignore-git-changes",
    ]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "nextjs", "-f"],
    });
  });

  test.each([["-f"], ["--force"], ["-f", "--force", "--force-install"]])(
    "passes %s through as one -f, with no notice",
    async (...forceArgs) => {
      const result = run(bin, ["-i", "nextjs", ...forceArgs]);

      expect(await result.done).toEqual({ code: 0, signal: null });
      expect(result.stderr()).toBe(NOTICE);
      expect(JSON.parse(result.stdout())).toEqual({
        args: ["wizard", "nextjs", "-f"],
      });
    },
  );

  test("sets SENTRY_SPOTLIGHT=1 for --spotlight instead of passing it on", async () => {
    const result = run(bin, ["--spotlight", "-i", "nextjs"]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(result.stderr()).toBe(NOTICE);
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "nextjs"],
      spotlight: "1",
    });
  });

  test.each([
    ["-u", "https://sentry.example.com"],
    ["--url", "https://sentry.example.com"],
    ["--url=https://sentry.example.com"],
  ])("sets SENTRY_URL for %s instead of passing it on", async (...urlArgs) => {
    const result = run(bin, [...urlArgs, "-i", "nextjs"]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "nextjs"],
      url: "https://sentry.example.com",
    });
  });

  test("drops other old flags and their values, with a notice for each", async () => {
    const result = run(bin, [
      "--project",
      "my-app",
      "--saas",
      "--debug",
      "--disable-telemetry",
      "--promo-code",
      "secret-code",
      "--skip-connect",
      "--quiet",
      "--uninstall",
      "-p",
      "ios",
      "android",
      "-i",
      "nextjs",
    ]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "nextjs"],
    });
    expect(result.stderr()).toBe(
      NOTICE +
        [
          "--saas",
          "--debug",
          "--disable-telemetry",
          "--promo-code",
          "--skip-connect",
          "--quiet",
          "--uninstall",
          "-p",
        ]
          .map(
            (flag) =>
              `Ignoring ${flag}: \`sentry wizard\` has no such option.\n`,
          )
          .join("") +
        "Ignoring --project: it needs --org, so the wizard asks for the project.\n",
    );
  });

  test("passes positionals and --help through", async () => {
    const result = run(bin, ["my-org/my-app", "nextjs", "--help"]);

    expect(await result.done).toEqual({ code: 0, signal: null });
    expect(JSON.parse(result.stdout())).toEqual({
      args: ["wizard", "my-org/my-app", "nextjs", "--help"],
    });
  });

  test("exits with the CLI's exit code", async () => {
    const result = run(bin, [], "exit:21");

    expect(await result.done).toEqual({ code: 21, signal: null });
  });

  test.skipIf(process.platform === "win32")(
    "ends with the signal that killed the CLI",
    async () => {
      const result = run(bin, [], "kill:SIGTERM");

      expect(await result.done).toEqual({ code: null, signal: "SIGTERM" });
    },
  );

  test.skipIf(process.platform === "win32")(
    "passes SIGTERM on to the CLI",
    async () => {
      const result = run(bin, [], "wait:7");
      await waitFor(() => result.stdout().includes("ready"));

      result.child.kill("SIGTERM");

      expect(await result.done).toEqual({ code: 7, signal: null });
      expect(result.stdout()).toContain("SIGTERM\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "passes a second SIGINT on to the CLI right away",
    async () => {
      const result = run(bin, [], "wait:130");
      await waitFor(() => result.stdout().includes("ready"));

      // The first one stands for Ctrl-C, which the terminal sends the CLI too.
      result.child.kill("SIGINT");
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(result.stdout()).not.toContain("SIGINT");
      result.child.kill("SIGINT");

      expect(await result.done).toEqual({ code: 130, signal: null });
      expect(result.stdout()).toContain("SIGINT\n");
    },
  );

  test.skipIf(process.platform === "win32")(
    "passes a lone SIGINT on to the CLI after a wait",
    async () => {
      const result = run(bin, [], "wait:130");
      await waitFor(() => result.stdout().includes("ready"));
      const start = Date.now();

      result.child.kill("SIGINT");

      expect(await result.done).toEqual({ code: 130, signal: null });
      expect(result.stdout()).toContain("SIGINT\n");
      expect(Date.now() - start).toBeGreaterThanOrEqual(2900);
    },
    10_000,
  );

  test("fails when the `sentry` package is missing", async () => {
    const result = run(install(join(root, "no-sentry"), false), []);

    expect(await result.done).toEqual({ code: 1, signal: null });
    expect(result.stderr()).toBe(
      `${NOTICE}Could not find the \`sentry\` package. Run \`npx sentry wizard\` instead.\n`,
    );
  });
});
