/** Tests for signalling a wrapped app and telling whether the terminal already did. */

import { spawn } from "node:child_process";
import { describe, expect, test, vi } from "vitest";
import {
  appIsRunning,
  isForegroundStat,
  signalApp,
  startsOwnProcessGroup,
  terminalSignalsProcess,
} from "../../src/lib/child-signals.js";
import { whichSync } from "../../src/lib/which.js";

describe("isForegroundStat", () => {
  test("is true when the process group is the terminal's foreground group", () => {
    expect(
      isForegroundStat("4242 (python3) S 4200 4242 4100 34817 4242 0"),
    ).toBe(true);
  });

  test("is false for a background job or a process with no terminal", () => {
    expect(isForegroundStat("4242 (sleep) S 4200 4242 4100 34817 4300 0")).toBe(
      false,
    );
    expect(isForegroundStat("4242 (sleep) S 4200 4242 4242 0 -1 0")).toBe(
      false,
    );
  });

  test("reads the fields after a command name holding spaces and parens", () => {
    expect(isForegroundStat("4242 (a b) (c)) S 1 4242 4100 34817 4242 0")).toBe(
      true,
    );
  });
});

describe("terminalSignalsProcess", () => {
  test("is false for a child with no controlling terminal", async () => {
    const child = spawn(
      process.execPath,
      ["-e", "setTimeout(() => {}, 5000)"],
      {
        detached: process.platform !== "win32",
        stdio: "ignore",
      },
    );
    try {
      expect(terminalSignalsProcess(child.pid)).toBe(false);
    } finally {
      child.kill("SIGKILL");
    }
  });

  test("is false on Windows and for a failed spawn", () => {
    expect(terminalSignalsProcess(process.pid, "win32")).toBe(false);
    expect(terminalSignalsProcess(undefined)).toBe(false);
  });

  test.skipIf(process.platform !== "linux" || !whichSync("script"))(
    "is true for the foreground job of a real terminal",
    async () => {
      // util-linux `script` runs the command as the foreground job of a new
      // pty; the shell prints its pid and then becomes `sleep`.
      const child = spawn(
        "script",
        ["-qec", "echo pid=$$; exec sleep 5", "/dev/null"],
        { stdio: ["ignore", "pipe", "ignore"] },
      );
      try {
        const pid = await new Promise<number>((resolve, reject) => {
          let out = "";
          child.stdout.on("data", (chunk: Buffer) => {
            out += chunk.toString();
            const match = /pid=(\d+)/.exec(out);
            if (match) resolve(Number(match[1]));
          });
          child.once("error", reject);
        });
        expect(terminalSignalsProcess(pid)).toBe(true);
      } finally {
        child.kill("SIGKILL");
      }
    },
  );
});

describe("startsOwnProcessGroup", () => {
  test("is false on Windows, which has no process groups", () => {
    expect(startsOwnProcessGroup("win32")).toBe(false);
  });
});

describe("signalApp", () => {
  test("signals only the app when it has no group of its own", () => {
    const child = { pid: 4242, kill: vi.fn() };
    signalApp(child as never, "SIGTERM", false);
    expect(child.kill).toHaveBeenCalledWith("SIGTERM");
  });

  test("never signals a group for a missing pid or pid 1", () => {
    for (const pid of [undefined, 0, 1]) {
      const child = { pid, kill: vi.fn() };
      signalApp(child as never, "SIGTERM", true);
      expect(child.kill).toHaveBeenCalledWith("SIGTERM");
    }
  });

  test.skipIf(process.platform === "win32")(
    "reaches a grandchild in the app's own group",
    async () => {
      // The app starts a grandchild, prints its pid, and ignores SIGTERM
      // itself, so only the group signal can stop the grandchild.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.on("SIGTERM", () => {});
const g = require("node:child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
console.log(g.pid);
setInterval(() => {}, 1000);`,
        ],
        { detached: true, stdio: ["ignore", "pipe", "ignore"] },
      );
      const pid = child.pid ?? 0;
      try {
        const grandchild = await new Promise<number>((resolve) => {
          child.stdout.once("data", (chunk: Buffer) =>
            resolve(Number(chunk.toString().trim())),
          );
        });
        expect(appIsRunning(pid)).toBe(true);
        signalApp(child, "SIGTERM", true);
        await vi.waitFor(() => {
          expect(() => process.kill(grandchild, 0)).toThrow();
        });
        expect(appIsRunning(pid)).toBe(true);
        signalApp(child, "SIGKILL", true);
        await vi.waitFor(() => {
          expect(appIsRunning(pid)).toBe(false);
        });
      } finally {
        if (appIsRunning(pid)) {
          process.kill(-pid, "SIGKILL");
        }
      }
    },
  );
});

describe("appIsRunning", () => {
  test("is false for pid 0 and 1, which are not an app's group", () => {
    expect(appIsRunning(0)).toBe(false);
    expect(appIsRunning(1)).toBe(false);
  });
});
