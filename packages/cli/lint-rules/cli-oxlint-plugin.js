const name = "sentry-cli";

function member(node, property) {
  return (
    node?.type === "MemberExpression" &&
    !node.computed &&
    node.property.name === property
  );
}

function call(node, property) {
  return node.type === "CallExpression" && member(node.callee, property);
}

function rule(message, visitors) {
  return {
    meta: { type: "problem", docs: { description: message }, schema: [] },
    create(context) {
      const filename = context.filename.replaceAll("\\", "/");
      if (!filename.includes("/packages/cli/")) return {};
      return visitors(context, filename, (node) =>
        context.report({ node, message }),
      );
    },
  };
}

function containsIdentifier(node, identifier) {
  if (!node || typeof node !== "object") return false;
  if (node.type === "Identifier" && node.name === identifier) return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((child) => containsIdentifier(child, identifier))
        : value &&
          typeof value === "object" &&
          containsIdentifier(value, identifier)),
  );
}

function silentBody(block, parameter) {
  if (block?.type !== "BlockStatement" || block.body.length > 1) return false;
  if (block.body.length === 0) return true;
  const statement = block.body[0];
  return (
    statement.type === "ReturnStatement" &&
    (!parameter ||
      parameter.type !== "Identifier" ||
      !containsIdentifier(statement.argument, parameter.name))
  );
}

const rules = {
  "no-silent-catch": rule(
    "Handle or report caught errors instead of discarding them.",
    (context, file, report) =>
      file.includes("/src/")
        ? {
            TryStatement(node) {
              if (
                node.handler &&
                silentBody(node.handler.body, node.handler.param)
              )
                report(node);
            },
            CallExpression(node) {
              if (!call(node, "catch")) return;
              const handler = node.arguments[0];
              if (
                handler?.type === "ArrowFunctionExpression" &&
                silentBody(handler.body, handler.params[0])
              )
                report(node);
            },
          }
        : {},
  ),
  "no-stdout-write-in-commands": rule(
    "Yield CommandOutput instead of writing to stdout.",
    (_context, file, report) =>
      file.includes("/src/commands/")
        ? {
            CallExpression(node) {
              if (call(node, "write") && node.callee.object.name === "stdout")
                report(node);
            },
          }
        : {},
  ),
  "no-process-stdout-in-commands": rule(
    "Use CommandOutput instead of process.stdout in commands.",
    (_context, file, report) =>
      file.includes("/src/commands/")
        ? {
            MemberExpression(node) {
              if (member(node, "stdout") && node.object.name === "process")
                report(node);
            },
          }
        : {},
  ),
  "no-stderr-write-in-commands": rule(
    "Use the tagged logger instead of writing to stderr.",
    (_context, file, report) =>
      file.includes("/src/commands/")
        ? {
            CallExpression(node) {
              if (call(node, "write") && node.callee.object.name === "stderr")
                report(node);
            },
          }
        : {},
  ),
  "no-raw-metadata-queries": rule(
    "Use the metadata helpers in db/utils.js.",
    (context, file, report) =>
      file.endsWith("utils.ts") || file.endsWith("migration.ts")
        ? {}
        : {
            CallExpression(node) {
              if (
                call(node, "query") &&
                node.arguments.length > 0 &&
                /(?:SELECT value FROM|DELETE FROM) metadata/.test(
                  context.sourceCode.getText(node.arguments[0]),
                )
              )
                report(node);
              if (
                node.callee.name === "runUpsert" &&
                node.arguments[1]?.value === "metadata"
              )
                report(node);
            },
          },
  ),
  "no-manual-transactions": rule(
    "Use db.transaction()() instead of manual transaction statements.",
    (context, file, report) =>
      !file.includes("/src/") ||
      file.endsWith("migration.ts") ||
      file.endsWith("db/sqlite.ts")
        ? {}
        : {
            CallExpression(node) {
              if (
                call(node, "exec") &&
                node.arguments.length > 0 &&
                /\b(?:BEGIN|COMMIT|ROLLBACK)\b/.test(
                  context.sourceCode.getText(node.arguments[0]),
                )
              )
                report(node);
            },
          },
  ),
  "no-inline-touch-cache": rule(
    "Use touchCacheEntry() instead of an inline last_accessed update.",
    (context, file, report) =>
      file.endsWith("utils.ts")
        ? {}
        : {
            CallExpression(node) {
              if (
                call(node, "run") &&
                call(node.callee.object, "query") &&
                node.callee.object.arguments.length > 0 &&
                /UPDATE .* SET last_accessed/.test(
                  context.sourceCode.getText(node.callee.object.arguments[0]),
                )
              )
                report(node);
            },
          },
  ),
  "no-args-join-in-release": rule(
    "Use the Stricli tuple positional instead of joining release args.",
    (_context, file, report) =>
      file.includes("/src/commands/release/")
        ? {
            CallExpression(node) {
              if (call(node, "join") && node.callee.object.name === "args")
                report(node);
            },
          }
        : {},
  ),
  "no-direct-target-resolution": rule(
    "Use a capability helper from resolve-target.ts.",
    (_context, file, report) =>
      file.includes("/src/commands/") && !file.endsWith("/issue/utils.ts")
        ? {
            CallExpression(node) {
              if (
                node.callee.name === "findProjectsBySlug" ||
                node.callee.name === "triageProjectNotFound" ||
                member(node.callee, "findProjectsBySlug") ||
                member(node.callee, "triageProjectNotFound")
              )
                report(node);
            },
          }
        : {},
  ),
  "no-generic-is-record": rule(
    "Use a shape-specific guard instead of isRecord().",
    (_context, file, report) =>
      file.includes("/src/")
        ? {
            FunctionDeclaration(node) {
              if (node.id?.name === "isRecord") report(node);
            },
            VariableDeclarator(node) {
              if (
                node.id.name === "isRecord" &&
                ["ArrowFunctionExpression", "FunctionExpression"].includes(
                  node.init?.type,
                )
              )
                report(node);
            },
          }
        : {},
  ),
  "prefer-paginate-helper": rule(
    "Use paginate() from infrastructure.js instead of a raw limit.",
    (_context, file, report) =>
      file.includes("/src/lib/api/") && !file.endsWith("/infrastructure.ts")
        ? {
            CallExpression(node) {
              if (
                node.callee.name === "autoPaginate" &&
                node.arguments[1]?.name === "limit"
              )
                report(node);
            },
          }
        : {},
  ),
  "no-namespace-import": rule(
    "Import only the names used by production code.",
    (_context, file, report) =>
      file.includes("/src/") || file.includes("/test/")
        ? {
            ImportNamespaceSpecifier(node) {
              report(node);
            },
          }
        : {},
  ),
  "no-skipped-tests": rule(
    "Do not leave disabled tests in the suite.",
    (_context, file, report) =>
      file.includes("/test/")
        ? {
            CallExpression(node) {
              if (
                member(node.callee, "skip") &&
                ["test", "it", "describe"].includes(node.callee.object.name)
              )
                report(node);
            },
          }
        : {},
  ),
};

export default { meta: { name }, rules };
