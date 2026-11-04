import type { Codemod, Edit, SgNode } from "codemod:ast-grep";
import type JS from "codemod:ast-grep/langs/javascript";
import type TS from "codemod:ast-grep/langs/typescript";
import type TSX from "codemod:ast-grep/langs/tsx";

/**
 * Migrates programmatic `@sentry/cli` v3 (`SentryCli` class) usage to the v4
 * `sentry` package (`createSentrySDK` factory + typed command methods).
 *
 * The transform is intentionally conservative: it only touches files that
 * actually import `@sentry/cli`, keeps the user's binding name, and drops a
 * `// TODO(sentry-v4)` breadcrumb wherever an option shape changed and needs a
 * manual check rather than guessing.
 */

type L = JS | TS | TSX;
type Node = SgNode<L>;

/** v3 `releases.<method>` → v4 `[route, target]`. */
const METHOD_MAP: Record<string, [string, string]> = {
  new: ["release", "create"],
  finalize: ["release", "finalize"],
  setCommits: ["release", "set-commits"],
  uploadSourceMaps: ["sourcemap", "upload"],
  proposeVersion: ["release", "propose-version"],
  // Note: `newDeploy` is handled separately (via the `run(...)` escape hatch),
  // not here — the typed `release.deploy` method can't pass the required
  // environment positional. See the transform below.
};

/** How each method's positional args fold into the v4 options object. */
const RESHAPE: Record<
  string,
  { key: string; spread?: boolean; todo?: string }
> = {
  new: { key: "orgVersion" },
  finalize: { key: "orgVersion" },
  setCommits: {
    key: "orgVersion",
    spread: true,
    todo: "verify set-commits options: v4 has no `ignoreMissing`/`ignoreEmpty` (both dropped); repo/commit map via the `commit` flag and `auto`/`local` are kept",
  },
  // No spread: v3 `include` is a path array, but v4 `sourcemap.upload` takes a
  // single `directory` string — spreading would emit an invalid `include` key.
  uploadSourceMaps: {
    key: "release",
    todo: "sourcemaps are debug-ID-first in v4: set the `directory` option to your bundle output dir (v3 `include` was a path array — run one upload per directory) and review the remaining options",
  },
};

const isNullish = (n: Node) =>
  n.kind() === "null" ||
  (n.kind() === "identifier" && n.text() === "undefined");
