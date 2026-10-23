// Grammar for the `[<org>/][<project>[,<project>...]]` target positional.
// `pnpm run generate:grammar` compiles it, with the types in
// org-project-target.d.ts, into the gitignored src/generated/; the build,
// typecheck, and test scripts run it.
//
// `parseOrgProjectArg()` (src/lib/arg-parsing.ts) runs this parser after it
// keeps the first non-blank line and handles the omitted and URL forms. The
// grammar owns the structure; character-level checks go through the
// `checkSlug`, `rejectAt`, and `invalid` hooks in `options`, so its errors
// match the rest of the CLI.
//
// The target syntax tables in the docs are generated from the `@form` lines
// here (script/generate-docs-sections.ts). Every `target` alternative needs
// at least one `@form` line, or `@invalid` when it only rejects input. A
// `@form` line reads `@form <syntax> — <meaning>`, both in Markdown; indented
// `//` lines continue the meaning. The two forms below never reach the
// grammar, so they are listed here:
//
// @form _(omitted)_ — Auto-detect the org and project from config, DSNs, or
//   the directory name
// @form `https://<org>.sentry.io/...` — A Sentry web URL. Selects the org and
//   project in the URL, or the whole organization when it names no project

{
  const { multi = false, checkSlug, rejectAt, invalid } = options;

  function slug(value, label) {
    rejectAt(value, label);
    checkSlug(value, label);
    return value;
  }

  function orgSlug(value) {
    return slug(value, "organization slug");
  }

  function projectSlug(value) {
    return slug(value, "project slug");
  }

  function displayName(value, org) {
    rejectAt(value, "project slug");
    return {
      type: "project-search",
      projectSlug: value,
      originalSlug: value,
      ...(org !== undefined && { org }),
    };
  }

  // Slugs cannot contain commas, so `org/web,api` is unambiguous. Tokens are
  // trimmed, empty ones dropped, and duplicates removed in first-seen order.
  function projectList(org, raw) {
    const tokens = [...new Set(raw.split(",").map((t) => t.trim()))].filter(
      (t) => t !== "",
    );
    if (tokens.length === 0) {
      invalid("Invalid project slug: comma-separated list is empty.", "project");
    }
    if (tokens.some((t) => t.includes(" "))) {
      invalid(
        "Comma-separated project targets must be slugs, not display names.",
        "project",
      );
    }
    const [first, second, ...others] = tokens.map(projectSlug);
    return {
      type: "explicit",
      org,
      project: first,
      ...(second !== undefined && { projects: [first, second, ...others] }),
    };
  }
}

// Peggy runs a rule's action as soon as that rule matches, even when the
// enclosing alternative fails later and the parser backtracks. The token
// rules below therefore only capture text, and validation happens in the
// action of the `target` alternative that wins. Otherwise `@latest` would be
// rejected as an organization slug before it is parsed as a project (covered
// by "@latest throws with redirect to issue view" in arg-parsing.test.ts).
target
  // @form `<org>/<project>` — That project in that organization
  = o:org "/" p:slug !{ return multi && p.includes(","); }
    { const org = orgSlug(o); return { type: "explicit", org, project: projectSlug(p) }; }
  // @form `<org>/<project>,<project>` — Several projects in the same
  //   organization (commands that accept several projects)
  / o:org "/" &{ return multi; } l:list { return projectList(orgSlug(o), l); }
  // @form `<org>/<Project Name>` — A project in that organization whose
  //   display name matches. A target with a space is a name, not a slug
  / o:org "/" p:name { const org = orgSlug(o); return displayName(p, org); }
  // @form `<org>/` — The whole organization
  / o:org "/" !. { return { type: "org-all", org: orgSlug(o) }; }
  // @form `<name>` — A project named `<name>` in any accessible organization.
  //   If no project matches, commands that accept an organization use the
  //   organization named `<name>`. When both exist, the project wins: add the
  //   trailing slash (`<name>/`) to select the organization
  // @form `/<name>` — Same as `<name>`
  / "/"? p:slug { return { type: "project-search", projectSlug: projectSlug(p) }; }
  // @form `<Project Name>` — A project whose display name matches, in any
  //   accessible organization
  / "/"? p:name { return displayName(p); }
  // @invalid
  / "/" !. { invalid('Invalid format: "/" requires a project slug (e.g., "/cli")'); }

// Everything before the first slash.
org = $[^/]+

// The rest of the input when it has no spaces. Slashes, commas, and other
// characters are kept so `checkSlug` reports them.
slug = $([^ ]+ !.)

// The rest of the input when it has a space: a display name.
name = $([^ ]* " " .*)

// The rest of the input when it has a comma: a project list.
list = $([^,]* "," .*)
