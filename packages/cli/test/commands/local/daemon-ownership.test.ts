import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { useTestConfigDir } from "../../helpers.js";
import { claimDaemonOwnership } from "../../../src/commands/local/daemon.js";

vi.mock("node:fs/promises", async (importOriginal) => {
  const fs = await importOriginal<typeof import("node:fs/promises")>();
  return { ...fs, readFile: vi.fn(fs.readFile), stat: vi.fn(fs.stat) };
});
const getConfigDir = useTestConfigDir("local-owner-race-");
afterEach(() => vi.restoreAllMocks());

describe("Local daemon ownership", () => {
  test.each(["read", "stat"])(
    "retries when ownership disappears during %s",
    async (stage) => {
      const directory = getConfigDir();
      await mkdir(directory, { recursive: true });
      const owner = join(directory, "local-control-plane.owner");
      await writeFile(owner, "");
      const disappear = async () => {
        await rm(owner);
        throw Object.assign(new Error("owner released"), { code: "ENOENT" });
      };
      if (stage === "read")
        vi.mocked(readFile).mockImplementationOnce(disappear);
      else vi.mocked(stat).mockImplementationOnce(disappear);
      const release = await claimDaemonOwnership(directory);
      expect(await readFile(owner, "utf8")).toBe(String(process.pid));
      await release();
    },
  );

  test("preserves a replacement live owner when its old snapshot is dead", async () => {
    const directory = getConfigDir();
    await mkdir(directory, { recursive: true });
    const owner = join(directory, "local-control-plane.owner");
    await writeFile(owner, String(process.pid));
    // A stale reader's old PID arrives after a new owner replaced the file.
    vi.mocked(readFile).mockResolvedValueOnce("42");
    const actualKill = process.kill;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 42)
        throw Object.assign(new Error("exited"), { code: "ESRCH" });
      return actualKill(pid, signal);
    });
    await expect(claimDaemonOwnership(directory)).rejects.toThrow(
      "already running",
    );
    expect(await readFile(owner, "utf8")).toBe(String(process.pid));
  });

  test("serializes another claimant while stale ownership is being reclaimed", async () => {
    const fs =
      await vi.importActual<typeof import("node:fs/promises")>(
        "node:fs/promises",
      );
    const directory = getConfigDir();
    await mkdir(directory, { recursive: true });
    const owner = join(directory, "local-control-plane.owner");
    await writeFile(owner, "42");
    const actualKill = process.kill;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 42)
        throw Object.assign(new Error("exited"), { code: "ESRCH" });
      return actualKill(pid, signal);
    });
    let contender: Promise<() => Promise<void>> | undefined;
    vi.mocked(stat).mockImplementationOnce(async () => {
      expect(
        await fs.readFile(
          join(directory, "local-control-plane.owner.guard"),
          "utf8",
        ),
      ).toBe(String(process.pid));
      contender = claimDaemonOwnership(directory);
      return fs.stat(owner);
    });
    const first = claimDaemonOwnership(directory);
    const firstResult = first.then(
      (release) => ({ release }),
      (error: unknown) => ({ error }),
    );
    await expect.poll(() => contender !== undefined).toBe(true);
    if (!contender) throw new Error("Missing concurrent claimant");
    const results = await Promise.all([
      firstResult,
      contender.then(
        (release) => ({ release }),
        (error: unknown) => ({ error }),
      ),
    ]);
    expect(results.filter((result) => "release" in result)).toHaveLength(1);
    expect(results.filter((result) => "error" in result)).toHaveLength(1);
    expect(await fs.readFile(owner, "utf8")).toBe(String(process.pid));
    for (const result of results)
      if ("release" in result) await result.release();
  });

  test("preserves ownership when a short arbitration guard was interrupted", async () => {
    const directory = getConfigDir();
    await mkdir(directory, { recursive: true });
    const guard = join(directory, "local-control-plane.owner.guard");
    const owner = join(directory, "local-control-plane.owner");
    await writeFile(guard, "42");
    await writeFile(owner, String(process.pid));
    const actualKill = process.kill;
    vi.spyOn(process, "kill").mockImplementation((pid, signal) => {
      if (pid === 42)
        throw Object.assign(new Error("exited"), { code: "ESRCH" });
      return actualKill(pid, signal);
    });
    await expect(claimDaemonOwnership(directory)).rejects.toThrow(
      "arbitration was interrupted",
    );
    expect(await readFile(owner, "utf8")).toBe(String(process.pid));
    expect(await readFile(guard, "utf8")).toBe("42");
  });

  test("propagates an unreadable owner without removing it", async () => {
    const directory = getConfigDir();
    await mkdir(directory, { recursive: true });
    const owner = join(directory, "local-control-plane.owner");
    await writeFile(owner, "42");
    vi.mocked(readFile).mockRejectedValueOnce(
      Object.assign(new Error("denied"), { code: "EACCES" }),
    );
    await expect(claimDaemonOwnership(directory)).rejects.toThrow("denied");
    expect(await readFile(owner, "utf8")).toBe("42");
  });
});
