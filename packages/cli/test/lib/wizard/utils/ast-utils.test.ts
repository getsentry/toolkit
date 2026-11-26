import {
  getObjectProperty,
  getOrSetObjectProperty,
  hasSentryContent,
  parseJsonC,
  preserveTrailingNewline,
  printJsonC,
  setOrUpdateObjectProperty,
} from "../../../../src/lib/wizard/utils/ast-utils.js";

import recast from "recast";
const b = recast.types.builders;

import { describe, it, expect } from "vitest";

describe("hasSentryContent", () => {
  it.each([
    `
      const { sentryVitePlugin } = require("@sentry/bundler-plugins/vite");
      const somethingelse = require('gs');
    `,
    `
        import { sentryVitePlugin } from "@sentry/bundler-plugins/vite";
        import * as somethingelse from 'gs';

        export default {
            plugins: [sentryVitePlugin()]
        }
      `,
  ])(
    "returns true if a require('@sentry/') call was found in the parsed module",
    (code) => {
      // recast.parse returns a Program node (or fails) but it's badly typed as any
      const program = recast.parse(code)
        .program as recast.types.namedTypes.Program;
      expect(hasSentryContent(program)).toBe(true);
    },
  );

  it.each([
    `const whatever = require('something')`,
    `// const {sentryWebpackPlugin} = require('@sentry/bundler-plugins/webpack')`,
    `const {sAntryWebpackPlugin} = require('webpack-plugin-@sentry')`,
    `
      import * as somethingelse from 'gs';
      export default {
          plugins: []
      }
      `,
    `import * as somethingelse from 'gs';
       // import { sentryVitePlugin } from "@sentry/bundler-plugins/vite"
      export default {
          plugins: []
      }
      `,
    `import * as thirdPartyVitePlugin from "vite-plugin-@sentry"
      export default {
        plugins: [thirdPartyVitePlugin()]
      }
      `,
  ])(
    "returns false if the file doesn't contain any require('@sentry/') calls",
    (code) => {
      // recast.parse returns a Program node (or fails) but it's badly typed as any
      const program = recast.parse(code)
        .program as recast.types.namedTypes.Program;
      expect(hasSentryContent(program)).toBe(false);
    },
  );
});

describe("getObjectProperty", () => {
  it.each([
    [
      "literal",
      b.objectExpression([
        b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
        b.objectProperty(
          b.stringLiteral("needle"),
          b.stringLiteral("haystack"),
        ),
      ]),
    ],
    [
      "stringLiteral",
      b.objectExpression([
        b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
        b.objectProperty(b.literal("needle"), b.stringLiteral("haystack")),
      ]),
    ],
    [
      "identifier",
      b.objectExpression([
        b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
        b.objectProperty(b.identifier("needle"), b.stringLiteral("haystack")),
      ]),
    ],
  ])("returns the poperty (%s) if it exists", (_, object) => {
    const property = getObjectProperty(object, "needle");
    expect(property).toBeDefined();
    // @ts-expect-error we know it's defined due to the expect above
    expect(recast.print(property).code).toEqual(
      expect.stringContaining("needle"),
    );
  });

  it("returns undefined if the property does not exist", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
    ]);
    const property = getObjectProperty(object, "needle");
    expect(property).toBeUndefined();
  });

  it("handles objects without simple properties", () => {
    const object = b.objectExpression([b.spreadElement(b.identifier("foo"))]);
    const property = getObjectProperty(object, "needle");
    expect(property).toBeUndefined();
  });
});

describe("getOrSetObjectProperty", () => {
  it("returns the property if it exists", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("needle"), b.stringLiteral("haystack")),
    ]);

    const property = getOrSetObjectProperty(
      object,
      "needle",
      b.stringLiteral("nope"),
    );

    expect(property).toBeDefined();
    expect(property.type).toBe("ObjectProperty");
    // @ts-expect-error we know its type
    expect(property.key.name).toBe("needle");
    // @ts-expect-error we know its type
    expect(property.value.value).toBe("haystack");
  });

  it("adds the property if it does not exist", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
    ]);

    const property = getOrSetObjectProperty(
      object,
      "needle",
      b.stringLiteral("haystack"),
    );

    expect(property).toBeDefined();
    expect(property.type).toBe("Property");
    // @ts-expect-error we know its type
    expect(property.key.value).toBe("needle");
    // @ts-expect-error we know its type
    expect(property.value.value).toBe("haystack");
  });
});

