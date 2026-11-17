import { beforeEach, describe, expect, test, vi } from "vitest";

/** A fresh `sdk-app.ts`: it keeps the routes it loaded in module state. */
async function importSdkApp() {
  return await import("../../src/sdk-app.js");
}

/** The top-level route names of an application's routes. */
function routeNames(routes: {
  getAllEntries(): readonly { name: { original: string } }[];
}): string[] {
  return routes.getAllEntries().map((entry) => entry.name.original);
}

beforeEach(() => {
  vi.resetModules();
});

describe("loadSdkApp", () => {
  test("loads only the routes a call runs", async () => {
    const { loadSdkApp } = await importSdkApp();
    const { routes } = await loadSdkApp(["org", "list"]);
    expect(routeNames(routes)).toEqual(["help", "org"]);
  });

  test("keeps the routes of earlier calls", async () => {
    const { loadSdkApp } = await importSdkApp();
    const first = await loadSdkApp(["org", "list"]);
    const second = await loadSdkApp(["issue", "list"]);

    expect(routeNames(second.routes).sort()).toEqual(["help", "issue", "org"]);
    // An earlier call's command still resolves in the newer application
    expect(second.routes.getRoutingTargetForInput("org")).toBe(
      first.routes.getRoutingTargetForInput("org"),
    );
    // A call whose routes are loaded reuses the application
    expect(await loadSdkApp(["org", "view"])).toBe(second);
  });

  test("loads the routes of concurrent calls into one application", async () => {
    const { loadSdkApp } = await importSdkApp();
    await Promise.all([
      loadSdkApp(["org", "list"]),
      loadSdkApp(["project", "list"]),
    ]);
    const { routes } = await loadSdkApp(["org", "list"]);
    expect(routeNames(routes).sort()).toEqual(["help", "org", "project"]);
  });

  test("loads app.ts for a call that needs the whole tree, from then on", async () => {
    const { loadSdkApp } = await importSdkApp();
    const app = await import("../../src/app.js");

    expect((await loadSdkApp(["help"])).routes).toBe(app.routes);
    expect((await loadSdkApp(["org", "list"])).routes).toBe(app.routes);
  });
});
