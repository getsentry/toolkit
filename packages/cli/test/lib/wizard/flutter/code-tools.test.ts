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
  });
});
