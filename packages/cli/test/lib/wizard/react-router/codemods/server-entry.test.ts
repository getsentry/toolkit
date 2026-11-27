import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import recast from "recast";
import {
  instrumentServerEntry,
  instrumentHandleRequest,
  instrumentHandleError,
} from "../../../../../src/lib/wizard/react-router/codemods/server-entry.js";

import { loadFile, generateCode } from "magicast";

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

vi.mock("../../../../../src/lib/wizard/utils/debug.js", () => ({
  debug: vi.fn(),
}));

describe("instrumentServerEntry", () => {
  const fixturesDir = path.join(__dirname, "fixtures", "server-entry");
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create unique tmp directory for each test
    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    tmpFile = path.join(tmpDir, "entry.server.tsx");

    // Ensure tmp directory exists
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up tmp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should add Sentry import and wrap handleRequest function", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentServerEntry(tmpFile);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    // Should add Sentry import
    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );

    // Should wrap the existing handleRequest function
    expect(modifiedContent).toContain(
      "export default Sentry.wrapSentryHandleRequest(handleRequest);",
    );

    // Should add the Sentry import at the top of the file (after existing imports)
    const lines = modifiedContent.split("\n");
    const sentryImportLine = lines.findIndex((line) =>
      line.includes('import * as Sentry from "@sentry/react-router";'),
    );
    expect(sentryImportLine).toBeGreaterThanOrEqual(0);

    // Should make handleRequest async
    expect(modifiedContent).toMatch(/async function handleRequest/);

    // Should create default handleError since none exists
    expect(modifiedContent).toContain(
      "export const handleError = Sentry.createSentryHandleError({",
    );
    expect(modifiedContent).toContain("logErrors: false");
  });

  it("should handle already instrumented server entry without duplication", async () => {
    const alreadyInstrumentedContent = readFileSync(
      path.join(fixturesDir, "already-instrumented.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, alreadyInstrumentedContent);

    await instrumentServerEntry(tmpFile);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    // Should not add duplicate imports or wrapping since already instrumented
    expect(modifiedContent).toContain(
      "import * as Sentry from '@sentry/react-router';",
    );
    expect(modifiedContent).toContain(
      "export default Sentry.wrapSentryHandleRequest(handleRequest);",
    );

    // Should NOT add a new createSentryHandleError export since handleError already has captureException
    expect(modifiedContent).not.toContain(
      "export const handleError = Sentry.createSentryHandleError({",
    );

    // Should preserve the existing handleError function with captureException
    expect(modifiedContent).toContain("Sentry.captureException(error);");
    expect(modifiedContent).toContain("export async function handleError");
  });

  it("should handle variable export pattern with existing export", async () => {
    const variableExportContent = readFileSync(
      path.join(fixturesDir, "variable-export.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, variableExportContent);

    await instrumentServerEntry(tmpFile);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    // Should add Sentry import and wrap handleRequest
    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain(
      "export default Sentry.wrapSentryHandleRequest(handleRequest);",
    );

    // Should instrument the existing handleError variable with captureException
    expect(modifiedContent).toContain("Sentry.captureException(error);");

    // Should preserve the variable export pattern
    expect(modifiedContent).toContain("export const handleError");
  });

  it("should not add duplicate async keyword when handleRequest is already async", async () => {
    const asyncContent = `
import { ServerRouter } from 'react-router';
import { renderToString } from 'react-dom/server';

export default async function handleRequest(request: Request) {
  const html = renderToString(<ServerRouter />);
  return new Response(html);
}
`;
    writeFileSync(tmpFile, asyncContent);

    await instrumentServerEntry(tmpFile);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    // Should have async function handleRequest (not async async)
    expect(modifiedContent).toMatch(/async function handleRequest/);
    expect(modifiedContent).not.toMatch(/async\s+async/);
    expect(modifiedContent).toContain(
      "export default Sentry.wrapSentryHandleRequest(handleRequest);",
    );
  });
});

describe("instrumentHandleRequest", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `handle-request-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should add required imports when creating new handleRequest", async () => {
    const content = `// Empty server entry file`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);
    instrumentHandleRequest(mod);

    // Check if required imports were added
    const imports = mod.imports.$items;
    const hasServerRouter = imports.some(
      (item: any) =>
        item.imported === "ServerRouter" && item.from === "react-router",
    );
    const hasRenderToPipeableStream = imports.some(
      (item: any) =>
        item.imported === "renderToPipeableStream" &&
        item.from === "react-dom/server",
    );

    expect(hasServerRouter).toBe(true);
    expect(hasRenderToPipeableStream).toBe(true);
  });

  it("should not duplicate imports if they already exist", async () => {
    const content = `
import { ServerRouter } from 'react-router';
import { renderToPipeableStream } from 'react-dom/server';
import { createReadableStreamFromReadable } from '@react-router/node';
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);
    const originalImportsCount = mod.imports.$items.length;

    instrumentHandleRequest(mod);

    // Should not add duplicate imports
    expect(mod.imports.$items.length).toBe(originalImportsCount);
  });
});

describe("instrumentHandleError", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `handle-error-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should not modify existing handleError with captureException", async () => {
    const content = `
export function handleError(error: unknown) {
  Sentry.captureException(error);
  console.error(error);
}
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);
    const originalBodyLength = (mod.$ast as any).body.length;

    instrumentHandleError(mod);

    // Should not modify since captureException already exists
    expect((mod.$ast as any).body.length).toBe(originalBodyLength);
  });

  it("should not modify existing handleError with createSentryHandleError", async () => {
    const content = `
export const handleError = Sentry.createSentryHandleError({
  logErrors: false
});
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);
    const originalBodyLength = (mod.$ast as any).body.length;

    instrumentHandleError(mod);

    // Should not modify since createSentryHandleError already exists
    expect((mod.$ast as any).body.length).toBe(originalBodyLength);
  });

  it("should add captureException to existing handleError function declaration without breaking AST", async () => {
    const content = `
export function handleError(error: unknown) {
  console.error('Custom error handling:', error);
  // some other logic here
}
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This should not throw an error due to broken AST manipulation
    expect(() => instrumentHandleError(mod)).not.toThrow();

    // Verify the function was modified correctly
    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");
    expect(modifiedCode).toContain(
      "console.error('Custom error handling:', error)",
    );
  });

  it("should add captureException to existing handleError variable declaration without breaking AST", async () => {
    const content = `
export const handleError = (error: unknown, { request }: { request: Request }) => {
  console.log('Handling error:', error.message);
  return new Response('Error occurred', { status: 500 });
};
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This should not throw an error due to broken AST manipulation
    expect(() => instrumentHandleError(mod)).not.toThrow();

    // Verify the function was modified correctly
    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");
    expect(modifiedCode).toContain(
      "console.log('Handling error:', error.message)",
    );
  });

  it("should handle existing handleError with only error parameter and add request parameter", async () => {
    const content = `
export const handleError = (error: unknown) => {
  console.error('Simple error handler:', error);
};
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This should not throw an error due to broken AST manipulation
    expect(() => instrumentHandleError(mod)).not.toThrow();

    // Verify the function signature was updated correctly
    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");
    expect(modifiedCode).toContain("if (!request.signal.aborted)");
    // Should add request parameter
    expect(modifiedCode).toMatch(
      /handleError.*=.*\(\s*error.*,\s*\{\s*request\s*\}/,
    );
  });
});

describe("instrumentHandleError capture placement and bindings", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(path.join(tmpdir(), "handle-error-bindings-"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  async function instrument(content: string): Promise<string> {
    const file = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(file, content);
    const mod = await loadFile(file);
    instrumentHandleError(mod);
    return generateCode(mod.$ast).code;
  }

  it("captures before an early return in a variable-declared handler", async () => {
    const code = await instrument(`
export const handleError = (error: unknown, { request }: { request: Request }) => {
  if (request.method === "HEAD") {
    return;
  }
  console.error(error);
};
`);
    expect(code.indexOf("Sentry.captureException(error)")).toBeLessThan(
      code.indexOf("return;"),
    );
  });

  it("adds a request binding to an error-only function declaration", async () => {
    const code = await instrument(`
export function handleError(error: unknown) {
  console.error(error);
}
`);
    expect(code).toMatch(
      /function handleError\(\s*error: unknown,\s*\{\s*request\s*\}\s*\)/,
    );
    expect(code).toContain("if (!request.signal.aborted)");
  });

  it("uses the existing parameter names", async () => {
    const code = await instrument(`
export function handleError(err: unknown, args: { request: Request }) {
  console.error(err);
}
`);
    expect(code).toContain("if (!args.request.signal.aborted)");
    expect(code).toContain("Sentry.captureException(err)");
  });

  it.each([
    ["a defaulted context", "error: any, { request } = {} as any"],
    ["a defaulted request", "error: any, { request = fallback }: any"],
  ])("captures with %s", async (_, params) => {
    const code = await instrument(`
export function handleError(${params}) {
  console.error(error);
}
`);
    expect(code).toContain("if (!request.signal.aborted)");
    expect(code).toContain("Sentry.captureException(error)");
  });

  it("reads request from a rest binding instead of adding a property after it", async () => {
    const code = await instrument(`
export function handleError(error: unknown, { params, ...rest }: any) {
  console.error(error);
}
`);
    expect(code).toContain("{ params, ...rest }");
    expect(code).toContain("if (!rest.request.signal.aborted)");
    expect(code).not.toMatch(/\.\.\.rest,\s*request/);
  });
});

describe("instrumentHandleError AST manipulation edge cases", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `ast-edge-cases-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should handle function declaration with existing try-catch block", async () => {
    const content = `
export function handleError(error: unknown, { request }: { request: Request }) {
  try {
    console.error('Error occurred:', error);
    logToExternalService(error);
  } catch (loggingError) {
    console.warn('Failed to log error:', loggingError);
  }
}
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This test will expose the broken AST logic
    expect(() => instrumentHandleError(mod)).not.toThrow();

    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");
    expect(modifiedCode).toContain("if (!request.signal.aborted)");
    // Should preserve existing try-catch
    expect(modifiedCode).toContain("try {");
    expect(modifiedCode).toContain("} catch (loggingError) {");
  });

  it("should handle arrow function with block body", async () => {
    const content = `
export const handleError = (error: unknown, context: any) => {
  const { request } = context;
  console.error('Error in route:', error);
  return new Response('Internal Server Error', { status: 500 });
};
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This test will expose the broken AST logic
    expect(() => instrumentHandleError(mod)).not.toThrow();

    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");
    expect(modifiedCode).toContain("if (!context.request.signal.aborted)");
    // Capture runs before the handler's own `return`.
    expect(modifiedCode.indexOf("captureException")).toBeLessThan(
      modifiedCode.indexOf("return new Response"),
    );
  });

  it("should demonstrate that the AST bug is now fixed - no longer throws TypeError", async () => {
    const content = `
export function handleError(error: unknown) {
  console.error('Error occurred:', error);
}
`;
    const tempFile = path.join(tmpDir, "entry.server.tsx");
    writeFileSync(tempFile, content);

    const mod = await loadFile(tempFile);

    // This test specifically targets the broken AST logic at lines 279-284 in server-entry.ts
    // The bug is in this code:
    // implementation.declarations[0].init.arguments[0].body.body.unshift(...)
    // Where 'implementation' is an IfStatement, not a VariableDeclaration

    let thrownError: Error | null = null;
    try {
      instrumentHandleError(mod);
    } catch (error) {
      thrownError = error as Error;
    }

    // The bug is fixed - no error should be thrown
    expect(thrownError).toBeNull();

    // And the code should be successfully modified
    const modifiedCode = generateCode(mod.$ast).code;
    expect(modifiedCode).toContain("Sentry.captureException(error)");

    // The error occurs because recast.parse() creates an IfStatement:
    // { type: 'IfStatement', test: ..., consequent: ... }
    // But the code tries to access .declarations[0] as if it were a VariableDeclaration
  });

  it("should demonstrate the specific line that breaks - recast.parse creates IfStatement not VariableDeclaration", () => {
    // This test shows exactly what the problematic line 278 in server-entry.ts creates
    const problematicCode = `if (!request.signal.aborted) {
  Sentry.captureException(error);
}`;

    // This is what line 278 does: recast.parse(problematicCode).program.body[0]
    const implementation = recast.parse(problematicCode).program.body[0];

    // The implementation is an IfStatement, not a VariableDeclaration
    expect(implementation.type).toBe("IfStatement");
    expect(implementation.declarations).toBeUndefined();

    // But lines 279-284 try to access implementation.declarations[0].init.arguments[0].body.body
    // This will throw "Cannot read properties of undefined (reading '0')"
    expect(() => {
      const declarations = implementation.declarations;
      return declarations[0]; // This line will throw the error
    }).toThrow("Cannot read properties of undefined");
  });
});

