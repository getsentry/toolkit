import { marked } from "marked";

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
      return visitors(context, filename, (node, override = message) =>
        context.report({ node, message: override }),
      );
    },
  };
}

function someNode(node, predicate) {
  if (!node || typeof node !== "object") return false;
  if (predicate(node)) return true;
  return Object.entries(node).some(
    ([key, value]) =>
      key !== "parent" &&
      (Array.isArray(value)
        ? value.some((child) => someNode(child, predicate))
        : value && typeof value === "object" && someNode(value, predicate)),
  );
}

function containsIdentifier(node, identifier) {
  return someNode(
    node,
    (n) => n.type === "Identifier" && n.name === identifier,
  );
}

function readsProperty(node, object, property) {
  return someNode(
    node,
    (n) =>
      member(n, property) &&
      n.object.type === "Identifier" &&
      n.object.name === object,
  );
}

/**
 * Target positional types from `src/lib/target-positional.ts`, and
 * `boundArguments` positionals (`BoundArguments` and the commands' aliases).
 */
const BOUND_TARGET_TYPES = new Set([
  "ListCommandTarget",
  "OrgOptionalTarget",
  "OrgProjectTarget",
  "OrgTarget",
  "ProjectBoundTarget",
  "ReleaseTarget",
  "BoundArguments",
  "ConversationArguments",
  "DashboardArguments",
  "DashboardCreateArguments",
  "DashboardListArguments",
  "EventViewArguments",
  "InitArguments",
  "IntegrationArguments",
  "LogListArguments",
  "LogViewArguments",
  "ProjectCreateArguments",
  "ReplayArguments",
  "SpanListArguments",
  "SpanViewArguments",
  "TraceLogsArguments",
  "TraceViewArguments",
  "TrialStartArguments",
  "WidgetAddArguments",
]);

