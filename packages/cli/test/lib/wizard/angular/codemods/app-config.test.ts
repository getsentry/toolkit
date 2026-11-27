import { generateCode, parseModule } from "magicast";
import { SemVer } from "semver";
import { describe, expect, it, vi } from "vitest";
import { updateAppConfigMod } from "../../../../../src/lib/wizard/angular/codemods/app-config.js";

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn() },
}));

const APP_CONFIG = `import { ApplicationConfig } from '@angular/core';
import { provideRouter } from '@angular/router';

export const appConfig: ApplicationConfig = {
  providers: [provideRouter(routes)],
};
`;

describe("updateAppConfigMod", () => {
  it("adds the ErrorHandler, TraceService, and provideAppInitializer on Angular 19+", () => {
    const mod = parseModule(APP_CONFIG);
    const { code } = generateCode(
      updateAppConfigMod(mod, new SemVer("19.0.0"), true),
    );

    expect(code).toContain("import * as Sentry from '@sentry/angular';");
    expect(code).toContain("provide: ErrorHandler");
    expect(code).toContain("useValue: Sentry.createErrorHandler()");
    expect(code).toContain("provide: Sentry.TraceService");
    expect(code).toContain("provideAppInitializer(() => {");
    expect(code).not.toContain("APP_INITIALIZER");
  });

  it("uses APP_INITIALIZER before Angular 19", () => {
    const mod = parseModule(APP_CONFIG);
    const { code } = generateCode(
      updateAppConfigMod(mod, new SemVer("18.2.0"), true),
    );

    expect(code).toContain("provide: APP_INITIALIZER");
    expect(code).not.toContain("provideAppInitializer");
  });

  it("only adds the ErrorHandler without tracing", () => {
    const mod = parseModule(APP_CONFIG);
    const { code } = generateCode(
      updateAppConfigMod(mod, new SemVer("19.0.0"), false),
    );

    expect(code).toContain("provide: ErrorHandler");
    expect(code).not.toContain("TraceService");
  });

  it.each(["19.0.0", "18.2.0"])(
    "does not import the tracing helpers without tracing on Angular %s",
    (version) => {
      const mod = parseModule(APP_CONFIG);
      const { code } = generateCode(
        updateAppConfigMod(mod, new SemVer(version), false),
      );

      expect(code).not.toContain("provideAppInitializer");
      expect(code).not.toContain("inject");
      expect(code).not.toContain("APP_INITIALIZER");
    },
  );
});
