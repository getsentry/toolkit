import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addProperties,
  patchPubspec,
} from "../../../../src/lib/wizard/flutter/code-tools.js";
import { pubspecOptions } from "../../../../src/lib/wizard/flutter/templates.js";
import { reportCliError } from "../../../../src/lib/error-reporting.js";

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));

describe("pubspec.yaml and sentry.properties", () => {
  let tmpDir: string;
  let pubspecFile: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tmpDir = mkdtempSync(path.join(tmpdir(), "flutter-pubspec-test-"));
    pubspecFile = path.join(tmpDir, "pubspec.yaml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    vi.restoreAllMocks();
  });

  describe("patchPubspec", () => {
    it("adds the packages and plugin options and keeps the user's formatting", () => {
      writeFileSync(
        pubspecFile,
        `name: flutter_example # the app
version: 1.0.0

dependencies:
  flutter:
    sdk: flutter
  # keep this comment
  http: "^1.0.0"

dev_dependencies:
  flutter_lints: ^2.0.0

flutter:
  uses-material-design: true
`,
      );

      expect(
        patchPubspec(pubspecFile, "^9.0.0", "^3.0.0", "my-app", "my-org"),
      ).toBe(true);

      expect(readFileSync(pubspecFile, "utf8"))
        .toBe(`name: flutter_example # the app
version: 1.0.0

dependencies:
  sentry_flutter: ^9.0.0
  flutter:
    sdk: flutter
  # keep this comment
  http: "^1.0.0"

dev_dependencies:
  sentry_dart_plugin: ^3.0.0
  flutter_lints: ^2.0.0

flutter:
  uses-material-design: true

sentry:
  upload_debug_symbols: true
  upload_source_maps: true
  project: my-app
  org: my-org
`);
    });

    it("changes nothing that is already there", () => {
      const original = `dependencies:
  sentry_flutter: ^8.0.0

dev_dependencies:
  sentry_dart_plugin: ^2.0.0

sentry:
  project: other
`;
      writeFileSync(pubspecFile, original);

      expect(patchPubspec(pubspecFile, "any", "any", "my-app", "my-org")).toBe(
        true,
      );
      expect(readFileSync(pubspecFile, "utf8")).toBe(original);
    });

    it("adds a dev_dependencies section when there is none", () => {
      writeFileSync(
        pubspecFile,
        "name: flutter_example\n\ndependencies:\n  flutter:\n    sdk: flutter\n",
      );

      expect(
        patchPubspec(pubspecFile, "^9.0.0", "^3.0.0", "my-app", "my-org"),
      ).toBe(true);

      expect(readFileSync(pubspecFile, "utf8")).toBe(
        "name: flutter_example\n\ndependencies:\n  sentry_flutter: ^9.0.0\n  flutter:\n    sdk: flutter\n\ndev_dependencies:\n  sentry_dart_plugin: ^3.0.0\n\n" +
          pubspecOptions("my-app", "my-org"),
      );
    });

    it("adds the plugin options when a dependency is named sentry", () => {
      writeFileSync(
        pubspecFile,
        "name: flutter_example\n\ndependencies:\n  sentry: ^9.0.0\n\ndev_dependencies:\n  flutter_lints: ^2.0.0\n",
      );

      expect(
        patchPubspec(pubspecFile, "^9.0.0", "^3.0.0", "my-app", "my-org"),
      ).toBe(true);

      expect(readFileSync(pubspecFile, "utf8")).toContain(
        pubspecOptions("my-app", "my-org"),
      );
    });

    it("fails without a pubspec.yaml", () => {
      expect(patchPubspec(null, "any", "any", "my-app", "my-org")).toBe(false);
      expect(reportCliError).toHaveBeenCalled();
    });
  });

  describe("addProperties", () => {
    it("writes the auth token and adds sentry.properties to .gitignore", () => {
      writeFileSync(path.join(tmpDir, ".gitignore"), "build/");

      expect(addProperties(pubspecFile, "sntrys_token")).toBe(true);

      expect(readFileSync(path.join(tmpDir, "sentry.properties"), "utf8")).toBe(
        "auth_token=sntrys_token",
      );
      expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf8")).toBe(
        "build/\nsentry.properties\n",
      );
    });

    it("creates .gitignore when there is none", () => {
      addProperties(pubspecFile, "sntrys_token");

      expect(readFileSync(path.join(tmpDir, ".gitignore"), "utf8")).toBe(
        "sentry.properties\n",
      );
    });

    it("fails without a pubspec.yaml", () => {
      expect(addProperties(null, "sntrys_token")).toBe(false);
      expect(existsSync(path.join(tmpDir, "sentry.properties"))).toBe(false);
    });
  });
});
