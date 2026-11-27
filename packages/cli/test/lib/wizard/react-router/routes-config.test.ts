import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { addRoutesToConfig } from "../../../../src/lib/wizard/react-router/codemods/routes-config.js";

vi.mock("@clack/prompts", () => {
  const mock = {
    log: {
      warn: vi.fn(),
      info: vi.fn(),
      success: vi.fn(),
    },
  };
  return {
    default: mock,
    ...mock,
  };
});

describe("addRoutesToConfig codemod", () => {
  let tmpDir: string;
  let appDir: string;
  let routesConfigPath: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create unique tmp directory for each test
    tmpDir = path.join(
      __dirname,
      "tmp",
      `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    appDir = path.join(tmpDir, "app");
    routesConfigPath = path.join(appDir, "routes.ts");

    mkdirSync(appDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should add routes to existing configuration", async () => {
    // Create a routes.ts file
    const routesContent = `import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("/about", "routes/about.tsx"),
] satisfies RouteConfig;`;

    writeFileSync(routesConfigPath, routesContent);

    await addRoutesToConfig(routesConfigPath, true);

    // Check that both routes were added
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.tsx")',
    );
    expect(updatedContent).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.ts")',
    );
  });

  it("should add routes when the default export uses `as RouteConfig`", async () => {
    writeFileSync(
      routesConfigPath,
      `import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [index("routes/home.tsx")] as RouteConfig;`,
    );

    await addRoutesToConfig(routesConfigPath, true);

    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.tsx")',
    );
    expect(updatedContent).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.ts")',
    );
  });

  it("should throw when the default export is not an array literal", async () => {
    const routesContent = `import { flatRoutes } from "@react-router/fs-routes";

export default flatRoutes();`;
    writeFileSync(routesConfigPath, routesContent);

    await expect(addRoutesToConfig(routesConfigPath, true)).rejects.toThrow(
      "not an array literal",
    );
    expect(readFileSync(routesConfigPath, "utf-8")).toBe(routesContent);
  });

  it("should handle JavaScript projects correctly", async () => {
    // Create a routes.ts file
    const routesContent = `import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.jsx"),
] satisfies RouteConfig;`;

    writeFileSync(routesConfigPath, routesContent);

    await addRoutesToConfig(routesConfigPath, false); // JavaScript project

    // Check that both routes were added with .jsx/.js extensions
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.jsx")',
    );
    expect(updatedContent).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.js")',
    );
  });

  it("should not duplicate routes if they already exist", async () => {
    // Create a routes.ts file with both routes already present
    const routesContent = `import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
  route("/sentry-example-page", "routes/sentry-example-page.tsx"),
  route("/api/sentry-example-api", "routes/api.sentry-example-api.ts"),
] satisfies RouteConfig;`;

    writeFileSync(routesConfigPath, routesContent);

    await addRoutesToConfig(routesConfigPath, true);

    // Check that the routes were not duplicated
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    const pageRouteMatches = updatedContent.match(
      /route\("\/sentry-example-page"/g,
    );
    const apiRouteMatches = updatedContent.match(
      /route\("\/api\/sentry-example-api"/g,
    );
    expect(pageRouteMatches).toHaveLength(1);
    expect(apiRouteMatches).toHaveLength(1);
  });

  it("should add route import when it does not exist", async () => {
    // Create a routes.ts file without route import
    const routesContent = `import type { RouteConfig } from "@react-router/dev/routes";
import { index } from "@react-router/dev/routes";

export default [
  index("routes/home.tsx"),
] satisfies RouteConfig;`;

    writeFileSync(routesConfigPath, routesContent);

    await addRoutesToConfig(routesConfigPath, true);

    // Check that the route import was added
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain("route");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.tsx")',
    );
  });

  it("should create default export when it does not exist", async () => {
    // Create a routes.ts file without default export
    const routesContent = `import type { RouteConfig } from "@react-router/dev/routes";
import { index, route } from "@react-router/dev/routes";`;

    writeFileSync(routesConfigPath, routesContent);

    await addRoutesToConfig(routesConfigPath, true);

    // Check that the default export was created
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain("export default [");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.tsx")',
    );
    expect(updatedContent).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.ts")',
    );
  });

  it("should handle empty file gracefully", async () => {
    // Create an empty routes.ts file
    writeFileSync(routesConfigPath, "");

    await addRoutesToConfig(routesConfigPath, true);

    // Check that everything was added from scratch
    const updatedContent = readFileSync(routesConfigPath, "utf-8");
    expect(updatedContent).toContain(
      'import { route } from "@react-router/dev/routes";',
    );
    expect(updatedContent).toContain("export default [");
    expect(updatedContent).toContain(
      'route("/sentry-example-page", "routes/sentry-example-page.tsx")',
    );
    expect(updatedContent).toContain(
      'route("/api/sentry-example-api", "routes/api.sentry-example-api.ts")',
    );
  });

  it("should skip if file does not exist", async () => {
    // Don't create the file
    await addRoutesToConfig(routesConfigPath, true);

    // Should not create the file if it doesn't exist
    expect(existsSync(routesConfigPath)).toBe(false);
  });
});
