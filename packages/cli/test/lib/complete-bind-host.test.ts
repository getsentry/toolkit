/**
 * The `--host` a Local server binds completes from this machine's network
 * adapters, so `node:os` is mocked with a known set of interfaces.
 */

import type { NetworkInterfaceInfo } from "node:os";
import { describe, expect, test, vi } from "vitest";

function adapter(
  address: string,
  family: "IPv4" | "IPv6",
  internal = false,
): NetworkInterfaceInfo {
  return {
    address,
    family,
    internal,
    netmask: "",
    mac: "",
    cidr: null,
    ...(family === "IPv6" ? { scopeid: 0 } : {}),
  } as NetworkInterfaceInfo;
}

vi.mock("node:os", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:os")>()),
  networkInterfaces: () => ({
    lo: [adapter("127.0.0.1", "IPv4", true), adapter("::1", "IPv6", true)],
    en0: [
      adapter("192.168.1.20", "IPv4"),
      adapter("fe80::1", "IPv6"),
      adapter("2001:db8::20", "IPv6"),
    ],
  }),
}));

import { getCompletions } from "../../src/lib/complete.js";
import { useTestConfigDir } from "../helpers.js";

useTestConfigDir("test-complete-bind-host-");

describe("getCompletions: Local bind hosts", () => {
  test("loopback hosts first, then every interface and each adapter", async () => {
    expect(await getCompletions(["local", "serve", "--host"], "")).toEqual([
      { value: "localhost", description: "loopback" },
      { value: "127.0.0.1", description: "loopback" },
      { value: "::1", description: "loopback" },
      { value: "0.0.0.0", description: "every IPv4 interface" },
      { value: "192.168.1.20", description: "en0 (IPv4)" },
      { value: "2001:db8::20", description: "en0 (IPv6)" },
    ]);
    expect(
      (await getCompletions(["local", "run", "--host"], "192")).map(
        (c) => c.value,
      ),
    ).toEqual(["192.168.1.20"]);
  });

  test("the daemon's loopback-only --host keeps to loopback hosts", async () => {
    expect(
      (await getCompletions(["local", "daemon", "start", "--host"], "")).map(
        (c) => c.value,
      ),
    ).toEqual(["localhost", "127.0.0.1", "::1"]);
  });
});
