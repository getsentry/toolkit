// Grammar for one argument that names an issue, for `issue view`, `issue
// explain`, and every other command that takes one.
//
// The issue ID formats table in the docs (features.md) is generated from the
// `@form` lines below (script/generate-docs-sections.ts). A line reads
// `@form <form> <syntax> <example> — <meaning>`: `<form>` is the `form` the
// grammar returns for the example, and `<syntax>` and `<example>` are code
// spans. Indented `//` lines continue the meaning. Generation fails when an
// example does not parse to its `<form>`, or a form the grammar returns has
// no `@form` line, so the docs cannot describe a form the parser reads
// differently. `url` and `search` never reach the grammar: Sentry URLs and
// text with spaces are taken apart before it.
//
// @form numeric `<numeric-id>` `123456789` — The issue's numeric ID
// @form short-id `<project>-<suffix>` `cli-G` — A short ID, as shown in
//   Sentry. A project alias from `sentry issue list` works in place of the
//   project (`e-4Y`). Otherwise the project is looked up in the default
//   organization, or in every accessible organization
// @form suffix `<suffix>` `G` — The suffix of a short ID, in the
//   auto-detected project
// @form org-short-id `<org>/<project>-<suffix>` `my-org/cli-G` — A short ID
//   in that organization
// @form org-project-id `<org>/<project>/<id>` `my-org/cli/CLI-G` — An issue
//   in that project. `<id>` is a short ID, its suffix, or a numeric ID
// @form org-numeric `<org>/<numeric-id>` `my-org/123456789` — A numeric ID
//   in that organization
// @form org-suffix `<org>/<suffix>` `my-org/G` — Always fails: it names no
//   project. Use `<org>/<project>-<suffix>` or `<org>/<project>/<suffix>`
// @form hash `[<org>/]<project>#<id>` `my-org/cli#CLI-G` — GitHub-style:
//   `<org>/<project>#<id>` is the same as `<org>/<project>/<id>`,
//   `<project>#<id>` as `<project>:<id>`, and `#<id>` as `<id>`
// @form project-id `<project>:<id>` `cli:CLI-G` — An issue in that project.
//   `<id>` is a short ID, its suffix, or a numeric ID
// @form selector `[<org>/]@<selector>` `@latest` — The top issue in the
//   organization: `@latest` (most recent) or `@most_frequent`
// @form url `https://<org>.sentry.io/issues/<id>/`
//   `https://my-org.sentry.io/issues/123456789/` — An issue URL or share link
//   copied from Sentry
// @form search `<text with spaces>` `login timeout` — The one issue in the
//   organization whose search matches the text. Quote it in the shell
//
// `pnpm run generate:grammar` compiles it, with the types in
// issue-argument.d.ts, into the gitignored src/generated/.
//
// `parseIssueArgument()` (src/lib/issue-arguments.ts) hands it one line,
// trimmed and not empty; Sentry URLs never get here. The grammar only splits
// the argument into its parts: it accepts any input and never throws, and
// returns `invalid` for a malformed one. The caller validates characters,
// normalizes case, and turns the parts into a `ParsedIssueArg`. It parses
// the parts of a `#` form again, without the `#`.

{
  const { isSelector } = options;

  function invalid(reason) {
    return { form: "invalid", reason };
  }
}

argument
  = selector
  / hash
  / plain

// `[<org>/]@<selector>`: the org is everything before the first slash
selector
  = o:$[^/]* "/" s:$.+ end &{ return isSelector(s); }
    { return { form: "selector", org: o, selector: s }; }
  / s:$.+ end &{ return isSelector(s); } { return { form: "selector", selector: s }; }

// `[<prefix>]#<fragment>`, split at the first `#`; the caller validates both
// and parses them again
hash
  = p:$[^#]* "#" f:$.* end { return { form: "hash", prefix: p, fragment: f }; }

// Anything else. A slash takes precedence over a dash, so `my-org/123` names
// org `my-org`, not project `my`.
plain
  = i:digits end { return { form: "numeric", id: i }; }
  // Both parts non-empty, and no slash in either; else it is no colon form
  / p:$[^:/]+ ":" i:$[^/]+ end { return { form: "project-id", project: p, id: i }; }
  / path
  / shortId
  / s:$.+ end { return { form: "suffix", suffix: s }; }

// `<org>/<rest>`, split at the first slash
path
  // `<org>/` (or `/`) without an ID
  = [^/]* "/" end { return invalid("missing-id"); }
  // `/<rest>`: no org, so the project is found or detected
  / "/" @shortId
  / "/" s:$.+ end { return { form: "suffix", suffix: s }; }
  / o:$[^/]+ "/" r:orgRest { return r.form === "invalid" ? r : { org: o, ...r }; }

// What follows `<org>/`
orgRest
  = i:digits end { return { form: "org-numeric", id: i }; }
  / p:$[^/]* "/" r:$.* end {
      if (p === "" || r === "") {
        return invalid("missing-project-or-id");
      }
      // `<org>/<project>/<numeric-id>`: the project is redundant
      if (/^[0-9]+$/.test(r)) {
        return { form: "org-numeric", id: r };
      }
      return { form: "org-project-id", project: p, id: r };
    }
  / p:lastDashPrefix "-" s:$[^-]* end {
      if (p === "") {
        return invalid("slash-before-suffix");
      }
      if (s === "") {
        return invalid("missing-suffix");
      }
      return { form: "org-short-id", project: p, suffix: s };
    }
  / s:$.+ end { return { form: "org-suffix", suffix: s }; }

// `<project>-<suffix>`, split at the last dash
shortId
  = p:lastDashPrefix "-" s:$[^-]* end {
      if (p === "") {
        return invalid("missing-project");
      }
      if (s === "") {
        return invalid("missing-suffix");
      }
      return { form: "short-id", project: p, suffix: s };
    }

// Everything before the last dash
lastDashPrefix = $(!("-" [^-]* end) .)*

digits = $[0-9]+

end = !.
