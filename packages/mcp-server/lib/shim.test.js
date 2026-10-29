import assert from "node:assert/strict";
import { join } from "node:path";
import { describe, it } from "node:test";
import { resolveSentryBin, toSentryArgs } from "./shim.js";

describe("toSentryArgs", () => {
  it("forwards server flags to `sentry mcp` unchanged", () => {
    assert.deepEqual(
      toSentryArgs(["--access-token=TOKEN", "--host", "sentry.example.com"]),
      ["mcp", "--access-token=TOKEN", "--host", "sentry.example.com"],
    );
    assert.deepEqual(toSentryArgs([]), ["mcp"]);
  });

  it("maps the old auth subcommands to `sentry auth`", () => {
    assert.deepEqual(toSentryArgs(["auth", "login"]), ["auth", "login"]);
    assert.deepEqual(toSentryArgs(["auth", "logout"]), ["auth", "logout"]);
    assert.deepEqual(toSentryArgs(["auth", "status"]), ["auth", "status"]);
  });

  it("treats bare `auth` as `auth login`", () => {
    assert.deepEqual(toSentryArgs(["auth"]), ["auth", "login"]);
  });
});

describe("resolveSentryBin", () => {
  it("uses the bin script next to the sentry package entry", () => {
    const entry = join("/deps", "sentry", "dist", "index.cjs");
    assert.equal(
      resolveSentryBin((id) => {
        assert.equal(id, "sentry");
        return entry;
      }),
      join("/deps", "sentry", "dist", "bin.cjs"),
    );
  });
});
