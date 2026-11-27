import { describe, expect, it } from "vitest";
import {
  patchMainContent,
  getDependenciesLocation,
  getDevDependenciesLocation,
  getLastImportLineLocation,
} from "../../../../src/lib/wizard/flutter/code-tools.js";
import { initSnippet } from "../../../../src/lib/wizard/flutter/templates.js";

describe("code-tools", () => {
  const pubspec = `name: flutter_example
description: An example flutter app.
version: 1.0.0
publish_to: 'none' # Remove this line if you wish to publish to pub.dev

environment:
  sdk: '>=2.17.0 <4.0.0'
  flutter: '>=3.0.0'

dependencies:
  flutter:
    sdk: flutter

dev_dependencies:
  flutter_lints: ^2.0.0
`;

  const simpleRunApp = `import 'package:flutter/widgets.dart';

void main() {
  runApp(const MyApp());
}
`;

  const asyncRunApp = `import 'package:flutter/widgets.dart';

void main() {
  runApp(const MyApp());
}
`;

  const selectedFeaturesMap = {
    tracing: true,
    replay: true,
  };

  const simpleRunAppPatched = `import 'package:flutter/widgets.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  ${initSnippet("dsn", selectedFeaturesMap, "const MyApp()")}
}
`;

  const paramRunApp = `import 'package:flutter/widgets.dart';

Future<void> main() async {
  await someFunction();
  runApp(MyApp(param: SomeParam()));
  await anotherFunction();
}
`;

  const paramRunAppPatched = `import 'package:flutter/widgets.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  await someFunction();
  ${initSnippet("dsn", selectedFeaturesMap, "MyApp(param: SomeParam())")}
  await anotherFunction();
}
`;

  const multilineRunApp = `import 'package:flutter/widgets.dart';

void main() {
  runApp(
    MyApp(
      param: Param(),
      multi: Another(1),
      line: await bites(the: "dust"),
    ),
  );
  anotherFunction();
}
`;

  const multilineRunAppPatched = `import 'package:flutter/widgets.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

Future<void> main() async {
  ${initSnippet(
    "dsn",
    selectedFeaturesMap,
    `
    MyApp(
      param: Param(),
      multi: Another(1),
      line: await bites(the: "dust"),
    ),
  `,
  )}
  anotherFunction();
}
`;

  describe("patchMainContent", () => {
    function patched(main: string, runAppArgs: string): string {
      return `import 'package:flutter/widgets.dart';
import 'package:sentry_flutter/sentry_flutter.dart';

${main} {
  ${initSnippet("dsn", selectedFeaturesMap, runAppArgs)}
}
`;
    }

    it("wraps the whole runApp call when its arguments contain a statement", () => {
      const args =
        "MaterialApp(home: Builder(builder: (c) { return Text('x'); }))";
      expect(
        patchMainContent(
          "dsn",
          `import 'package:flutter/widgets.dart';\n\nvoid main() {\n  runApp(${args});\n}\n`,
          selectedFeaturesMap,
        ),
      ).toBe(patched("Future<void> main() async", args));
    });

    it("skips parentheses in strings and comments inside runApp", () => {
      const args = "MyApp(title: 'a);b') /* ) */";
      expect(
        patchMainContent(
          "dsn",
          `import 'package:flutter/widgets.dart';\n\nvoid main() {\n  runApp(${args});\n}\n`,
          selectedFeaturesMap,
        ),
      ).toBe(patched("Future<void> main() async", args));
    });

    it("leaves a commented-out runApp call alone", () => {
      const source = (call: string) =>
        `import 'package:flutter/widgets.dart';\n\nvoid main() {\n  // runApp(const OldApp());\n  ${call}\n}\n`;
      expect(
        patchMainContent(
          "dsn",
          source("runApp(const MyApp());"),
          selectedFeaturesMap,
        ),
      ).toBe(
        `import 'package:flutter/widgets.dart';\nimport 'package:sentry_flutter/sentry_flutter.dart';\n\nFuture<void> main() async {\n  // runApp(const OldApp());\n  ${initSnippet("dsn", selectedFeaturesMap, "const MyApp()")}\n}\n`,
      );
    });

    it("leaves main text inside strings and comments alone", () => {
      const source = `import 'package:flutter/widgets.dart';\n\n// void main() {\nvoid main() {\n  print('void main() {');\n  runApp(const MyApp());\n}\n`;
      expect(patchMainContent("dsn", source, selectedFeaturesMap)).toBe(
        `import 'package:flutter/widgets.dart';\nimport 'package:sentry_flutter/sentry_flutter.dart';\n\n// void main() {\nFuture<void> main() async {\n  print('void main() {');\n  ${initSnippet("dsn", selectedFeaturesMap, "const MyApp()")}\n}\n`,
      );
    });

    it("keeps an existing Sentry import and adds no second one", () => {
      const source = `import 'package:flutter/widgets.dart';\nimport 'package:sentry_flutter/sentry_flutter.dart';\n\nvoid main() {\n  runApp(const MyApp());\n}\n`;
      expect(patchMainContent("dsn", source, selectedFeaturesMap)).toBe(
        `import 'package:flutter/widgets.dart';\nimport 'package:sentry_flutter/sentry_flutter.dart';\n\nFuture<void> main() async {\n  ${initSnippet("dsn", selectedFeaturesMap, "const MyApp()")}\n}\n`,
      );
    });

    it("leaves a commented-out arrow main alone", () => {
      const source = `import 'package:flutter/widgets.dart';\n\n// void main() => runApp(const OldApp());\nvoid main() {\n  runApp(const MyApp());\n}\n`;
      expect(patchMainContent("dsn", source, selectedFeaturesMap)).toBe(
        `import 'package:flutter/widgets.dart';\nimport 'package:sentry_flutter/sentry_flutter.dart';\n\n// void main() => runApp(const OldApp());\nFuture<void> main() async {\n  ${initSnippet("dsn", selectedFeaturesMap, "const MyApp()")}\n}\n`,
      );
    });

    it("turns an expression-bodied main into an async block", () => {
      expect(
        patchMainContent(
          "dsn",
          `import 'package:flutter/widgets.dart';\n\nvoid main() => runApp(const MyApp());\n`,
          selectedFeaturesMap,
        ),
      ).toBe(patched("Future<void> main() async", "const MyApp()"));
    });

    it("makes a main with parameters async", () => {
      expect(
        patchMainContent(
          "dsn",
          `import 'package:flutter/widgets.dart';\n\nvoid main(List<String> args) {\n  runApp(const MyApp());\n}\n`,
          selectedFeaturesMap,
        ),
      ).toBe(
        patched("Future<void> main(List<String> args) async", "const MyApp()"),
      );
    });

    it("adds no init without a runApp statement", () => {
      expect(
        patchMainContent(
          "dsn",
          `void main() {\n  bootstrap();\n}\n`,
          selectedFeaturesMap,
        ),
      ).not.toContain("SentryFlutter.init(");
    });

    it("wraps simple runApp", () => {
      expect(patchMainContent("dsn", simpleRunApp, selectedFeaturesMap)).toBe(
        simpleRunAppPatched,
      );
    });

    it("wraps async runApp", () => {
      expect(patchMainContent("dsn", asyncRunApp, selectedFeaturesMap)).toBe(
        simpleRunAppPatched,
      );
    });

    it("wraps runApp with parameterized app", () => {
      expect(patchMainContent("dsn", paramRunApp, selectedFeaturesMap)).toBe(
        paramRunAppPatched,
      );
    });

    it("wraps multiline runApp", () => {
      expect(
        patchMainContent("dsn", multilineRunApp, selectedFeaturesMap),
      ).toBe(multilineRunAppPatched);
    });
  });

  describe("pubspec", () => {
    it("returns proper line index for dependencies", () => {
      expect(getDependenciesLocation(pubspec)).toBe(
        pubspec.indexOf("  flutter:\n"),
      );
    });

    it("returns proper line index for dev-dependencies", () => {
      expect(getDevDependenciesLocation(pubspec)).toBe(
        pubspec.indexOf("  flutter_lints: ^2.0.0\n"),
      );
    });

    it("finds a header with a trailing comment", () => {
      const withComment = "dev_dependencies: # tools\n  lints: ^2.0.0\n";
      expect(getDevDependenciesLocation(withComment)).toBe(
        withComment.indexOf("  lints"),
      );
    });

    it("returns -1 without the header", () => {
      expect(getDevDependenciesLocation("dependencies:\n  http: any\n")).toBe(
        -1,
      );
    });
  });

  describe("getLastImportLineLocation", () => {
    it("returns proper line index", () => {
      const code =
        `import 'foo:bar';\n` + `//<insert-location>\n` + `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when alias import is used", () => {
      const code =
        `import 'package:my_library/utils.dart' as utils;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when specific parts import is used", () => {
      const code =
        `import 'dart:math' show pi, sin;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when hide import is used", () => {
      const code =
        `import 'dart:math' hide Random;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when deferred import is used", () => {
      const code =
        `import 'package:my_library/large_library.dart' deferred as largeLibrary;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("returns proper line index when multiple imports (with newlines) are present", () => {
      const code =
        `import 'foo:bar';\n` +
        `import 'package:my_library/utils.dart' as utils;\n` +
        `import 'dart:math' show pi, sin;\n` +
        `import 'dart:math' hide Random;\n` +
        `\n` +
        `import 'package:my_library/large_library.dart' deferred as largeLibrary;\n` +
        `//<insert-location>\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });

    it("ignores imports inside comments", () => {
      const code =
        `import 'package:flutter/widgets.dart';\n` +
        `//<insert-location>\n` +
        `/* import 'package:foo/foo.dart'; */\n` +
        `// import 'package:bar/bar.dart';\n` +
        `class X {}`;
      expect(getLastImportLineLocation(code)).toBe(
        code.indexOf("//<insert-location>"),
      );
    });
  });
});
