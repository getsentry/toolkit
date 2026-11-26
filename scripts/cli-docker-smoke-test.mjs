/**
 * Smoke-tests the CLI Docker image that cli-build.yml pushes. On each platform
 * the CLI starts, and git reads the checkout mounted at /work, the image's
 * working directory. Run it from the repository root:
 *
 *   node scripts/cli-docker-smoke-test.mjs <image> <platform>[,<platform>...]
 */
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * Throws when the image fails a check on any platform.
 *
 * @param {object} options
 * @param {string} options.image - Image reference to run.
 * @param {string[]} options.platforms - Platforms to run it on, such as
 *   `linux/arm64`.
 * @param {string} options.checkout - Host checkout to mount at /work.
 * @param {string} options.head - Commit that checkout is at.
 * @param {(args: string[]) => string} options.docker - Runs `docker` with the
 *   arguments and returns its stdout; throws on a non-zero exit.
 * @returns {Map<string, string>} The CLI version that each platform printed.
 */
export function smokeTestImage({ image, platforms, checkout, head, docker }) {
  const versions = new Map();
  for (const platform of platforms) {
    const run = ["run", "--rm", "--platform", platform];
    const version = docker([...run, image, "--version"]).trim();
    if (!version) {
      throw new Error(`${platform}: sentry --version printed nothing`);
    }
    const mountedHead = docker([
      ...run,
      "--volume",
      `${checkout}:/work`,
      "--entrypoint",
      "git",
      image,
      "rev-parse",
      "HEAD",
    ]).trim();
    if (mountedHead !== head) {
      throw new Error(
        `${platform}: git in /work read ${mountedHead}, expected ${head}`,
      );
    }
    versions.set(platform, version);
  }
  return versions;
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [image, platforms] = process.argv.slice(2);
  if (!image || !platforms) {
    throw new Error(
      "Usage: node scripts/cli-docker-smoke-test.mjs <image> <platform>[,<platform>...]",
    );
  }
  const versions = smokeTestImage({
    image,
    platforms: platforms.split(","),
    checkout: process.cwd(),
    head: execFileSync("git", ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim(),
    docker: (args) =>
      execFileSync("docker", args, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "inherit"],
      }),
  });
  for (const [platform, version] of versions) {
    console.log(`${platform}: sentry ${version}; git reads /work`);
  }
}
