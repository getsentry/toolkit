/**
 * Smoke tests for the built `dist/sentry-mcp.cjs`. Run `pnpm run bundle` first.
 */
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { builtinModules } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";

const packageRoot = new URL("..", import.meta.url).pathname;
const bin = join(packageRoot, "dist/sentry-mcp.cjs");
const manifest = JSON.parse(
  readFileSync(join(packageRoot, "package.json"), "utf-8"),
);
const { version } = manifest;

const configDir = mkdtempSync(join(tmpdir(), "sentry-mcp-test-"));
after(() => rmSync(configDir, { recursive: true, force: true }));

const env = {
  PATH: process.env.PATH,
  SENTRY_CONFIG_DIR: configDir,
  SENTRY_CLI_NO_TELEMETRY: "1",
};

function run(args, extraEnv = {}) {
  return spawnSync(process.execPath, [bin, ...args], {
    encoding: "utf-8",
    env: { ...env, ...extraEnv },
    timeout: 30_000,
  });
}

test("the package has no runtime dependencies", () => {
  assert.deepEqual(manifest.dependencies ?? {}, {});
  assert.deepEqual(manifest.files, ["dist/sentry-mcp.cjs"]);
});

test("the bundle requires only Node.js built-ins", () => {
  const builtins = new Set(builtinModules);
  // Skip `require(...)` inside string literals: ajv generates code with them.
  const required = [
    ...readFileSync(bin, "utf-8").matchAll(
      /(?<![`'\w$.])require\("([^"]+)"\)/g,
    ),
  ].map(([, id]) => id);
  const external = required.filter(
    (id) => !(id.startsWith("node:") || builtins.has(id.split("/")[0])),
  );
  assert.deepEqual([...new Set(external)], []);
});

for (const flag of ["--version", "-v"]) {
  test(`${flag} prints the package version`, () => {
    const result = run([flag]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stdout.trim(), version);
  });
}

test("--help lists only mcp, auth, and help", () => {
  const result = run(["--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^USAGE\n {2}sentry-mcp mcp /);
  const commands = result.stdout.split("COMMANDS\n")[1] ?? "";
  assert.deepEqual(
    commands
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/)[0]),
    ["mcp", "auth", "help"],
  );
});

test("mcp --help examples name this binary", () => {
  const result = run(["mcp", "--help"]);
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^ {2}sentry-mcp mcp --all-skills /m);
  assert.doesNotMatch(result.stdout, /^ {2}sentry mcp/m);
});

test("a client closing stdout early is a clean exit, not a crash", async () => {
  const child = spawn(process.execPath, [bin, "--help"], {
    stdio: ["ignore", "pipe", "pipe"],
    env,
  });
  child.stdout.destroy();
  const chunks = [];
  child.stderr.on("data", (chunk) => chunks.push(chunk));
  const code = await new Promise((resolve) => child.on("exit", resolve));
  const stderr = Buffer.concat(chunks).toString();
  assert.equal(code, 0, stderr);
  assert.doesNotMatch(stderr, /EPIPE/);
});

test("without credentials, points to its own auth login", () => {
  const result = run([]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /'sentry-mcp auth login'/);
});

test("under npx, the login hint goes through npx", () => {
  const result = run([], { npm_command: "exec" });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /'npx -y @sentry\/mcp-server auth login'/);
});

test("runs the CLI's auth commands", () => {
  const result = run(["auth", "status"]);
  assert.notEqual(result.status, 0);
  assert.match(
    result.stderr,
    /Not authenticated\. Run 'sentry-mcp auth login'/,
  );
});

test("rejects the CLI's other commands", () => {
  const result = run(["issue", "list"]);
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /issue/);
});

/**
 * Start the server, run initialize + tools/list, and close stdin. Resolves
 * with the two responses and everything the server wrote to stderr.
 *
 * With `deletedCwd`, the server starts in a directory removed just before
 * `exec`, so `process.cwd()` throws. The shell still exports `PWD`, as an
 * interactive shell would.
 */
async function serveStdio(args, extraEnv, { deletedCwd } = {}) {
  const node = [process.execPath, bin, ...args];
  const [command, ...commandArgs] = deletedCwd
    ? [
        "/bin/sh",
        "-c",
        'cd "$0" && rmdir "$0" && exec "$@"',
        deletedCwd,
        ...node,
      ]
    : node;
  const child = spawn(command, commandArgs, {
    env: { ...env, ...extraEnv },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const byId = new Map();
  let buffer = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const responses = new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) =>
      reject(
        new Error(`server exited (${code}) before responding:\n${stderr}`),
      ),
    );
    child.stdout.on("data", (chunk) => {
      buffer += chunk;
      const parts = buffer.split("\n");
      buffer = parts.pop() ?? "";
      // Every stdout line must be a JSON-RPC frame.
      for (const message of parts
        .filter(Boolean)
        .map((line) => JSON.parse(line))) {
        if (message.id !== undefined) {
          byId.set(message.id, message);
        }
      }
      if (byId.has(1) && byId.has(2)) {
        resolve([byId.get(1), byId.get(2)]);
      }
    });
    setTimeout(() => reject(new Error("no MCP response")), 20_000).unref();
  });

  const send = (message) =>
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  send({
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "bundle-test", version: "1.0.0" },
    },
  });
  send({ method: "notifications/initialized" });
  send({ id: 2, method: "tools/list" });

  try {
    const [initialize, toolsList] = await responses;
    assert.equal(initialize.id, 1);
    assert.ok(initialize.result?.serverInfo, JSON.stringify(initialize));
    assert.equal(toolsList.id, 2);
    assert.ok(toolsList.result?.tools.length > 0, JSON.stringify(toolsList));
    // The server exits once the client closes stdin. A leftover timer, such
    // as a second Sentry client's runtime metrics, would keep it alive.
    const exited = new Promise((resolve, reject) => {
      child.on("exit", resolve);
      setTimeout(
        () => reject(new Error("server did not exit after stdin closed")),
        15_000,
      ).unref();
    });
    child.stdin.end();
    assert.equal(await exited, 0);
    return { stderr };
  } finally {
    child.kill();
  }
}

test("serves MCP over stdio with SENTRY_AUTH_TOKEN", async () => {
  // `--sentry-dsn=` (no telemetry) is a form MCP configs have always used.
  // Without a stored login, the env token needs no SENTRY_FORCE_ENV_TOKEN.
  const { stderr } = await serveStdio(["--sentry-dsn="], {
    SENTRY_AUTH_TOKEN: "sntryu_test",
  });
  assert.doesNotMatch(stderr, /deprecated/);
});

test("serves the deprecated --access-token with a hint on stderr", async () => {
  const token = "sntryu_deprecated_flag_secret";
  const { stderr } = await serveStdio(
    [`--access-token=${token}`, "--sentry-dsn="],
    {},
  );
  assert.match(
    stderr,
    /--access-token is deprecated; set SENTRY_AUTH_TOKEN \(and SENTRY_FORCE_ENV_TOKEN=1 to override a stored login\) instead\./,
  );
  assert.equal(stderr.match(/is deprecated/g)?.length, 1);
  assert.ok(!stderr.includes(token), "the hint must not echo the token");
});

test(
  "serves MCP from a deleted working directory",
  { skip: process.platform === "win32" && "needs a POSIX shell" },
  async () => {
    await serveStdio(
      [],
      { SENTRY_AUTH_TOKEN: "sntryu_test" },
      { deletedCwd: mkdtempSync(join(tmpdir(), "sentry-mcp-cwd-")) },
    );
  },
);

test("exits after the client disconnects with telemetry on", async () => {
  // An explicit DSN turns on the server's telemetry despite the CLI opt-out.
  // Nothing listens on port 9, so no event leaves the machine.
  await serveStdio(["--sentry-dsn=http://public@127.0.0.1:9/1"], {
    SENTRY_AUTH_TOKEN: "sntryu_test",
  });
});
