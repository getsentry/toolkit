// Grammar for dashboard positionals. Dashboards are org-scoped, so these
// name a dashboard and, optionally, the org to find it in:
//
//   <id-or-title>                 the org is auto-detected
//   <org>/<id>                    like a URL: the org, then a numeric ID
//   <org>/<project>/<id>          the project only selects the org
//   <target> <id-or-title>        any org/project target; a bare `<org>`
//                                 means `<org>/`
//   <dashboard-url>               a Sentry dashboard URL
//   <org-url> <id-or-title>       a Sentry URL with only an org
//
// A title may hold slashes: one argument is `<org>/[<project>/]<id>` only
// when slugs come before a numeric ID, and a title otherwise. Arguments
// after the dashboard are extra.
//
// With `list` (`dashboard list`), they name the org and a title filter:
//
//   (none)                        the org is auto-detected, no filter
//   <filter>                      an argument without a slash
//   <org>/ or <org>/<project>     a target, no filter
//   <org>/<project>/<filter>      a target, then the filter
//   <target> <filter...>          the filter's words may be separate
//                                 arguments
//   <org-url> [<filter...>]       a Sentry URL with only an org
//
// `pnpm run generate:grammar` compiles it, with the types in
// dashboard-arguments.d.ts, into the gitignored src/generated/; the build,
// typecheck, and test scripts run it.
//
// `parseDashboardArgs()` and `parseDashboardListArgs()`
// (src/lib/dashboard-arguments.ts) put a NUL, which no argument contains,
// before each argument. The grammar only decides which argument is what; it
// accepts any input and never throws. The caller reports a missing
// dashboard, turns a URL into warnings, and parses the target like any
// org/project target.

{
  const { list, sentryUrl } = options;

  // A bare argument before the dashboard names an org
  function orgTarget(value) {
    return value.includes("/") ? value : `${value}/`;
  }

  function filter(words) {
    return words.length > 0 ? { filter: words.join(" ") } : {};
  }
}

// Peggy runs a rule's action as soon as that rule matches, even when the
// enclosing alternative fails later and the parser backtracks. Every action
// here only builds values, and `sentryUrl` is pure, so that is harmless.

arguments
  = &{ return list; } @listArguments
  / dashboardArguments

dashboardArguments
  = end { return { extra: [] }; }
  // A dashboard URL; anything after it is extra
  / sep u:dashboardUrl x:rest {
      return {
        ref: u.dashboardId,
        ...(u.org && { target: `${u.org}/` }),
        url: u,
        extra: x,
      };
    }
  // A URL with only an org; the dashboard follows
  / sep u:orgUrl sep r:token x:rest {
      return { ref: r, target: `${u.org}/`, url: u, extra: x };
    }
  / sep u:orgUrl end { return { url: u, extra: [] }; }
  // `<org>/<project>/<id>` and `<org>/<id>`
  / sep o:slug "/" p:slug "/" i:digits end {
      return { ref: i, target: `${o}/${p}`, extra: [] };
    }
  / sep o:slug "/" i:digits end { return { ref: i, target: `${o}/`, extra: [] }; }
  // Anything else in one argument is an ID or a title, slashes and all
  / sep r:token end { return { ref: r, extra: [] }; }
  // `<target> <id-or-title>`
  / sep t:token sep r:token x:rest {
      return { ref: r, target: orgTarget(t), extra: x };
    }

listArguments
  = end { return {}; }
  // A dashboard URL names no list; the caller suggests `dashboard view`
  / sep u:dashboardUrl rest { return { url: u }; }
  / sep u:orgUrl x:rest { return { target: `${u.org}/`, url: u, ...filter(x) }; }
  // `<target> <filter...>`
  / sep t:token x:rest &{ return x.length > 0; } {
      return { target: orgTarget(t), ...filter(x) };
    }
  // `<org>/<project>/<filter>`: the filter is everything after the second
  // slash. With nothing after it, the whole argument is the target.
  / sep t:$([^/\0]* "/" [^/\0]*) "/" f:$[^\0]+ end { return { target: t, filter: f }; }
  / sep t:$([^/\0]* "/" [^\0]*) end { return { target: t }; }
  / sep f:token end { return { filter: f }; }

// The arguments after the ones a form names
rest
  = (sep @token)*

// A Sentry URL naming a dashboard
dashboardUrl
  = u:token &{ return sentryUrl(u)?.dashboardId !== undefined; }
    { return sentryUrl(u); }

// A Sentry URL naming an org but no dashboard
orgUrl
  = u:token &{
      const url = sentryUrl(u);
      return url?.org !== undefined && url.dashboardId === undefined;
    }
    { return sentryUrl(u); }

slug = $[a-zA-Z0-9_-]+

digits = $[0-9]+

// Possibly empty: an empty argument is still one
token = $[^\0]*

sep = "\0"

end = !.
