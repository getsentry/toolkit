import fs from "node:fs";
import { addVitePluginToConfig } from "../../../../../src/lib/wizard/sourcemaps/tools/vite.js";

import { vi, it, describe, expect, afterEach } from "vitest";

function updateFileContent(content: string): void {
  fileContent = content;
}

let fileContent = "";

vi.mock("@clack/prompts", () => {
  return {
    log: {
      info: vi.fn(),
      success: vi.fn(),
    },
  };
});

vi.spyOn(fs.promises, "readFile").mockImplementation(() =>
  Promise.resolve(fileContent),
);

const writeFileSpy = vi
  .spyOn(fs.promises, "writeFile")
  .mockImplementation(() => Promise.resolve(void 0));

describe("addVitePluginToConfig", () => {
  afterEach(() => {
    fileContent = "";
    vi.clearAllMocks();
  });

  it.each([
    [
      "no build options",
      `
export default defineConfig({
  plugins: [
    vue(),
  ],
})
`,
      `import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
export default defineConfig({
  plugins: [vue(), sentryVitePlugin({
    org: "my-org",
    project: "my-project"
  })],

  build: {
    sourcemap: true
  }
})
`,
    ],
    [
      "no build.sourcemap options",
      `
export default defineConfig({
  plugins: [
    vue(),
  ],
  build: {
    test: 1,
  }
})
`,
      `import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
export default defineConfig({
  plugins: [vue(), sentryVitePlugin({
    org: "my-org",
    project: "my-project"
  })],
  build: {
    test: 1,
    sourcemap: true
  }
})
`,
    ],
    [
      'keep sourcemap: "hidden"',
      `
export default {
  plugins: [
    vue(),
  ],
  build: {
    sourcemap: "hidden",
  }
}
`,
      `import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
export default {
  plugins: [vue(), sentryVitePlugin({
    org: "my-org",
    project: "my-project"
  })],
  build: {
    sourcemap: "hidden",
  }
}
`,
    ],
    [
      "rewrite sourcemap: false to true",
      `
const cfg = {
  plugins: [
    vue(),
  ],
  build: {
    sourcemap: false,
  }
}

export default cfg;
`,
      `import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
const cfg = {
  plugins: [vue(), sentryVitePlugin({
    org: "my-org",
    project: "my-project"
  })],

  build: {
    sourcemap: true,
  }
}

export default cfg;
`,
    ],
  ])(
    "adds the plugin and enables source maps generation (%s)",
    async (_, originalCode, expectedCode) => {
      updateFileContent(originalCode);

      const addedCode = await addVitePluginToConfig(
        "",
        {
          authToken: "",
          orgSlug: "my-org",
          projectSlug: "my-project",
          selfHosted: false,
          url: "https://sentry.io/",
        },
        "@sentry/bundler-plugins/vite",
      );

      expect(writeFileSpy).toHaveBeenCalledTimes(1);
      const fileContent = writeFileSpy.mock.calls[0]?.[1];
      expect(fileContent).toBe(expectedCode);
      expect(addedCode).toBe(true);
    },
  );

  it("recognizes quoted build and sourcemap keys", async () => {
    updateFileContent(`
export default defineConfig({
  plugins: [vue()],
  "build": {
    outDir: "out",
    "sourcemap": "hidden",
  },
})
`);

    const addedCode = await addVitePluginToConfig(
      "",
      {
        authToken: "",
        orgSlug: "my-org",
        projectSlug: "my-project",
        selfHosted: false,
        url: "https://sentry.io/",
      },
      "@sentry/bundler-plugins/vite",
    );

    expect(addedCode).toBe(true);
    const written = writeFileSpy.mock.calls[0]?.[1];
    if (typeof written !== "string") {
      throw new Error("expected the config to be written as a string");
    }
    expect(written.match(/build/g)).toHaveLength(1);
    expect(written).toContain('outDir: "out"');
    expect(written).toContain('"sourcemap": "hidden"');
    expect(written).not.toContain("sourcemap: true");
  });
});