describe("setOrUpdateObjectProperty", () => {
  it("sets a new property if it does not exist yet", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
    ]);

    setOrUpdateObjectProperty(object, "needle", b.stringLiteral("haystack"));

    expect(getObjectProperty(object, "needle")).toBeDefined();
  });

  it("updates an existing property if it exists", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
      b.objectProperty(b.identifier("needle"), b.stringLiteral("haystack")),
    ]);

    setOrUpdateObjectProperty(object, "needle", b.stringLiteral("haystack2"));

    const property = getObjectProperty(object, "needle");
    // @ts-expect-error it must be defiend, otherwise we fail anyway
    expect(property?.value.value).toBe("haystack2");
  });

  it("adds a comment to the existing property if provided", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
    ]);

    setOrUpdateObjectProperty(
      object,
      "needle",
      b.stringLiteral("haystack"),
      "This is a comment",
    );

    const property = getObjectProperty(object, "needle");
    expect(property?.comments).toHaveLength(1);
    // @ts-expect-error it must be defiend, otherwise we fail anyway
    expect(property?.comments[0].value).toBe(" This is a comment");
  });

  it("adds a comment to the new property if provided", () => {
    const object = b.objectExpression([
      b.objectProperty(b.identifier("foo"), b.stringLiteral("bar")),
    ]);

    setOrUpdateObjectProperty(
      object,
      "needle",
      b.stringLiteral("haystack"),
      "This is a comment",
    );

    const property = getObjectProperty(object, "needle");
    expect(property?.comments).toHaveLength(1);
    // @ts-expect-error it must be defiend, otherwise we fail anyway
    expect(property?.comments[0].value).toBe(" This is a comment");
  });
});

describe("preserveTrailingNewline", () => {
  it("adds trailing newline if original had one but generated does not", () => {
    const original = "const foo = 1;\n";
    const generated = "const foo = 1;";
    expect(preserveTrailingNewline(original, generated)).toBe(
      "const foo = 1;\n",
    );
  });

  it("does not add trailing newline if original did not have one", () => {
    const original = "const foo = 1;";
    const generated = "const foo = 1;";
    expect(preserveTrailingNewline(original, generated)).toBe("const foo = 1;");
  });

  it("does not double trailing newline if both already have one", () => {
    const original = "const foo = 1;\n";
    const generated = "const foo = 1;\n";
    expect(preserveTrailingNewline(original, generated)).toBe(
      "const foo = 1;\n",
    );
  });

  it("does not remove trailing newline if original did not have one but generated does", () => {
    const original = "const foo = 1;";
    const generated = "const foo = 1;\n";
    expect(preserveTrailingNewline(original, generated)).toBe(
      "const foo = 1;\n",
    );
  });
});

describe("parse and print JSON-C", () => {
  it.each([
    ["simple JSON", "{'foo': 'bar'}"],
    [
      "JSON-C with inline comment",
      `
    {
      "foo": "bar" // with an inline comment
    }
    `,
    ],
    [
      "JSON-C with multiple comments",
      `
    /*
     * let's throw in a block comment for good measure
     */  
    {
      // one line comment
      "foo": "bar", // another inline comment
      /* one more here */
      "dogs": /* and here */ "awesome",
    }
    /* and here */
    `,
    ],
  ])(`parses and prints JSON-C (%s)`, (_, json) => {
    const { ast, jsonObject } = parseJsonC(json);
    expect(ast?.type).toBe("Program");
    expect(jsonObject).toBeDefined();
    expect(jsonObject?.type).toBe("ObjectExpression");
    // @ts-expect-error we know it's defined due to the expect above
    expect(printJsonC(ast)).toEqual(json);
  });

  it("returns undefined if the input is not valid JSON-C", () => {
    const { ast, jsonObject } = parseJsonC(`{
      "invalid": // "json"
    }`);
    expect(ast).toBeUndefined();
    expect(jsonObject).toBeUndefined();
  });
});
