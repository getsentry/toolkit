import { spawn } from "node:child_process";

const pnpm = process.platform === "win32" ? "pnpm.cmd" : "pnpm";
const child = spawn(pnpm, ["run", "bundle"], {
  env: {
    ...process.env,
    SENTRY_CLIENT_ID: process.env.SENTRY_CLIENT_ID ?? "test-client-id",
  },
  stdio: "inherit",
});

const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});

if (exitCode !== 0) {
  process.exitCode = exitCode;
}
