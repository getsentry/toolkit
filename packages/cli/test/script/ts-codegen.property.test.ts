/**
 * Property-Based Tests for the AST codegen helpers
 *
 * The SDK generator used to interpolate command briefs, enum values, and flag names straight
 * into source strings, so a `*` + `/` in a brief or a quote in an enum value would have produced
 * a file that does not parse. These properties check that anything routed through the helpers
 * prints as valid TypeScript and reads back as the original value.
 */

import { array, assert as fcAssert, property, string } from "fast-check";
import ts from "typescript";
import { describe, expect, test } from "vitest";
import {
  f,
  printNodes,
  propertyName,
  stringLiteralUnion,
  withJsDoc,
} from "../../script/ts-codegen.js";
import { DEFAULT_NUM_RUNS } from "../model-based/helpers.js";

/** Parse printed source, failing the property on any syntax error. */
function parse(source: string): ts.SourceFile {
  const { diagnostics } = ts.transpileModule(source, {
    reportDiagnostics: true,
  });
  if (diagnostics?.length) {
    throw new Error(
      ts.flattenDiagnosticMessageText(diagnostics[0]?.messageText ?? "", "\n"),
    );
  }
  return ts.createSourceFile(
    "printed.ts",
    source,
    ts.ScriptTarget.ESNext,
    true,
    ts.ScriptKind.TS,
  );
}

/** The single `type Probe = ...` alias in printed source. */
function probeAlias(file: ts.SourceFile): ts.TypeAliasDeclaration {
  const [statement] = file.statements;
  if (!(statement && ts.isTypeAliasDeclaration(statement))) {
    throw new Error("expected a single type alias");
  }
  return statement;
}

describe("ts-codegen", () => {
  test("any property name prints as a key that reads back unchanged", () => {
    fcAssert(
      property(string(), (name) => {
        const alias = f.createTypeAliasDeclaration(
          undefined,
          "Probe",
          undefined,
          f.createTypeLiteralNode([
            f.createPropertySignature(
              undefined,
              propertyName(name),
              undefined,
              f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
            ),
          ]),
        );
        const { type } = probeAlias(parse(printNodes([alias])));
        const [member] = (type as ts.TypeLiteralNode).members;
        const key = member?.name;
        expect(key && (ts.isIdentifier(key) || ts.isStringLiteral(key))).toBe(
          true,
        );
        expect((key as ts.Identifier | ts.StringLiteral).text).toBe(name);
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("any enum values print as a literal union that reads back unchanged", () => {
    fcAssert(
      property(array(string(), { minLength: 1 }), (values) => {
        const alias = f.createTypeAliasDeclaration(
          undefined,
          "Probe",
          undefined,
          stringLiteralUnion(values),
        );
        const { type } = probeAlias(parse(printNodes([alias])));
        const members = ts.isUnionTypeNode(type) ? type.types : [type];
        expect(
          members.map(
            (member) =>
              ((member as ts.LiteralTypeNode).literal as ts.StringLiteral).text,
          ),
        ).toEqual(values);
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });

  test("any JSDoc text stays inside its comment", () => {
    fcAssert(
      property(string(), (text) => {
        const alias = withJsDoc(
          f.createTypeAliasDeclaration(
            undefined,
            "Probe",
            undefined,
            f.createKeywordTypeNode(ts.SyntaxKind.StringKeyword),
          ),
          text,
        );
        const file = parse(printNodes([alias]));
        expect(file.statements).toHaveLength(1);
        expect(probeAlias(file).name.text).toBe("Probe");
      }),
      { numRuns: DEFAULT_NUM_RUNS },
    );
  });
});
