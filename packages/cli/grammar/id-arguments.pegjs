// Grammar for positionals that end in an ID, where what an argument means
// depends on how many were given: `[<org>/[<project>/]]<id>` in one
// argument, `<target> <id>` in two, or a Sentry URL.
// `pnpm run generate:grammar` compiles it, with the types in
// id-arguments.d.ts, into the gitignored src/generated/; the build,
// typecheck, and test scripts run it.
//
// `parseIdArguments()` (src/lib/id-arguments.ts) parses every argument at
// once: each one is trimmed and follows a NUL, which no command-line argument
// contains. So no arguments is the empty input, and `[""]` is "\0". The
// grammar decides which argument is the ID and which is its target. ID checks
// and errors go through the `isId`, `id`, `sentryUrl`, `missing`, and
// `invalid` hooks in `options`, so they match the rest of the CLI. The result
// names the parts of the target (`IdArguments`); the caller turns them into
// a trace or org/project target.
//
// Start rules:
// - `trace`: trace view, trace logs, and span list in trace mode
// - `tracePath`: one argument and no URL (the trace part of span view's)
// - `traceOrProject`: log list and span list, which list a project's items
//   or a trace's
// - `replay`: replay view and replay download

{
  const { usageHint, isId, id, sentryUrl, missing, invalid } = options;

  const NO_SCOPE = { type: "none" };

  // The parse is the same every time; a predicate and the action after it
  // can both ask
  const urls = new Map();
  function url(value) {
    if (!urls.has(value)) {
      urls.set(value, sentryUrl(value));
    }
    return urls.get(value);
  }

  function ignored(extra) {
    return extra.length > 0
      ? [`Extra arguments ignored: ${extra.join(" ")}. Expected: ${usageHint}`]
      : [];
  }

  // `[<org>/[<project>/]]<id>`, as split by `idPath`. Without the ID, the ID
  // is missing; with an empty `<org>` or `<project>`, the path is invalid.
  function fromPath(path, warnings = []) {
    if (path.id === "" && (path.root || path.org !== undefined)) {
      missing();
    }
    const value = id(path.id);
    if (path.org === undefined) {
      return { id: value, scope: NO_SCOPE, warnings };
    }
    if (path.project === undefined) {
      return { id: value, scope: { type: "org", org: path.org }, warnings };
    }
    if (path.org === "" || path.project === "") {
      invalid(
        `Invalid format: "${path.text}" needs an organization and a project before the ID.\n\nUsage: ${usageHint}`,
        "positional",
      );
    }
    const { org, project } = path;
    return { id: value, scope: { type: "org-project", org, project }, warnings };
  }

  // `<target> <id>`; the caller parses the target
  function fromTarget(target, value, warnings = []) {
    return { id: id(value), scope: { type: "target", target }, warnings };
  }

  // A Sentry URL with the ID in it
  function fromUrl(parsed, value) {
    return {
      id: id(value),
      scope: parsed.org ? { type: "org", org: parsed.org } : NO_SCOPE,
      baseUrl: parsed.baseUrl,
      warnings: [],
    };
  }

  function traceMode(trace) {
    return { mode: "trace", trace };
  }
}

// Peggy runs a rule's action as soon as that rule matches, even when the
// enclosing alternative fails later and the parser backtracks. The rules
// below the start rules therefore only capture text, and the hooks that
// throw run in the action of the start rule alternative that wins.

// `[<org>/[<project>/]]<trace-id>`, `<target> <trace-id>`, or a trace URL.
// Arguments after those are ignored with a warning, or silently after a URL
// (which may be followed by what the browser's address bar had around it).
// A first argument that ends in a trace ID is never a target.
trace
  = u:traceUrl arg* { return fromUrl(u, u.traceId); }
  / sep p:idPath x:arg* &{ return x.length === 0 || isId(p.id); }
    { return fromPath(p, ignored(x)); }
  / t:arg i:arg x:arg* { return fromTarget(t, i, ignored(x)); }
  / end { missing(); }

// `[<org>/[<project>/]]<trace-id>` in one argument
tracePath
  = sep p:idPath end { return fromPath(p); }

// A trace's items when the arguments end in a trace ID or are a trace URL,
// otherwise a project's (`target` is the first argument, if any).
traceOrProject
  = end { return { mode: "project" }; }
  / u:traceUrl arg* { return traceMode(fromUrl(u, u.traceId)); }
  // `[<org>/[<project>/]]<trace-id>`, before a trailing trace ID is read
  // as the trace's
  / sep p:idPath x:arg* &{ return isId(p.id); }
    { return traceMode(fromPath(p, ignored(x))); }
  // `<target> <trace-id>`
  / t:arg x:(!lastArg @arg)* i:lastArg &{ return isId(i); }
    { return traceMode(fromTarget(t, i, ignored(x))); }
  / t:arg arg* { return { mode: "project", target: t }; }

// `[<org>/[<project>/]]<replay-id>`, `<target> <replay-id>`, or a replay URL
replay
  = end { missing(); }
  / a:arg|3..| {
      invalid(
        `Too many positional arguments (got ${a.length}, expected at most 2).\n\nUsage: ${usageHint}`,
        "positional",
      );
    }
  / sep end { missing(); }
  / u:arg &{ return url(u) !== null; } arg? end {
      const parsed = url(u);
      if (!(parsed.replayId && parsed.org)) {
        missing([
          "Pass a replay URL: https://sentry.io/organizations/{org}/explore/replays/{replayId}/",
        ]);
      }
      return fromUrl(parsed, parsed.replayId);
    }
  // `<org>/<project>` without the replay ID
  / sep p:idPath end
    &{ return p.org !== undefined && p.project === undefined && !isId(p.id); }
    { missing(); }
  / sep p:idPath end { return fromPath(p); }
  / arg sep end { missing(); }
  // `<replay-id> <org>/<project>`: the arguments are reversed
  / sep i:$[^/\0]+ sep t:$([^/\0]* "/" [^\0]*) end {
      return fromTarget(t, i, [
        `Arguments appear reversed. Interpreting as: ${t} ${i}`,
      ]);
    }
  / t:arg i:arg end { return fromTarget(t, i); }

// A Sentry URL with a trace ID in it
traceUrl
  = u:arg &{ return Boolean(url(u)?.traceId); } { return url(u); }

// `[<org>/[<project>/]]<id>` in one argument. The ID is the last segment,
// even when slashes follow it (pasted from a URL); otherwise a trailing slash
// leaves the ID out. `<org>` is everything before the first slash and
// `<project>` the rest.
idPath
  = i:idSegment argEnd { return { id: i }; }
  / "/" i:idSegment argEnd { return { id: i, root: true }; }
  / o:$[^/\0]+ "/" i:idSegment argEnd { return { id: i, org: o }; }
  / o:$[^/\0]* "/" p:$(!("/" idSegment argEnd) [^\0])* "/" i:idSegment argEnd
    { return { id: i, org: o, project: p, text: text() }; }

// A segment, and the slashes after it when it is an ID
idSegment
  = i:$[^/\0]* s:$"/"* &{ return s === "" || isId(i); } { return i; }

// One argument
arg = sep @$[^\0]*

// The last argument
lastArg = @arg end

sep = "\0"

argEnd = &sep / end

end = !.
