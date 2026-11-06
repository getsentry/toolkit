import { describe, expect, it } from "vitest";
import {
  mapStructuredStacktrace,
  structuredStacktraceSchema,
} from "./structured-stacktrace";

// Frames as Sentry's event API returns them: every key present, unset ones null.
function sentryFrame(overrides: Record<string, unknown>) {
  return {
    filename: null,
    absPath: null,
    module: null,
    package: null,
    platform: null,
    instructionAddr: null,
    symbolAddr: null,
    function: null,
    rawFunction: null,
    symbol: null,
    context: [],
    lineNo: null,
    colNo: null,
    inApp: false,
    trust: null,
    errors: null,
    lock: null,
    sourceLink: null,
    vars: null,
    ...overrides,
  };
}

const context = (lineNo: number) =>
  [-3, -2, -1, 0, 1, 2, 3, 4].map(
    (offset) =>
      [lineNo + offset, `line ${lineNo + offset}`] as [number, string],
  );

describe("mapStructuredStacktrace", () => {
  it("writes only the fields that have a value", () => {
    const stacktrace = mapStructuredStacktrace({
      frames: [
        sentryFrame({
          filename: "django/core/handlers/base.py",
          absPath: "django/core/handlers/base.py",
          module: "django.core.handlers.base",
          function: "get_response",
          lineNo: 181,
          colNo: null,
          inApp: false,
        }),
        sentryFrame({
          filename: "",
          absPath: "/usr/src/app/checkout.py",
          function: "submit",
          lineNo: 7,
          inApp: true,
        }),
      ],
      framesOmitted: null,
    });

    expect(structuredStacktraceSchema.parse(stacktrace)).toEqual(stacktrace);
    expect(stacktrace?.frames).toEqual([
      {
        filename: "django/core/handlers/base.py",
        module: "django.core.handlers.base",
        function: "get_response",
        lineNo: 181,
      },
      {
        absPath: "/usr/src/app/checkout.py",
        function: "submit",
        lineNo: 7,
        inApp: true,
      },
    ]);
  });

  it("gives context and vars only to the most relevant in-app frame", () => {
    const stacktrace = mapStructuredStacktrace({
      frames: [
        sentryFrame({
          filename: "app/models.py",
          function: "save",
          lineNo: 10,
          inApp: true,
          context: context(10),
          vars: { self: "<Order>" },
        }),
        sentryFrame({
          filename: "site-packages/requests/api.py",
          function: "post",
          lineNo: 20,
          inApp: false,
          context: context(20),
          vars: { url: "https://api.example.com/charge", token: "abc" },
        }),
        sentryFrame({
          filename: "app/payments.py",
          function: "charge",
          lineNo: 30,
          inApp: true,
          context: context(30),
          vars: { amount: 42 },
        }),
        sentryFrame({
          filename: "site-packages/urllib3/connection.py",
          function: "connect",
          lineNo: 40,
          inApp: false,
          context: context(40),
          vars: { host: "api.example.com" },
        }),
      ],
      framesOmitted: null,
    });

    expect(stacktrace?.frames).toEqual([
      {
        filename: "app/models.py",
        function: "save",
        lineNo: 10,
        inApp: true,
        contextLine: "line 10",
      },
      {
        filename: "site-packages/requests/api.py",
        function: "post",
        lineNo: 20,
        contextLine: "line 20",
      },
      {
        filename: "app/payments.py",
        function: "charge",
        lineNo: 30,
        inApp: true,
        contextLine: "line 30",
        preContext: ["line 27", "line 28", "line 29"],
        postContext: ["line 31", "line 32", "line 33"],
        vars: { amount: 42 },
      },
      {
        filename: "site-packages/urllib3/connection.py",
        function: "connect",
        lineNo: 40,
        contextLine: "line 40",
      },
    ]);
  });

  it("keeps context and vars off every frame when detail is off", () => {
    const stacktrace = mapStructuredStacktrace(
      {
        frames: [
          sentryFrame({
            filename: "app/payments.py",
            lineNo: 30,
            inApp: true,
            context: context(30),
            vars: { amount: 42 },
          }),
        ],
        framesOmitted: null,
      },
      { detail: false },
    );

    expect(stacktrace?.frames).toEqual([
      {
        filename: "app/payments.py",
        lineNo: 30,
        inApp: true,
        contextLine: "line 30",
      },
    ]);
  });

  it("cuts a large variable to 200 characters of JSON", () => {
    const rows = Array.from({ length: 50 }, (_, index) => ({
      id: index,
      email: `user${index}@example.com`,
    }));
    const stacktrace = mapStructuredStacktrace({
      frames: [
        sentryFrame({
          filename: "app/export.py",
          lineNo: 5,
          inApp: true,
          vars: { rows, count: 50, label: "export" },
        }),
      ],
      framesOmitted: null,
    });

    const vars = stacktrace?.frames[0]?.vars;
    expect(vars?.count).toBe(50);
    expect(vars?.label).toBe("export");
    expect(vars?.rows).toBe(`${JSON.stringify(rows).slice(0, 200)}…`);
  });

  it("keeps vars on a detail frame that has no line number", () => {
    const stacktrace = mapStructuredStacktrace({
      frames: [
        sentryFrame({
          function: "handle_request",
          module: "app.views",
          inApp: true,
          vars: { user_id: 42 },
        }),
      ],
      framesOmitted: null,
    });

    expect(stacktrace?.frames[0]).toEqual({
      function: "handle_request",
      module: "app.views",
      inApp: true,
      vars: { user_id: 42 },
    });
  });
});
