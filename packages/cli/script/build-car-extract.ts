/** Build the legacy CoreUI parser as the darwin-arm64 SEA helper. */
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Resolve from this module, never the caller's current working directory. */
const NATIVE_SCRIPTS_DIR = fileURLToPath(
  new URL("../native/car-extract/", import.meta.url),
);

/**
 * Compile the helper on macOS. A requested native build must fail if the
 * toolchain or parser fails; silently omitting it would ship a broken feature.
 */
export function buildCarExtract(): string {
  if (process.platform !== "darwin" || process.arch !== "arm64") {
    throw new Error("The asset-catalog helper must be built on macOS arm64");
  }
  const args = [
    "build",
    "--configuration",
    "release",
    "--package-path",
    NATIVE_SCRIPTS_DIR,
    "--triple",
    "arm64-apple-macosx13.0",
    "--product",
    "car-extract",
  ];
  execFileSync("swift", args, { stdio: "inherit" });
  const binDirectory = execFileSync("swift", [...args, "--show-bin-path"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  }).trim();
  return join(binDirectory, "car-extract");
}
