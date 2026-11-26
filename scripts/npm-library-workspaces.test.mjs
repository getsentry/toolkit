import assert from "node:assert/strict";
import test from "node:test";
import { libraryMatrix } from "./npm-library-workspaces.mjs";

const configs = {
  "packages/cli": { artifactProvider: { name: "github" } },
  "packages/http": {},
  "packages/logger": {},
};

test("lists workspaces that use the default artifact provider", () => {
  assert.deepEqual(
    libraryMatrix(Object.keys(configs), (workspace) => configs[workspace]),
    {
      include: [
        { workspace: "packages/http", name: "http" },
        { workspace: "packages/logger", name: "logger" },
      ],
    },
  );
});

test("fails when there is nothing to pack", () => {
  assert.throws(() =>
    libraryMatrix(["packages/cli"], () => configs["packages/cli"]),
  );
});
