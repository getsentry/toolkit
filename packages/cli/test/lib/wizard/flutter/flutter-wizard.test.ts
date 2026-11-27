import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runFlutterWizard } from "../../../../src/lib/wizard/flutter/flutter-wizard.js";
import { reportCliError } from "../../../../src/lib/error-reporting.js";
import { WizardExitError } from "../../../../src/lib/errors.js";
import { showCopyPasteInstructions } from "../../../../src/lib/wizard/utils/clack/index.js";
import type { WizardOptions } from "../../../../src/lib/wizard/utils/types.js";

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/release-registry.js", () => ({
  fetchSdkVersion: vi.fn().mockResolvedValue("9.0.0"),
}));
vi.mock("../../../../src/lib/wizard/utils/clack/mcp-config.js", () => ({
  offerProjectScopedMcpConfig: vi.fn(),
}));
vi.mock("../../../../src/lib/wizard/utils/clack/index.js", async () => ({
  ...(await vi.importActual<object>(
    "../../../../src/lib/wizard/utils/clack/index.js",
  )),
  confirmContinueIfNoOrDirtyGitRepo: vi.fn(),
  showCopyPasteInstructions: vi.fn(),
  featureSelectionPrompt: vi
    .fn()
    .mockResolvedValue({ tracing: true, replay: false }),
  getOrAskForProjectData: vi.fn().mockResolvedValue({
    spotlight: false,
    selfHosted: false,
    sentryUrl: "https://sentry.io/",
    authToken: "sntrys_token",
    selectedProject: {
      id: "1",
      slug: "my-app",
      organization: { id: "1", slug: "my-org", name: "My Org" },
      keys: [{ dsn: { public: "https://key@o1.ingest.sentry.io/1" } }],
    },
  }),
}));

const OPTIONS: WizardOptions = { telemetryEnabled: false };

const PUBSPEC = `name: flutter_example

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_lints: ^2.0.0
`;

describe("runFlutterWizard", () => {
  const originalCwd = process.cwd();
  let projectDir: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    projectDir = mkdtempSync(path.join(tmpdir(), "flutter-wizard-test-"));
    process.chdir(projectDir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(projectDir, { recursive: true });
    vi.mocked(reportCliError).mockClear();
    vi.mocked(showCopyPasteInstructions).mockClear();
    vi.restoreAllMocks();
  });

  function copyPasteFiles(): string[] {
    return vi
      .mocked(showCopyPasteInstructions)
      .mock.calls.map(([opts]) => ("filename" in opts ? opts.filename : ""));
  }

  it("exits non-zero without a pubspec.yaml", async () => {
    const error = await runFlutterWizard(OPTIONS).catch(
      (thrown: unknown) => thrown,
    );

    expect(error).toBeInstanceOf(WizardExitError);
    expect((error as WizardExitError).exitCode).not.toBe(0);
    expect(reportCliError).not.toHaveBeenCalled();
  });

  it("shows the main.dart snippet when there is no lib/ directory", async () => {
    writeFileSync(path.join(projectDir, "pubspec.yaml"), PUBSPEC);

    await runFlutterWizard(OPTIONS);

    expect(copyPasteFiles()).toEqual(["main.dart"]);
    expect(reportCliError).not.toHaveBeenCalled();
  });

  it("shows the main.dart snippet and leaves main.dart alone without runApp", async () => {
    writeFileSync(path.join(projectDir, "pubspec.yaml"), PUBSPEC);
    mkdirSync(path.join(projectDir, "lib"));
    const mainFile = path.join(projectDir, "lib", "main.dart");
    const main = "void main() {\n  bootstrap();\n}\n";
    writeFileSync(mainFile, main);

    await runFlutterWizard(OPTIONS);

    expect(copyPasteFiles()).toEqual(["main.dart"]);
    expect(readFileSync(mainFile, "utf8")).toBe(main);
    expect(reportCliError).not.toHaveBeenCalled();
  });
});
