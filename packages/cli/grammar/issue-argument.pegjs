// Grammar for one argument that names an issue, for `issue view`, `issue
// explain`, and every other command that takes one:
//
//   <numeric-id>                  123456789
//   [<org>/]@<selector>           @latest, my-org/@most_frequent
//   <project>-<suffix>            cli-G, spotlight-electron-4Y (the project
//                                 is found in any org)
//   <suffix>                      G (the project is auto-detected)
//   <project>:<id>                CLI:CLI-G, CLI:123456789
//   [<org>/]<project>#<id>        GitHub-style: my-org/cli#CLI-G, #CLI-G
//   <org>/<numeric-id>            my-org/123456789
//   <org>/<project>-<suffix>      my-org/cli-G
//   <org>/<suffix>                my-org/G (no project: always an error)
//   <org>/<project>/<id>          my-org/cli/G, my-org/cli/CLI-G,
//                                 my-org/cli/123456789
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
