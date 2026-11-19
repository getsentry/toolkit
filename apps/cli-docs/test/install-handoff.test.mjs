import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { buildOutput } from "../vercel/build-output.mjs";
import { createHandler } from "../vercel/install-handoff.mjs";

const code = `sntryh_${"a1_-".repeat(10)}xyz`;
const echoHandoff = createHandler({
  install: `#!/bin/bash\nprintf '%s' "\${SENTRY_HANDOFF:-unset}"\n`,
  // A failing install must still clear the variable, so this one can throw.
  "install.ps1": `[Console]::Out.Write("$env:SENTRY_HANDOFF")\nif ($env:SENTRY_TEST_THROW) { throw 'install failed' }\n`,
});
const hasPwsh =
  spawnSync("pwsh", ["-NoProfile", "-Command", "exit 0"], { stdio: "ignore" }).status === 0;

async function pipeToBash(response) {
  return spawnSync("bash", [], {
    input: await response.text(),
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

// Runs the response the way `irm <url> | iex` does, then prints whether
// SENTRY_HANDOFF is still set in the session.
async function pipeToIex(response, env = {}) {
  const dir = mkdtempSync(join(tmpdir(), "cli-docs-iex-"));
  const script = join(dir, "install.ps1");
  writeFileSync(script, await response.text());
  try {
    return spawnSync(
      "pwsh",
      [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `try { Get-Content -Raw -LiteralPath '${script}' | Invoke-Expression } catch { [Console]::Out.Write("|threw") }; [Console]::Out.Write("|after=$env:SENTRY_HANDOFF")`,
      ],
      { encoding: "utf8", env: { PATH: process.env.PATH, HOME: process.env.HOME, ...env } },
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("piping /install/<code> to bash runs the script with SENTRY_HANDOFF set", async () => {
  for (const url of [
    `https://cli.sentry.dev/install-handoff?script=install&code=${code}`,
    `https://cli.sentry.dev/install/${code}`,
  ]) {
    const response = echoHandoff(new Request(url));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get("cache-control"), "no-store");
    const result = await pipeToBash(response);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout, code);
  }
});

test(
  "piping /install.ps1/<code> to iex runs the script with SENTRY_HANDOFF set, then clears it",
  { skip: !hasPwsh && "pwsh is not installed" },
  async () => {
    for (const url of [
      `https://cli.sentry.dev/install-handoff?script=install.ps1&code=${code}`,
      `https://cli.sentry.dev/install.ps1/${code}`,
    ]) {
      const response = echoHandoff(new Request(url));
      assert.equal(response.status, 200);
      assert.equal(response.headers.get("cache-control"), "no-store");
      const result = await pipeToIex(response);
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.stdout, `${code}|after=`);
    }

    const failed = await pipeToIex(
      echoHandoff(new Request(`https://cli.sentry.dev/install.ps1/${code}`)),
      { SENTRY_TEST_THROW: "1" },
    );
    assert.equal(failed.stdout, `${code}|threw|after=`);
  },
);

test("anything but a known script and a well-formed handoff code is not found", async () => {
  const bad = [
    ["install", ""],
    ["install", "sntryh_short"],
    ["install", `sntryh_${"a".repeat(42)}'`],
    ["install", `sntryh_${"a".repeat(40)}';id`],
    ["install.ps1", `sntryh_${"a".repeat(40)}';id`],
    ["install", `${code}a`],
    ["install", `sntryx_${"a".repeat(43)}`],
    ["", code],
    ["install.sh", code],
    ["constructor", code],
  ];
  for (const [script, badCode] of bad) {
    const response = echoHandoff(
      new Request(
        `https://cli.sentry.dev/install-handoff?script=${encodeURIComponent(script)}&code=${encodeURIComponent(badCode)}`,
      ),
    );
    assert.equal(response.status, 404, `${script} ${badCode}`);
    assert.equal(await response.text(), "Not found\n");
  }
});

test("the packaged site routes /install/<code> and /install.ps1/<code> to a function serving the install scripts", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-docs-vercel-"));
  try {
    const dist = join(dir, "dist");
    const output = join(dir, "output");
    const bash = readFileSync(new URL("../public/install", import.meta.url), "utf8");
    const powershell = readFileSync(new URL("../public/install.ps1", import.meta.url), "utf8");
    mkdirSync(dist);
    writeFileSync(join(dist, "install"), bash);
    writeFileSync(join(dist, "install.ps1"), powershell);
    buildOutput(dist, output);

    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8"));
    const route = config.routes.find((r) => r.dest?.startsWith("/install-handoff"));
    const src = new RegExp(route.src);
    assert.deepEqual(`/install/${code}`.match(src)?.slice(1), ["install", code]);
    assert.deepEqual(`/install.ps1/${code}`.match(src)?.slice(1), ["install.ps1", code]);
    assert.equal(src.test(`/install/${code}x`), false);
    assert.equal(src.test(`/installxps1/${code}`), false);
    assert.equal(readFileSync(join(output, "static", "install"), "utf8"), bash);
    assert.equal(readFileSync(join(output, "static", "install.ps1"), "utf8"), powershell);

    const fn = join(output, "functions", "install-handoff.func");
    assert.deepEqual(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8")), {
      runtime: "edge",
      entrypoint: "index.js",
    });
    const { default: handler } = await import(pathToFileURL(join(fn, "index.js")).href);
    const serve = (script) =>
      handler(
        new Request(
          `https://cli.sentry.dev${route.dest.replace("$1", script).replace("$2", code)}`,
        ),
      ).text();

    const [shebang, ...rest] = bash.split("\n");
    assert.equal(
      await serve("install"),
      [shebang, `export SENTRY_HANDOFF='${code}'`, ...rest].join("\n"),
    );
    const ps1 = await serve("install.ps1");
    assert.ok(ps1.startsWith(`$env:SENTRY_HANDOFF = '${code}'\ntry {\n${powershell}`));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
