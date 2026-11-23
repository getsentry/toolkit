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
const echoHandoff = createHandler(`#!/bin/bash\nprintf '%s' "\${SENTRY_HANDOFF:-unset}"\n`);

async function pipeToBash(response) {
  return spawnSync("bash", [], {
    input: await response.text(),
    encoding: "utf8",
    env: { PATH: process.env.PATH },
  });
}

test("piping /install/<code> to bash runs the script with SENTRY_HANDOFF set", async () => {
  for (const url of [
    `https://cli.sentry.dev/install-handoff?code=${code}`,
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

test("anything but a well-formed handoff code is not found", async () => {
  for (const bad of [
    "",
    "sntryh_short",
    `sntryh_${"a".repeat(42)}'`,
    `sntryh_${"a".repeat(40)}';id`,
    `${code}a`,
    `sntryx_${"a".repeat(43)}`,
  ]) {
    const response = echoHandoff(
      new Request(`https://cli.sentry.dev/install-handoff?code=${encodeURIComponent(bad)}`),
    );
    assert.equal(response.status, 404, bad);
    assert.equal(await response.text(), "Not found\n");
  }
});

test("the packaged site routes /install/<code> to a function serving the install script", async () => {
  const dir = mkdtempSync(join(tmpdir(), "cli-docs-vercel-"));
  try {
    const dist = join(dir, "dist");
    const output = join(dir, "output");
    const script = readFileSync(new URL("../public/install", import.meta.url), "utf8");
    mkdirSync(dist);
    writeFileSync(join(dist, "install"), script);
    buildOutput(dist, output);

    const config = JSON.parse(readFileSync(join(output, "config.json"), "utf8"));
    const route = config.routes.find((r) => r.dest?.startsWith("/install-handoff"));
    const match = `/install/${code}`.match(new RegExp(route.src));
    assert.equal(match?.[1], code);
    assert.equal(new RegExp(route.src).test(`/install/${code}x`), false);
    assert.equal(readFileSync(join(output, "static", "install"), "utf8"), script);

    const fn = join(output, "functions", "install-handoff.func");
    assert.deepEqual(JSON.parse(readFileSync(join(fn, ".vc-config.json"), "utf8")), {
      runtime: "edge",
      entrypoint: "index.js",
    });
    const { default: handler } = await import(pathToFileURL(join(fn, "index.js")).href);
    const body = await handler(
      new Request(`https://cli.sentry.dev${route.dest.replace("$1", code)}`),
    ).text();
    const [shebang, ...rest] = script.split("\n");
    assert.equal(body, [shebang, `export SENTRY_HANDOFF='${code}'`, ...rest].join("\n"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
