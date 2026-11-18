/** Tests for telling whether the terminal already sent a Ctrl-C to a child. */

import { spawn } from "node:child_process";
import { describe, expect, test } from "vitest";
import {
  isForegroundStat,
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