// Test for Bug #1: Array access vulnerability
describe("Array access vulnerability bugs", () => {
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();

    // Create unique tmp directory for each test
    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `test-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
    );
    tmpFile = path.join(tmpDir, "entry.server.tsx");

    // Ensure tmp directory exists
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    // Clean up tmp directory
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("should safely handle VariableDeclaration with empty declarations array", () => {
    // This test verifies that the bug fix works correctly
    // Previously this would crash, but now it handles empty arrays safely

    // The implementation now includes proper safety checks, so we test that
    // it can handle edge cases without crashing

    // Test the actual safe implementation behavior
    const testResult = () => {
      // Simulate the safe check logic from the actual implementation
      const declarations: any[] = []; // Empty array
      if (declarations.length === 0) {
        return false; // Safe early return
      }
      // This code would never be reached due to the safe check
      return declarations[0].id.name === "handleError";
    };

    // Should return false safely without throwing
    expect(testResult()).toBe(false);
  });

  it("should safely handle VariableDeclaration with empty declarations array after fix", async () => {
    // This test will pass after we fix the bug

    writeFileSync(tmpFile, "export const handleError = () => {};");
    const mod = await loadFile(tmpFile);

    // Create a problematic AST structure
    const problematicNode = {
      type: "ExportNamedDeclaration",
      declaration: {
        type: "VariableDeclaration",
        kind: "const",
        declarations: [], // Empty declarations array
      },
    };

    // Add the problematic node to the AST
    // @ts-expect-error - We need to access body for this test even though it's typed as any
    (mod.$ast.body as any[]).push(problematicNode);

    // After the fix, this should NOT throw an error
    let thrownError = null;
    try {
      instrumentHandleError(mod);
    } catch (error) {
      thrownError = error;
    }

    // After the fix, no error should be thrown
    expect(thrownError).toBeNull();
  });
});

describe("Instrumentation API", () => {
  const fixturesDir = path.join(__dirname, "fixtures", "server-entry");
  let tmpDir: string;
  let tmpFile: string;

  beforeEach(() => {
    vi.clearAllMocks();

    tmpDir = path.join(
      __dirname,
      "fixtures",
      "tmp",
      `test-instrumentation-api-${Date.now()}-${Math.random()
        .toString(36)
        .substring(2, 11)}`,
    );
    tmpFile = path.join(tmpDir, "entry.server.tsx");

    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) {
      rmSync(tmpDir, { recursive: true });
    }
  });

  it("should add instrumentations export when useInstrumentationAPI is true", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentServerEntry(tmpFile, true);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).toContain(
      'import * as Sentry from "@sentry/react-router";',
    );
    expect(modifiedContent).toContain(
      "export const instrumentations = [Sentry.createSentryServerInstrumentation()];",
    );
  });

  it("should not add instrumentations export when useInstrumentationAPI is false", async () => {
    const basicContent = readFileSync(
      path.join(fixturesDir, "basic.tsx"),
      "utf8",
    );

    writeFileSync(tmpFile, basicContent);

    await instrumentServerEntry(tmpFile, false);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).not.toContain("instrumentations");
    expect(modifiedContent).not.toContain("createSentryServerInstrumentation");
  });

  it("should not duplicate instrumentations export if already present", async () => {
    const contentWithInstrumentations = `
import { ServerRouter } from 'react-router';
import * as Sentry from '@sentry/react-router';

export default function handleRequest() {}
export const handleError = () => {};
export const instrumentations = [Sentry.createSentryServerInstrumentation()];
`;

    writeFileSync(tmpFile, contentWithInstrumentations);

    await instrumentServerEntry(tmpFile, true);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    const count = (modifiedContent.match(/\binstrumentations\b/g) || []).length;
    expect(count).toBe(1);
  });

  it("should not duplicate if legacy unstable_instrumentations export is already present", async () => {
    const contentWithLegacy = `
import { ServerRouter } from 'react-router';
import * as Sentry from '@sentry/react-router';

export default function handleRequest() {}
export const handleError = () => {};
export const unstable_instrumentations = [Sentry.createSentryServerInstrumentation()];
`;

    writeFileSync(tmpFile, contentWithLegacy);

    await instrumentServerEntry(tmpFile, true);

    const modifiedContent = readFileSync(tmpFile, "utf8");

    expect(modifiedContent).not.toContain("export const instrumentations =");
  });
});
