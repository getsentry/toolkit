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

vi.mock("@clack/prompts", () => ({
  log: { info: vi.fn(), warn: vi.fn(), success: vi.fn() },
}));

import { createExamplePage } from "../../../../src/lib/wizard/react-router/sdk-example.js";

describe("createExamplePage", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "react-router-example-test-"));
    mkdirSync(path.join(tmpDir, "app"), { recursive: true });
    vi.spyOn(process, "cwd").mockReturnValue(tmpDir);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("registers the example routes in a JavaScript app/routes.js", async () => {
    const routesConfigPath = path.join(tmpDir, "app", "routes.js");
    writeFileSync(
      routesConfigPath,
      `import { index } from "@react-router/dev/routes";

export default [index("routes/home.jsx")];
`,
    );

    await createExamplePage({
      selfHosted: false,
      orgSlug: "org",
      projectId: "1",
      url: "https://sentry.io/",
      isTS: false,
      projectDir: tmpDir,
    });

    const updated = readFileSync(routesConfigPath, "utf-8");
    expect(updated).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.jsx")',
    );
    expect(updated).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.js")',
    );
  });
});
