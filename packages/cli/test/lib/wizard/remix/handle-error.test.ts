import { parseModule } from "magicast";
import { describe, expect, it, vi } from "vitest";
import { instrumentHandleError } from "../../../../src/lib/wizard/remix/codemods/handle-error.js";

vi.mock("@clack/prompts", () => ({
  log: { warn: vi.fn(), info: vi.fn(), success: vi.fn() },
}));

function instrument(source: string): { changed: boolean; code: string } {
  const mod = parseModule(source);
  const changed = instrumentHandleError(mod, "entry.server.tsx");
  return { changed, code: mod.generate().code };
}

describe("instrumentHandleError (Remix)", () => {
  it("wraps an async function declaration and keeps its parameters", () => {
    const { changed, code } = instrument(`
export async function handleError(error, args) {
  await log(args.request, error);
}
`);

    expect(changed).toBe(true);
    expect(code).toMatch(
      /export const handleError = Sentry\.wrapHandleErrorWithSentry\(async function\s*\(error, args\) \{\s*await log\(args\.request, error\);\s*\}\);/,
    );
  });

  it("wraps an arrow function with an expression body", () => {
    const { changed, code } = instrument(`
export const handleError = (error) => console.error(error);
`);

    expect(changed).toBe(true);
    expect(code).toContain(
      "export const handleError = Sentry.wrapHandleErrorWithSentry((error) => console.error(error));",
    );
  });

  it("wraps a handler that is built elsewhere", () => {
    const { code } = instrument(`
export const handleError = createHandler();
`);

    expect(code).toContain(
      "export const handleError = Sentry.wrapHandleErrorWithSentry(createHandler());",
    );
  });

  it("leaves an already wrapped handler alone", () => {
    const { changed } = instrument(`
import * as Sentry from "@sentry/remix";
export const handleError = Sentry.wrapHandleErrorWithSentry((error) => {});
`);

    expect(changed).toBe(false);
  });
});