const identSafe = (s: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(s);
const accessor = (name: string) =>
  identSafe(name) ? `.${name}` : `[${JSON.stringify(name)}]`;
const unquote = (s: string) => s.replace(/^['"]|['"]$/g, "");

const codemod: Codemod<L> = async (root) => {
  const rootNode = root.root();
  const source = root.source();
  const edits: Edit[] = [];

  /** Local names bound to the v3 SentryCli class (default import / require). */
  const bindings = new Set<string>();
  /** Namespace-import names (`import * as X`) whose `.default` is the v3 class. */
  const nsBindings = new Set<string>();
  /** Variable names holding an SDK instance (`const cli = new SentryCli()`). */
  const instanceNames = new Set<string>();

  const named = (n: Node) => n.isNamed();
  const argsOf = (call: Node): Node[] => {
    const a = call.field("arguments");
    return a ? a.children().filter(named) : [];
  };

  /** Index of the start of the line containing `index`. */
  const lineStart = (index: number) => source.lastIndexOf("\n", index - 1) + 1;

  /** Insert a leading `// TODO(sentry-v4): …` above the enclosing statement. */
  const todo = (node: Node, msg: string): Edit => {
    let p: Node | null = node;
    while (p && !/(_statement|declaration)$/.test(p.kind())) {
      p = p.parent();
    }
    const start = (p ?? node).range().start.index;
    const ls = lineStart(start);
    const indent = source.slice(ls, start);
    return {
      startPos: ls,
      endPos: ls,
      insertedText: `${indent}// TODO(sentry-v4): ${msg}\n`,
    };
  };

  const replaceNode = (node: Node, text: string): Edit => ({
    startPos: node.range().start.index,
    endPos: node.range().end.index,
    insertedText: text,
  });

  // 1) Rewrite the module specifier, keeping the user's binding name.
  //    ESM: `import X from "@sentry/cli"` (quote-agnostic, structural).
  for (const imp of rootNode.findAll({
    rule: {
      kind: "import_statement",
      has: { field: "source", regex: "@sentry/cli" },
    },
  })) {
    const src = imp.field("source");
    if (!src || unquote(src.text()) !== "@sentry/cli") continue;
    const clause = imp.children().find((c) => c.kind() === "import_clause");
    // Default import (`import X from`) or namespace import (`import * as X from`).
    const def = clause?.children().find((c) => c.kind() === "identifier");
    const nsId = clause
      ?.children()
      .find((c) => c.kind() === "namespace_import")
      ?.children()
      .find((c) => c.kind() === "identifier");
    if (def) bindings.add(def.text());
    if (nsId) {
      // Namespace import: the v3 class is the module's default export, so it's
      // constructed as `new X.default()` (or `new X()` if the module is callable).
      bindings.add(nsId.text());
      nsBindings.add(nsId.text());
    }
    const q = src.text()[0];
    edits.push(replaceNode(src, `${q}sentry${q}`));
  }
  //    CJS: `const X = require("@sentry/cli")` (metavar is quote-agnostic).
  //    Also handles `const X = require("@sentry/cli").default` (member access).
  for (const call of rootNode.findAll({ rule: { pattern: "require($SRC)" } })) {
    const src = call.getMatch("SRC");
    if (!src || unquote(src.text()) !== "@sentry/cli") continue;
    // The declarator may be the direct parent, or one level up when the require
    // is the object of a member expression (`require(...).default`).
    let decl = call.parent();
    if (decl?.kind() === "member_expression") decl = decl.parent();
    if (decl?.kind() === "variable_declarator") {
      const id = decl.field("name");
      if (id?.kind() === "identifier") bindings.add(id.text());
    }
    const q = src.text()[0];
    edits.push(replaceNode(src, `${q}sentry${q}`));
  }

  // Only touch files that actually import the v3 wrapper.
  if (bindings.size === 0) return null;

  // 2) Collect instance variable names from `new <binding>(...)`.
  //    Matches `new X(...)` for any binding, plus `new X.default(...)` when X is
  //    a namespace import (the v3 class is the module's default export).
  const isCtor = (c: Node | null): boolean => {
    if (!c) return false;
    if (bindings.has(c.text())) return true;
    if (c.kind() === "member_expression") {
      const obj = c.field("object");
      const prop = c.field("property");
      return (
        !!obj &&
        !!prop &&
        prop.text() === "default" &&
        nsBindings.has(obj.text())
      );
    }
    return false;
  };
  const newExprs = rootNode
    .findAll({ rule: { pattern: "new $C($$$A)" } })
    .filter((n) => isCtor(n.field("constructor")));
  for (const ne of newExprs) {
    const p = ne.parent();
    if (p?.kind() === "variable_declarator") {
      const id = p.field("name");
      if (id?.kind() === "identifier") instanceNames.add(id.text());
    } else if (p?.kind() === "assignment_expression") {
      const l = p.field("left");
      if (l?.kind() === "identifier") instanceNames.add(l.text());
    }
  }
  const isInstance = (recv: Node | null) =>
    !!recv && recv.kind() === "identifier" && instanceNames.has(recv.text());

  // 3) Constructor: `new X(configFile?, options?)` → `X(options?)`.
  for (const ne of newExprs) {
    const callee = ne.field("constructor");
    if (!callee) continue;
    // Drop `new ` (v4's default export is a factory function, not a class).
    edits.push({
      startPos: ne.range().start.index,
      endPos: callee.range().start.index,
      insertedText: "",
    });

    const a = argsOf(ne);
    let options: Node | null = null;
    let ambiguous = false;
    if (a.length >= 2) {
      // Drop the configFile positional (removed in v4).
      edits.push({
        startPos: a[0]!.range().start.index,
        endPos: a[1]!.range().start.index,
        insertedText: "",
      });
      if (isNullish(a[1]!)) {
        edits.push(replaceNode(a[1]!, "")); // `new X(cfg, null)` → `X()`
      } else {
        options = a[1]!;
      }
    } else if (a.length === 1) {
      const arg = a[0]!;
      if (isNullish(arg)) {
        edits.push(replaceNode(arg, "")); // `new X(null)` → `X()`
      } else if (arg.kind() === "object") {
        options = arg;
      } else {
        options = arg;
        ambiguous = true;
      }
    }

    if (options?.kind() === "object") {
      // Rename authToken → token in place.
      const keys: string[] = [];
      for (const c of options.children()) {
        if (c.kind() === "pair") {
          const k = c.field("key");
          const kn = k ? unquote(k.text()) : "";
          if (kn) keys.push(kn);
          if (k && kn === "authToken") edits.push(replaceNode(k, "token"));
        } else if (c.kind() === "shorthand_property_identifier") {
          keys.push(c.text());
          if (c.text() === "authToken") {
            // `{ authToken }` → `{ token: authToken }` (keep the binding).
            edits.push(replaceNode(c, "token: authToken"));
          }
        }
      }
      // v3 SentryCliOptions keys with no direct v4 `SentryOptions` equivalent.
      // (`token`/`url`/`org`/`project` ARE first-class v4 options, so they're
      // fine as-is; only flag the ones that need attention.)
      const unmapped = keys.filter((k) =>
        [
          "apiKey",
          "dsn",
          "silent",
          "customHeader",
          "headers",
          "vcsRemote",
        ].includes(k),
      );
      if (unmapped.length) {
        edits.push(
          todo(
            ne,
            `verify these v3 options — they have no direct v4 SentryOptions equivalent: ${unmapped.join(", ")} (apiKey → rename to \`token\`; dsn → use SENTRY_DSN env; silent/customHeader/headers/vcsRemote were dropped)`,
          ),
        );
      }
    } else if (ambiguous) {
      edits.push(
        todo(
          ne,
          "verify this argument: v3's first constructor param was a configFile path (removed in v4); v4 takes an options object. Drop it if it's a config path, or map authToken→token if it's options",
        ),
      );
    } else if (options) {
      edits.push(
        todo(
          ne,
          "v4 renamed the `authToken` option to `token` — update it inside the options object passed here",
        ),
      );
    }
  }

  // 4a) `<instance>.execute([...], live?)` → `<instance>.run(...args)`.
  for (const call of rootNode.findAll({
    rule: { pattern: "$RECV.execute($$$A)" },
  })) {
    const recv = call.getMatch("RECV");
    if (!isInstance(recv)) continue;
    const a = argsOf(call);
    let runArgs = "";
    if (a[0]?.kind() === "array") {
      runArgs = a[0]
        .children()
        .filter(named)
        .map((c) => c.text())
        .join(", ");
    } else if (a[0]) {
      runArgs = `...${a[0].text()}`;
    }
    edits.push(
      todo(
        call,
        "run(...) passes raw CLI args verbatim; remap v3 command names to v4 (releases→release, new→create, login→auth login, …) and verify flags. NOTE: v3's second `execute` arg (`live`) is dropped — v4 `run()` always captures and returns output (v3 `live:false` behavior); if you passed `live:true`/`'rejectOnError'` for streamed stdio, adjust accordingly",
      ),
    );
    edits.push(replaceNode(call, `${recv!.text()}.run(${runArgs})`));
  }

  // 4b) `<instance>.releases.<method>(...)` → `<instance>.<route>.<target>({…})`.
  for (const call of rootNode.findAll({
    rule: { pattern: "$RECV.releases.$METHOD($$$A)" },
  })) {
    const recv = call.getMatch("RECV");
    const methodNode = call.getMatch("METHOD");
    if (!recv || !methodNode || !isInstance(recv)) continue;
    const method = methodNode.text();
    const a = argsOf(call);

    if (method === "newDeploy") {
      // The typed `release.deploy` SDK method collapses version/environment/name
      // into a single positional token, so it can't supply the required
      // environment. Emit the raw `run(...)` escape hatch (which forwards
      // separate argv) and flag the parts the codemod can't derive.
      const version = a[0]?.text();
      edits.push(
        todo(
          call,
          "release deploy needs <environment> (and optional [name]) as positionals plus --url/--started/--finished/--time flags from your v3 options — add them to this run() call",
        ),
      );
      edits.push(
        replaceNode(
          call,
          `${recv.text()}.run("release", "deploy"${version ? `, ${version}` : ""})`,
        ),
      );
      continue;
    }

    const map = METHOD_MAP[method];
    if (!map) continue;
    const [route, target] = map;
    const reshape = RESHAPE[method];

    let argsOut: string;
    if (reshape) {
      const parts: string[] = [];
      if (a[0]) parts.push(`${reshape.key}: ${a[0].text()}`);
      if (reshape.spread && a[1]) {
        if (a[1].kind() === "object") {
          const inner = a[1]
            .text()
            .replace(/^\{\s*/, "")
            .replace(/\s*\}$/, "")
            .trim();
          if (inner) parts.push(inner);
        } else {
          parts.push(`...${a[1].text()}`);
        }
      }
      argsOut = parts.length ? `{ ${parts.join(", ")} }` : "";
    } else {
      argsOut = a.map((n) => n.text()).join(", ");
    }

    if (reshape?.todo) edits.push(todo(call, reshape.todo));
    edits.push(
      replaceNode(
        call,
        `${recv.text()}${accessor(route)}${accessor(target)}(${argsOut})`,
      ),
    );
  }

  return edits.length ? rootNode.commitEdits(edits) : null;
};

export default codemod;
