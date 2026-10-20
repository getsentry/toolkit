import { afterEach, describe, expect, test, vi } from "vitest";
import { buildLocalDaemonArgs } from "../../../src/commands/local/daemon.js";

const runtime = vi.hoisted(() => ({ sea: false }));
vi.mock("../../../src/lib/react-native/wrap-call.js", () => ({
  isSea: () => runtime.sea,
}));
afterEach(() => {
  runtime.sea = false;
  vi.unstubAllGlobals();
});

describe("Local daemon invocation", () => {
  test("re-executes a native CLI without adding a script or Node flags", () => {
    runtime.sea = true;
    vi.stubGlobal("process", {
      ...process,
      argv: ["/sentry", "local", "session", "create"],
      execArgv: ["--experimental-sea-config"],
    });
    expect(buildLocalDaemonArgs("127.0.0.1", 9000)).toEqual([
      "local",
      "daemon",
      "start",
      "--foreground",
      "--host",
      "127.0.0.1",
      "--port",
      "9000",
    ]);
  });
  test("preserves the Node script and loader flags for source and npm builds", () => {
    vi.stubGlobal("process", {
      ...process,
      argv: ["/node", "/cli/bin.cjs", "local"],
      execArgv: ["--import", "tsx"],
    });
    expect(buildLocalDaemonArgs("localhost", 9000)).toEqual([
      "--import",
      "tsx",
      "/cli/bin.cjs",
      "local",
      "daemon",
      "start",
      "--foreground",
      "--host",
      "localhost",
      "--port",
      "9000",
    ]);
  });
});
