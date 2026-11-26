import assert from "node:assert/strict";
import test from "node:test";
import { smokeTestImage } from "./cli-docker-smoke-test.mjs";

const IMAGE = "ghcr.io/getsentry/toolkit/sentry-cli:abc123";
const HEAD = "abc123";
const PLATFORMS = ["linux/amd64", "linux/arm64"];

/** A fake `docker` that records its calls and answers like a working image. */
function fakeDocker({ version = "4.0.0", mountedHead = HEAD } = {}) {
  const calls = [];
  const docker = (args) => {
    calls.push(args);
    return args.includes("--version")
      ? `${version}\n`
      : JSON.stringify({ version: mountedHead, source: "git" });
  };
  return { calls, docker };
}

test("runs the CLI and reads the mounted checkout on every platform", () => {
  const { calls, docker } = fakeDocker();

  const versions = smokeTestImage({
    image: IMAGE,
    platforms: PLATFORMS,
    checkout: "/repo",
    head: HEAD,
    docker,
  });

  assert.deepEqual([...versions.keys()], PLATFORMS);
  assert.deepEqual(
    calls,
    PLATFORMS.flatMap((platform) => [
      ["run", "--rm", "--platform", platform, IMAGE, "--version"],
      [
        "run",
        "--rm",
        "--platform",
        platform,
        "--env",
        "SENTRY_AUTH_TOKEN=smoke-test",
        "--volume",
        "/repo:/work",
        IMAGE,
        "release",
        "propose-version",
        "--json",
      ],
    ]),
  );
});

test("fails when propose-version in /work reads another commit", () => {
  const { docker } = fakeDocker({ mountedHead: "def456" });

  assert.throws(
    () =>
      smokeTestImage({
        image: IMAGE,
        platforms: PLATFORMS,
        checkout: "/repo",
        head: HEAD,
        docker,
      }),
    /linux\/amd64: propose-version in \/work read def456, expected abc123/,
  );
});

test("fails when the CLI prints no version", () => {
  const { docker } = fakeDocker({ version: "" });

  assert.throws(
    () =>
      smokeTestImage({
        image: IMAGE,
        platforms: PLATFORMS,
        checkout: "/repo",
        head: HEAD,
        docker,
      }),
    /linux\/amd64: sentry --version printed nothing/,
  );
});
