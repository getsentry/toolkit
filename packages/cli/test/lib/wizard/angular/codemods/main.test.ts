import { describe, expect, it } from "vitest";
import { parseModule } from "magicast";

import { updateAppEntryMod } from "../../../../../src/lib/wizard/angular/codemods/main.js";

function getOriginalAppEntryMod() {
  return parseModule(`
    import { bootstrapApplication } from '@angular/platform-browser';
    import { appConfig } from './app/app.config';
    import { AppComponent } from './app/app.component';

    bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));
  `);
}

describe("updateAppEntryMod", () => {
  it("generates the init call without dataCollection when reduceDataCollection is false", () => {
    const mod = updateAppEntryMod(
      getOriginalAppEntryMod(),
      "https://sentry.io/123",
      { performance: true, replay: true },
      false,
    );

    const result = mod.generate().code;

    expect(result).not.toContain("dataCollection");
    expect(result).toMatchInlineSnapshot(`
      "import * as Sentry from '@sentry/angular';
      import { bootstrapApplication } from '@angular/platform-browser';
      import { appConfig } from './app/app.config';
      import { AppComponent } from './app/app.component';

      Sentry.init({
          dsn: "https://sentry.io/123",
          integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
          tracesSampleRate: 1,
          replaysSessionSampleRate: 0.1,
          replaysOnErrorSampleRate: 1
      })

      bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));"
    `);
  });

  it("generates the init call with the dataCollection preset when reduceDataCollection is true", () => {
    const mod = updateAppEntryMod(
      getOriginalAppEntryMod(),
      "https://sentry.io/123",
      { performance: true, replay: true },
      true,
    );

    const result = mod.generate().code;

    expect(result).toContain("userInfo: false");
    expect(result).toContain(
      'httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] }',
    );
    expect(result).toMatchInlineSnapshot(`
      "import * as Sentry from '@sentry/angular';
      import { bootstrapApplication } from '@angular/platform-browser';
      import { appConfig } from './app/app.config';
      import { AppComponent } from './app/app.component';

      Sentry.init({
          dsn: "https://sentry.io/123",
          integrations: [Sentry.browserTracingIntegration(), Sentry.replayIntegration()],
          tracesSampleRate: 1,
          replaysSessionSampleRate: 0.1,
          replaysOnErrorSampleRate: 1,
          // Turns off collection of data that could identify users. Adjust per category:
          // https://docs.sentry.io/platforms/javascript/configuration/options/#dataCollection
          dataCollection: {
            userInfo: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            httpBodies: [],
            httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
            cookies: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
            urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          },
      })

      bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));"
    `);
  });

  it("includes the dataCollection preset when all features are disabled", () => {
    const mod = updateAppEntryMod(
      getOriginalAppEntryMod(),
      "https://sentry.io/123",
      { performance: false, replay: false },
      true,
    );

    const result = mod.generate().code;

    expect(result).toMatchInlineSnapshot(`
      "import * as Sentry from '@sentry/angular';
      import { bootstrapApplication } from '@angular/platform-browser';
      import { appConfig } from './app/app.config';
      import { AppComponent } from './app/app.component';

      Sentry.init({
          dsn: "https://sentry.io/123",
          // Turns off collection of data that could identify users. Adjust per category:
          // https://docs.sentry.io/platforms/javascript/configuration/options/#dataCollection
          dataCollection: {
            userInfo: false,
            graphQL: { document: false, variables: false },
            genAI: { inputs: false, outputs: false },
            databaseQueryData: false,
            queues: false,
            httpBodies: [],
            httpHeaders: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
            cookies: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
            urlQueryParams: { deny: ["forwarded", "-ip", "remote-", "via", "-user"] },
          },
      })

      bootstrapApplication(AppComponent, appConfig).catch((err) => console.error(err));"
    `);
  });
});
