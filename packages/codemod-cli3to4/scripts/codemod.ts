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
  newDeploy: ["release", "deploy"],
  listDeploys: ["release", "deploys"],
};

/** How each method's positional args fold into the v4 options object. */
const RESHAPE: Record<
  string,
  {
    key: string;
    /** Merge the v3 options argument into the v4 options object. */
    spread?: boolean;
    /** v3 → v4 key renames applied inside an object-literal options arg. */
    rename?: Record<string, string>;
    todo?: string;
  }
> = {
  // v3 `new(release, { projects })`: see `projectArg` for the v4 `project`.
  new: { key: "orgVersion" },
  finalize: { key: "orgVersion" },
  setCommits: {
    key: "orgVersion",
    spread: true,
    todo: 'verify set-commits options: v3 `repo`/`commit`/`previousCommit` become one `commit: "REPO@PREV..SHA"` string; `ignoreMissing`/`ignoreEmpty` were dropped; `auto` is kept',
  },
  newDeploy: {
    key: "orgVersion",
    spread: true,
    rename: { env: "environment" },
    todo: "verify deploy options: v3 `env` is v4 `environment`; `started`/`finished` are ISO 8601 strings and `time` is a string of seconds (v3 took numbers); `projects` was dropped",
  },
  listDeploys: { key: "orgVersion" },
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

/**
 * The v4 `project` value (one comma-separated string) for v3's
 * `releases.new(release, opts)` options, whose only key was `projects`
 * (a string array). `null` when `opts` has other keys to review by hand.
 */
/** `n`'s text, parenthesized unless it can take a `.member` suffix as-is. */
const operand = (n: Node) =>
  /^(identifier|member_expression|subscript_expression|call_expression|array|parenthesized_expression|this)$/.test(
    n.kind(),
  )
    ? n.text()
    : `(${n.text()})`;

const projectArg = (opts: Node): string | null => {
  if (opts.kind() !== "object") return `${operand(opts)}.projects?.join(",")`;
  const props = opts.children().filter((c) => c.isNamed());
  if (props.length !== 1) return null;
  const [p] = props;
  if (
    p!.kind() === "shorthand_property_identifier" &&
    p!.text() === "projects"
  ) {
    return `projects.join(",")`;
  }
  const k = p!.kind() === "pair" ? p!.field("key") : null;
  const v = p!.field("value");
  if (!k || !v || unquote(k.text()) !== "projects") return null;
  const items =
    v.kind() === "array" ? v.children().filter((c) => c.isNamed()) : [];
  // `["web", "api"]` → `"web,api"`; anything else is joined at runtime.
  if (
    items.length &&
    items.every((i) => i.kind() === "string" && !/[\\,]/.test(i.text()))
  ) {
    return JSON.stringify(items.map((i) => unquote(i.text())).join(","));
  }
  return `${operand(v)}.join(",")`;
};

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

  /** An object literal's text with top-level keys renamed per `rename`. */
  const renameKeys = (obj: Node, rename: Record<string, string>): string => {
    const base = obj.range().start.index;
    const out: [number, number, string][] = [];
    for (const c of obj.children()) {
      if (c.kind() === "pair") {
        const k = c.field("key");
        const to = k && rename[unquote(k.text())];
        if (k && to) out.push([k.range().start.index, k.range().end.index, to]);
      } else if (c.kind() === "shorthand_property_identifier") {
        const to = rename[c.text()];
        if (to) {
          out.push([
            c.range().start.index,
            c.range().end.index,
            `${to}: ${c.text()}`,
          ]);
        }
      }
    }
    let text = obj.text();
    for (const [start, end, to] of out.reverse()) {
      text = text.slice(0, start - base) + to + text.slice(end - base);
    }
    return text;
  };

  /** Empty a call's argument list, keeping the parens: `X(null,\n)` → `X()`. */
  const clearArgs = (call: Node): Edit => {
    const r = call.field("arguments")!.range();
    return {
      startPos: r.start.index + 1,
      endPos: r.end.index - 1,
      insertedText: "",
    };
  };

  // 1) Rewrite the module specifier, keeping the user's binding name.
  //    v3 exports the class as `SentryCli` (`import { SentryCli }`); v2 set
  //    `module.exports` to it (`import X from` / bare `require`). v4 exports
  //    the `createSentrySDK` factory as both its default and a named export.
  const rewriteSource = (src: Node) => {
    const q = src.text()[0];
    edits.push(replaceNode(src, `${q}sentry${q}`));
  };
  /** Names used as `X.SentryCli`, i.e. bindings holding the v3 module object. */
  const memberObjects = new Set(
    rootNode
      .findAll({ rule: { pattern: "$OBJ.SentryCli" } })
      .map((m) => m.getMatch("OBJ")?.text() ?? ""),
  );

  //    ESM: `import X from`, `import * as X from`, `import { SentryCli } from`.
  for (const imp of rootNode.findAll({
    rule: {
      kind: "import_statement",
      has: { field: "source", regex: "@sentry/cli" },
    },
  })) {
    const src = imp.field("source");
    if (!src || unquote(src.text()) !== "@sentry/cli") continue;
    const clause = imp.children().find((c) => c.kind() === "import_clause");
    const def = clause?.children().find((c) => c.kind() === "identifier");
    const nsId = clause
      ?.children()
      .find((c) => c.kind() === "namespace_import")
      ?.children()
      .find((c) => c.kind() === "identifier");
    if (def) bindings.add(def.text());
    if (nsId) {
      // `new X.SentryCli()` (v3) or `new X.default()` (v2 via interop).
      bindings.add(nsId.text());
      nsBindings.add(nsId.text());
    }
    for (const spec of imp.findAll({ rule: { kind: "import_specifier" } })) {
      const name = spec.field("name")?.text();
      const local = spec.field("alias")?.text() ?? name;
      if (!name || !local) continue;
      const typeOnly = /^type\s/.test(spec.text()) ? "type " : "";
      if (name === "SentryCli") {
        bindings.add(local);
        edits.push(replaceNode(spec, `${typeOnly}createSentrySDK as ${local}`));
      } else if (name === "SentryCliOptions") {
        edits.push(replaceNode(spec, `${typeOnly}SentryOptions as ${local}`));
      } else {
        edits.push(
          todo(
            imp,
            `v4 has no \`${name}\` export; use the parameter types of the v4 SDK methods instead`,
          ),
        );
      }
    }
    rewriteSource(src);
  }
  //    CJS: `require("@sentry/cli")` bare, `.default`, `.SentryCli`, or
  //    destructured (`const { SentryCli } = require(…)`).
  for (const call of rootNode.findAll({ rule: { pattern: "require($SRC)" } })) {
    const src = call.getMatch("SRC");
    if (!src || unquote(src.text()) !== "@sentry/cli") continue;
    const parent = call.parent();
    const member = parent?.kind() === "member_expression" ? parent : null;
    // The name the value lands in: `const X = …` or `X = …`, also through
    // parens and ternary branches (`const X = c ? require(…) : null`).
    let value: Node = member ?? call;
    let decl = value.parent();
    while (
      decl &&
      (decl.kind() === "parenthesized_expression" ||
        (decl.kind() === "ternary_expression" &&
          decl.field("condition")?.id() !== value.id()))
    ) {
      value = decl;
      decl = decl.parent();
    }
    const id =
      decl?.kind() === "variable_declarator"
        ? decl.field("name")
        : decl?.kind() === "assignment_expression" &&
            decl.field("right")?.id() === value.id()
          ? decl.field("left")
          : null;

    if (id?.kind() === "object_pattern") {
      for (const c of id.children()) {
        if (
          c.kind() === "shorthand_property_identifier_pattern" &&
          c.text() === "SentryCli"
        ) {
          bindings.add("SentryCli");
          edits.push(replaceNode(c, "createSentrySDK: SentryCli"));
        } else if (c.kind() === "pair_pattern") {
          const k = c.field("key");
          const v = c.field("value");
          if (k && unquote(k.text()) === "SentryCli" && v) {
            bindings.add(v.text());
            edits.push(replaceNode(k, "createSentrySDK"));
          }
        }
      }
      rewriteSource(src);
    } else if (member) {
      // `.default` stays valid; `.SentryCli` becomes `.createSentrySDK`
      // (rewritten with the other `X.SentryCli` member accesses below).
      if (id?.kind() === "identifier") bindings.add(id.text());
      rewriteSource(src);
    } else if (id?.kind() === "identifier" && memberObjects.has(id.text())) {
      // v3: the module object, used as `X.SentryCli`.
      bindings.add(id.text());
      nsBindings.add(id.text());
      rewriteSource(src);
    } else {
      // v2: `module.exports` was the class itself; v4's CJS module object
      // exposes the factory as `.default`/`createSentrySDK`, so add `.default`.
      if (id?.kind() === "identifier") bindings.add(id.text());
      const q = src.text()[0];
      edits.push(replaceNode(call, `require(${q}sentry${q}).default`));
    }
  }

  //    `X.SentryCli` on the v3 module object → `X.createSentrySDK`.
  const isRequire = (n: Node) =>
    /^require\(\s*["']@sentry\/cli["']\s*\)$/.test(n.text());
  const isModuleMember = (obj: Node | null) =>
    !!obj && (nsBindings.has(obj.text()) || isRequire(obj));
  for (const m of rootNode.findAll({ rule: { pattern: "$OBJ.SentryCli" } })) {
    const prop = m.field("property");
    if (prop && isModuleMember(m.getMatch("OBJ"))) {
      edits.push(replaceNode(prop, "createSentrySDK"));
    }
  }

  //    v3's static `getVersion()`/`getPath()` are static members of the v4
  //    factory too, so the calls carry over. `getPath()` now points at a
  //    Node.js script rather than a native binary.
  for (const call of rootNode.findAll({ rule: { pattern: "$B.getPath()" } })) {
    const b = call.getMatch("B");
    if (
      b &&
      (bindings.has(b.text()) ||
        isModuleMember(b) ||
        isModuleMember(b.field("object")))
    ) {
      edits.push(
        todo(
          call,
          "v4 `getPath()` is a Node.js script, not a native binary: spawn it as `execFile(process.execPath, [getPath(), ...args])`, or call the SDK methods instead",
        ),
      );
    }
  }

  // 2) Collect instance variable names from `new <binding>(...)`.
  //    Matches `new X(...)` for any binding, plus `new X.default(...)` when X is
  //    a namespace import (the v3 class is the module's default export).
  const isCtor = (c: Node | null): boolean => {
    while (c?.kind() === "parenthesized_expression") {
      c = c.children().find(named) ?? null;
    }
    if (!c) return false;
    // `new (require("@sentry/cli"))()`: v2's module was the class itself.
    if (bindings.has(c.text()) || isRequire(c)) return true;
    if (c.kind() === "member_expression") {
      const obj = c.field("object");
      const prop = c.field("property");
      return (
        !!obj &&
        !!prop &&
        (prop.text() === "default" || prop.text() === "SentryCli") &&
        isModuleMember(obj)
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
  const newExprIds = new Set(newExprs.map((n) => n.id()));
  /** An SDK instance: a variable from step 2, or `new X()` inline. */
  const isInstance = (recv: Node | null): boolean => {
    while (recv?.kind() === "parenthesized_expression") {
      recv = recv.children().find(named) ?? null;
    }
    if (!recv) return false;
    if (recv.kind() === "new_expression") return newExprIds.has(recv.id());
    return recv.kind() === "identifier" && instanceNames.has(recv.text());
  };
  /** Replace a call after its receiver, so edits inside the receiver (an
   *  inline `new X(…)`) still apply. */
  const replaceAfter = (recv: Node, call: Node, text: string): Edit => ({
    startPos: recv.range().end.index,
    endPos: call.range().end.index,
    insertedText: text,
  });

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
      if (isNullish(a[1]!)) {
        // `new X(cfg, null)` → `X()` (also drops any trailing comma).
        edits.push(clearArgs(ne));
      } else {
        // Drop the configFile positional (removed in v4).
        edits.push({
          startPos: a[0]!.range().start.index,
          endPos: a[1]!.range().start.index,
          insertedText: "",
        });
        options = a[1]!;
      }
    } else if (a.length === 1) {
      const arg = a[0]!;
      if (isNullish(arg)) {
        edits.push(clearArgs(ne)); // `new X(null)` → `X()`
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
      // (`token`/`url`/`org`/`project`/`headers` ARE first-class v4 options, so
      // they're fine as-is; only flag the ones that need attention.)
      const unmapped = keys.filter((k) =>
        ["apiKey", "dsn", "silent", "customHeader", "vcsRemote"].includes(k),
      );
      if (unmapped.length) {
        edits.push(
          todo(
            ne,
            `verify these v3 options — they have no direct v4 SentryOptions equivalent: ${unmapped.join(", ")} (apiKey → rename to \`token\`; customHeader → move the "Name: value" string into the \`headers\` object; dsn → use SENTRY_DSN env; silent/vcsRemote were dropped)`,
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
    edits.push(replaceAfter(recv!, call, `.run(${runArgs})`));
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

    const map = METHOD_MAP[method];
    if (!map) continue;
    const [route, target] = map;
    const reshape = RESHAPE[method];

    let argsOut: string;
    const project = method === "new" && a[1] ? projectArg(a[1]) : undefined;
    if (method === "new" && a[1] && project === null) {
      edits.push(
        todo(
          call,
          "map v3 `projects` (array) to v4 `project` (comma-separated string) by hand",
        ),
      );
    }
    if (project && a[0]) {
      argsOut = `{ orgVersion: ${a[0].text()}, project: ${project} }`;
    } else if (reshape) {
      const lead = a[0] ? `${reshape.key}: ${a[0].text()}` : "";
      const opts = reshape.spread ? a[1] : undefined;
      if (opts?.kind() === "object" && opts.children().some(named)) {
        // Keep the user's object text verbatim (layout and comments, so a
        // trailing `// …` can't swallow the closing brace); prepend the key.
        const text = reshape.rename
          ? renameKeys(opts, reshape.rename)
          : opts.text();
        argsOut = `{ ${lead ? `${lead},` : ""}${text.slice(1)}`;
      } else {
        const parts = [lead];
        if (opts && opts.kind() !== "object") parts.push(`...${opts.text()}`);
        const kept = parts.filter(Boolean);
        argsOut = kept.length ? `{ ${kept.join(", ")} }` : "";
      }
    } else {
      argsOut = a.map((n) => n.text()).join(", ");
    }

    if (reshape?.todo) edits.push(todo(call, reshape.todo));
    edits.push(
      replaceAfter(
        recv,
        call,
        `${accessor(route)}${accessor(target)}(${argsOut})`,
      ),
    );
  }

  // 4c) `<instance>.sourceMaps.inject(opts)` → `<instance>.sourcemap.inject(opts)`.
  for (const call of rootNode.findAll({
    rule: { pattern: "$RECV.sourceMaps.inject($$$A)" },
  })) {
    const recv = call.getMatch("RECV");
    if (!recv || !isInstance(recv)) continue;
    const args = argsOf(call)
      .map((n) => n.text())
      .join(", ");
    edits.push(
      todo(
        call,
        "verify inject options: v4 takes one `directory` (v3 `paths` was an array — run once per directory), and `ignore`/`ext` are comma-separated strings; `ignoreFile`/`dryRun` are kept",
      ),
    );
    edits.push(replaceAfter(recv, call, `.sourcemap.inject(${args})`));
  }

  return edits.length ? rootNode.commitEdits(edits) : null;
};

export default codemod;