function boundTargetParams(fn) {
  return fn.params.filter((param) => {
    const type = param.typeAnnotation?.typeAnnotation;
    return (
      param.type === "Identifier" &&
      type?.type === "TSTypeReference" &&
      BOUND_TARGET_TYPES.has(type.typeName.name)
    );
  });
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

/** Static text of a string expression; dynamic parts become line breaks. */
function staticText(node) {
  if (node?.type === "Literal") {
    return typeof node.value === "string" ? node.value : "";
  }
  if (node?.type === "TemplateLiteral") {
    return node.quasis.map((quasi) => quasi.value.cooked ?? "").join("\n");
  }
  if (node?.type === "BinaryExpression" && node.operator === "+") {
    return staticText(node.left) + staticText(node.right);
  }
  if (node?.type === "ConditionalExpression") {
    return `${staticText(node.consequent)}\n${staticText(node.alternate)}`;
  }
  return "";
}

/** Matches a heading or label line that opens an Examples section. */
const EXAMPLES_LABEL_RE = /^examples?:?$/i;

/** Matches an indented `sentry …` usage line, whatever label sits above it. */
const EXAMPLE_LINE_RE = /^[ \t]+sentry\s/;

/** Whether help text has an Examples section or free-text example lines. */
function hasExamplesSection(text) {
  if (text.split("\n").some((line) => EXAMPLE_LINE_RE.test(line))) {
    return true;
  }
  return marked
    .lexer(text)
    .some((token) =>
      token.type === "heading"
        ? EXAMPLES_LABEL_RE.test(token.text.trim())
        : token.type === "paragraph" &&
          token.text
            .split("\n")
            .some((line) => EXAMPLES_LABEL_RE.test(line.trim())),
    );
}

/** Regex sources that match markdown headings or code fences. */
const MARKDOWN_STRUCTURE_RE = /(?:(?<!\[)\^|\\n)\(?(?:\?:)?#|`\{3|```|~\{3|~~~/;

/** Source of a regex literal or a `new RegExp("...")` with a static pattern. */
function regexSource(node) {
  if (node.type === "Literal" && node.regex) return node.regex.pattern;
  if (
    node.type === "NewExpression" &&
    node.callee.type === "Identifier" &&
    node.callee.name === "RegExp"
  )
    return staticText(node.arguments[0]);
  return "";
}

/**
 * Helpers that parse ID positionals by hand. Commands parse IDs with
 * `parseIdArguments()` (src/lib/id-arguments.ts), so every command takes
 * the same forms. `parseIssueTarget` and `parseDashboardTarget` only tag a
 * positional for completion, leaving the parsing to `func`; issues have
 * their own grammar (`issuePositional`, src/lib/issue-arguments.ts).
 */
const AD_HOC_ID_PARSING = new Set([
  "parseSlashSeparatedArg",
  "detectSwappedViewArgs",
  "HEX_ID_RE",
  "SPAN_ID_RE",
  "parseIssueTarget",
  "parseDashboardTarget",
]);

/**
 * Commands still allowed to, each with its follow-up. A ratchet: an entry
 * whose file no longer uses them is reported, so the list only shrinks.
 */
const AD_HOC_ID_PARSING_ALLOWED = new Map([
  // Follow-up (#1564): several issues per command (`issue view`,
  // `issue explain`, `issue merge`) need an array issue positional
  ["/src/commands/issue/utils.ts", "#1564: array issue positional"],
  ["/src/commands/issue/merge.ts", "#1564: array issue positional"],
]);

/**
 * Helpers that leave a target positional for `func` to parse:
 * `parseOrgTarget` and `parseOrgProjectTarget` only tag it for completion,
 * and the others parse a raw string (applying a pasted URL's server as they
 * go). Commands take targets as bound positionals instead
 * (src/lib/target-positional.ts, `boundArguments`), which parse before the
 * command runs and resolve on `target.resolved`.
 */
const UNBOUND_TARGET_PARSING = new Set([
  "parseOrgTarget",
  "parseOrgProjectTarget",
  "parseOrgProjectArg",
  "resolveOrgOnlyFromArg",
  "resolveOrgOptionalFromArg",
  "resolveProjectBoundFromArg",
]);

/** Commands still allowed to, each with its follow-up; a ratchet too. */
const UNBOUND_TARGET_PARSING_ALLOWED = new Map([
  // Follow-ups (#1564):
  // `[<org>/[<project>/]]<rule>`, resolving to every matching project
  ["/src/commands/alert/issues/create.ts", "#1564: alert rule target"],
  ["/src/commands/alert/issues/delete.ts", "#1564: alert rule target"],
  ["/src/commands/alert/issues/edit.ts", "#1564: alert rule target"],
  ["/src/commands/alert/issues/view.ts", "#1564: alert rule target"],
  // `[<org>/]<rule>`, org-scoped
  ["/src/commands/alert/metrics/create.ts", "#1564: alert rule target"],
  ["/src/commands/alert/metrics/delete.ts", "#1564: alert rule target"],
  ["/src/commands/alert/metrics/edit.ts", "#1564: alert rule target"],
  ["/src/commands/alert/metrics/list.ts", "#1564: alert rule target"],
  ["/src/commands/alert/metrics/view.ts", "#1564: alert rule target"],
]);

/** The follow-up of `file` in an allow-list, if it is on it. */
function allowedFollowUp(allowed, file) {
  for (const [path, followUp] of allowed) {
    if (file.endsWith(path)) return followUp;
  }
  return undefined;
}

/**
 * Visitors reporting each reference to one of `names` in a command file,
 * except in files on `allowed`; those are reported instead when they no
 * longer reference any, so the allow-list only shrinks. Imports and
 * `typeof` references are not uses.
 */
function ratchetedNames(file, names, allowed, report, message) {
  if (!file.includes("/src/commands/")) return {};
  const followUp = allowedFollowUp(allowed, file);
  let used = false;
  return {
    Identifier(node) {
      if (
        !names.has(node.name) ||
        node.parent?.type === "ImportSpecifier" ||
        node.parent?.type === "TSTypeQuery"
      )
        return;
      used = true;
      if (followUp === undefined) report(node, message);
    },
    "Program:exit"(node) {
      if (followUp !== undefined && !used)
        report(
          node,
          `Remove this file from the allow-list (${followUp}): it no longer parses its positional by hand.`,
        );
    },
  };
}

const ID_ARGUMENT_PARSERS = new Set(["parseIdArguments", "parseIdArgument"]);

/** Whether `node` is `ID_KINDS.<kind>`. */
function isIdKind(node) {
  return (
    node?.type === "MemberExpression" &&
    node.object.type === "Identifier" &&
    node.object.name === "ID_KINDS"
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
  "require-target-resolution": rule(
    "Await `<target>.resolved`: it runs the target's resolver.",
    (_context, file, report) => {
      if (!file.includes("/src/commands/")) return {};
      const check = (node) => {
        for (const param of boundTargetParams(node)) {
          if (!readsProperty(node.body, param.name, "resolved")) report(param);
        }
      };
      return {
        FunctionDeclaration: check,
        FunctionExpression: check,
        ArrowFunctionExpression: check,
        ...ratchetedNames(
          file,
          UNBOUND_TARGET_PARSING,
          UNBOUND_TARGET_PARSING_ALLOWED,
          report,
          "Take the target as a bound positional (src/lib/target-positional.ts, boundArguments) instead of parsing it in func.",
        ),
      };
    },
  ),
  "no-ad-hoc-id-arguments": rule(
    "Parse ID positionals with parseIdArguments() and an ID_KINDS kind.",
    (_context, file, report) => {
      if (!file.includes("/src/") || file.endsWith("/lib/id-arguments.ts"))
        return {};
      return {
        ...ratchetedNames(
          file,
          AD_HOC_ID_PARSING,
          AD_HOC_ID_PARSING_ALLOWED,
          report,
        ),
        CallExpression(node) {
          if (
            ID_ARGUMENT_PARSERS.has(node.callee.name) &&
            !isIdKind(node.arguments[1])
          )
            report(node);
        },
      };
    },
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
      file.includes("/src/") && !file.endsWith("/lib/api/infrastructure.ts")
        ? {
            CallExpression(node) {
              const limit = node.arguments[1];
              if (
                node.callee.name === "autoPaginate" &&
                (limit?.name === "limit" || member(limit, "limit"))
              )
                report(node);
            },
          }
        : {},
  ),
  "no-manual-pagination": rule(
    "Use paginate() from infrastructure.js instead of a limit-bounded cursor loop.",
    (_context, file, report) => {
      if (
        !file.includes("/src/") ||
        file.endsWith("/lib/api/infrastructure.ts")
      )
        return {};
      // A loop that follows cursors and also counts toward a limit is
      // re-deriving per_page and cursor-after-trim rules that paginate() owns.
      const check = (node) => {
        const followsCursors =
          containsIdentifier(node, "MAX_PAGINATION_PAGES") ||
          containsIdentifier(node, "nextCursor");
        if (followsCursors && containsIdentifier(node, "limit")) report(node);
      };
      return {
        ForStatement: check,
        WhileStatement: check,
        DoWhileStatement: check,
      };
    },
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
  "no-examples-in-full-description": rule(
    "Move command examples from fullDescription to docs.examples.",
    (_context, file, report) =>
      file.includes("/src/commands/") || file.endsWith("/src/app.ts")
        ? {
            Property(node) {
              const key = node.key?.name ?? node.key?.value;
              if (
                key === "fullDescription" &&
                hasExamplesSection(staticText(node.value))
              )
                report(node);
            },
          }
        : {},
  ),
  "no-regex-markdown-parsing": rule(
    "Parse markdown structure with marked instead of regexes.",
    (_context, file, report) =>
      file.includes("/src/") || file.includes("/script/")
        ? {
            Literal(node) {
              if (MARKDOWN_STRUCTURE_RE.test(regexSource(node))) report(node);
            },
            NewExpression(node) {
              if (MARKDOWN_STRUCTURE_RE.test(regexSource(node))) report(node);
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
