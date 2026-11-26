// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clack from "@clack/prompts";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as fs from "node:fs";
// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { loadSentryCliRc } from "../../../../src/lib/sentryclirc.js";
import { configureSentryCLI } from "../../../../src/lib/wizard/apple/configure-sentry-cli.js";

vi.mock("@clack/prompts", async () => ({
  ...(await vi.importActual<typeof clack>("@clack/prompts")),
}));

describe("configureSentryCLI", () => {
  const authToken = "test";
  const orgSlug = "test-org";
  const projectSlug = "test-project";
  let projectDir: string;
  let rcPath: string;
  let gitignorePath: string;

  beforeEach(() => {
    beforeEach(() => {
      vi.spyOn(clack.log, "warn").mockImplementation(() => {
        /* empty */
      });
      vi.spyOn(clack, "select").mockResolvedValue(undefined);
    });

    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "project"));
    fs.mkdirSync(projectDir, { recursive: true });

    rcPath = path.join(projectDir, ".sentryclirc");
    gitignorePath = path.join(projectDir, ".gitignore");
  });

  describe(".sentryclirc file not exists", () => {
    it("should create the .sentryclirc file", () => {
      // -- Arrange --
      // Pre-condition is that the .sentryclirc file does not exist
      expect(fs.existsSync(rcPath)).toBe(false);

      // -- Act --
      configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

      // -- Assert --
      expect(fs.existsSync(rcPath)).toBe(true);
      expect(fs.readFileSync(rcPath, "utf8")).toContain(`token=test`);
    });

    it("writes the org and project that sentry reads from [defaults]", async () => {
      // -- Act --
      configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

      // -- Assert --
      const config = await loadSentryCliRc(projectDir);
      expect(config).toMatchObject({
        org: orgSlug,
        project: projectSlug,
        token: authToken,
      });
    });
  });

  describe(".sentryclirc file exists", () => {
    it("should update the .sentryclirc file", () => {
      // -- Arrange --
      // Pre-condition is that the .sentryclirc file exists
      fs.writeFileSync(rcPath, `token=old`);

      // -- Act --
      configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

      // -- Assert --
      expect(fs.readFileSync(rcPath, "utf8")).toContain(`token=${authToken}`);
    });
  });

  describe(".gitignore file not exists", () => {
    it("should create the .gitignore file", () => {
      // -- Arrange --
      // Pre-condition is that the .gitignore file does not exist
      expect(fs.existsSync(gitignorePath)).toBe(false);

      // -- Act --
      configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

      // -- Assert --
      expect(fs.existsSync(gitignorePath)).toBe(true);
      expect(fs.readFileSync(gitignorePath, "utf8")).toContain(".sentryclirc");
    });
  });

  describe(".gitignore file exists", () => {
    describe("contains '.sentryclirc'", () => {
      it("should not append the .sentryclirc file to the .gitignore file", () => {
        // -- Arrange --
        // Pre-condition is that the .gitignore file exists and contains '.sentryclirc'
        fs.writeFileSync(
          gitignorePath,
          `
# Xcode
xcuserdata/

# Sentry
.sentryclirc
`,
        );

        // -- Act --
        configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

        // -- Assert --
        expect(fs.readFileSync(gitignorePath, "utf8")).toContain(
          ".sentryclirc",
        );
      });
    });

    describe("does not contain '.sentryclirc'", () => {
      it("should append the .sentryclirc file to the .gitignore file", () => {
        // -- Arrange --
        // Pre-condition is that the .gitignore file exists and does not contain '.sentryclirc'
        fs.writeFileSync(
          gitignorePath,
          `
# Xcode
xcuserdata/
`,
        );

        // -- Act --
        configureSentryCLI({ projectDir, authToken, orgSlug, projectSlug });

        // -- Assert --
        expect(fs.readFileSync(gitignorePath, "utf8")).toBe(
          `
# Xcode
xcuserdata/

.sentryclirc
`,
        );
      });
    });
  });
});
