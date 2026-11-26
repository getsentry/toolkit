import { text } from "@clack/prompts";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createExampleComponent,
  getSentryExampleComponentCode,
} from "../../../../src/lib/wizard/angular/example-component.js";

// oxlint-disable-next-line sentry-cli/no-namespace-import -- needed for spyOn mocking
import * as clackUtils from "../../../../src/lib/wizard/utils/clack/index.js";

const fsMocks = vi.hoisted(() => ({
  existsSyncMock: vi.fn(() => true),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
}));

vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  existsSync: fsMocks.existsSyncMock,
  writeFileSync: fsMocks.writeFileSyncMock,
  mkdirSync: fsMocks.mkdirSyncMock,
}));

vi.mock("@clack/prompts", () => ({
  log: {
    info: vi.fn(),
    success: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    step: vi.fn(),
  },
  outro: vi.fn(),
  text: vi.fn(),
  confirm: vi.fn(),
  cancel: vi.fn(),
  // passthrough for abortIfCancelled
  isCancel: vi.fn().mockReturnValue(false),
  spinner: vi
    .fn()
    .mockImplementation(() => ({ start: vi.fn(), stop: vi.fn() })),
  select: vi.fn(),
}));

describe("createExampleComponent", () => {
  const showCopyPasteSnippetSpy = vi.spyOn(
    clackUtils,
    "showCopyPasteInstructions",
  );

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("rejects an empty path when ./src/app is missing", async () => {
    fsMocks.existsSyncMock.mockReturnValue(false);
    vi.mocked(text).mockResolvedValueOnce("custom/app");

    await createExampleComponent({
      url: "https://sentry.io",
      orgSlug: "myOrg",
      projectId: "123456789",
    });
    fsMocks.existsSyncMock.mockReturnValue(true);

    const validate = vi.mocked(text).mock.calls[0]?.[0].validate;
    expect(validate?.("")).toBe("Please enter a path.");
    expect(validate?.("custom/app")).toBeUndefined();
    expect(fsMocks.mkdirSyncMock).toHaveBeenCalledWith("custom/app", {
      recursive: true,
    });
  });

  it("creates an example component file", async () => {
    const options = {
      url: "https://sentry.io",
      orgSlug: "myOrg",
      projectId: "123456789",
    };

    // Mock the abortIfCancelled function to return the appRootPath
    vi.spyOn(clackUtils, "abortIfCancelled").mockResolvedValue("src/app");

    // Mock the getSentryExampleComponentCode function
    const exampleComponentCode = getSentryExampleComponentCode(options);

    // Call the function to create the example component
    await createExampleComponent(options);

    expect(fsMocks.writeFileSyncMock).toHaveBeenCalledWith(
      "./src/app/sentry-example.component.ts",
      exampleComponentCode,
    );
    expect(showCopyPasteSnippetSpy).toHaveBeenCalledWith({
      codeSnippet: `import { SentryExample } from './sentry-example.component'

@Component({
  selector: 'app-root',
  standalone: true,
  imports: [RouterOutlet, SentryExample],
  template: \`
    <div class="app">
      <h1>Your Application</h1>
      <app-sentry-example></app-sentry-example>
    </div>
  \`,
})
`,
      instructions:
        "Add the example component one of your pages or components (for example, in app.component.ts).",
    });
  });
});

describe("getSentryExampleComponentCode", () => {
  it("includes the correct issue stream URL", () => {
    const exampleComponentCode = getSentryExampleComponentCode({
      orgSlug: "myOrg",
      projectId: "123456789",
      url: "https://sentry.io",
    });
    expect(exampleComponentCode).toContain(
      "https://myorg.sentry.io/issues/?project=123456789",
    );
  });
});
