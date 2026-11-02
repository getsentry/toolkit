// Grammar for positionals that name IDs and the org/project to look them up
// in. It knows nothing about what kind of ID it parses (trace, span, replay,
// log...): the command says which, through the `isId` and `idUrl` hooks in
// `options`, so every ID-taking command shares one syntax:
//
//   <id>                          the org/project is auto-detected
//   <org>/<id>                    like a URL: the org, then the ID (the
//                                 caller may read `<org>` as a project)
//   <org>/<project>/<id>
//   <target> <id>                 any org/project target, as everywhere else
//   <id> <org>/<project>          reversed; the caller warns
//   <id-url>                      a Sentry URL with the ID in it
//
// More IDs may follow any of these, each repeating the target or not
// (`<target>/<id>`). The ID is always the last path segment, and slashes
// pasted after it are ignored.
//
// A kind may also name an item without its ID (`options.names`), such as a
// dashboard by its title. Then anything that is not an ID is a name rather
// than a target or a malformed ID:
//
//   <name>                        one token that is no `[<target>/]<id>`,
//                                 slashes and all
//   <target> <name>               after a target; the name takes all the
//                                 tokens left, joined with spaces
//
// A token after a target is an ID when the kind says it is one, or may be
// one; the rest of the tokens are then IDs too. A kind whose IDs carry their
// own org, project, and URL syntax (`options.wholeIds`, such as issue short
// IDs) has its IDs as whole tokens, for the kind to take apart.
//
// `pnpm run generate:grammar` compiles it, with the types in
// id-arguments.d.ts, into the gitignored src/generated/; the build,
// typecheck, and test scripts run it.
//
// `parseIdArguments()` (src/lib/id-arguments.ts) splits the arguments into
// tokens first and puts a NUL, which no argument contains, before each one.
// No token is empty. The grammar only decides which token is the target and
// which are IDs; it accepts any input and never throws. The caller counts
// the IDs, validates them, and parses the target like any org/project target.

{
  const { optional, isId, mayBeId, idUrl, names, wholeIds } = options;

  // Whether a token is, or may be, an ID rather than a name
  function idLike(value) {
    return isId(value) || mayBeId(value);
  }

  // `[<org>/[<project>/]]` before an ID; the caller makes it a target
  function pathTarget(prefix) {
    if (prefix === "") {
      return {};
    }
    return { target: prefix, path: true };
  }
}

// Peggy runs a rule's action as soon as that rule matches, even when the
// enclosing alternative fails later and the parser backtracks. Every action
// here only builds values, and the hooks are pure, so that is harmless.

arguments
  = end { return { ids: [] }; }
  // A Sentry URL with the ID in it
  / sep u:urlWithId x:more {
      return {
        ...(u.org && { target: `${u.org}/` }),
        ids: [{ text: u.id, id: u.id }, ...x],
        ...(u.baseUrl && { baseUrl: u.baseUrl }),
      };
    }
  / &{ return names; } @namedArguments
  // Any other URL is a target
  / sep t:url x:more { return { target: t, ids: x }; }
  // `<id> <org>/<project> [<id>...]`: the arguments are reversed. When IDs
  // are optional, only a real ID can come first.
  / sep i:segment &{ return !optional || isId(i); } sep !idPath
    t:$([^/\0]* "/" [^\0]*) x:more
    { return { target: t, ids: [{ text: i, id: i }, ...x], reversed: true }; }
  // `[<org>/[<project>/]]<id> [<id>...]`
  / sep p:idPath x:more {
      return {
        ...pathTarget(p.target ?? ""),
        ids: [{ text: p.text, id: p.id }, ...x],
      };
    }
  // One token that does not end in an ID. Unless IDs are optional, it still
  // names one, so it can be reported or recovered: the last segment after
  // two slashes (`<org>/<project>/<id>`), after one when it looks like a
  // malformed ID (`<org>/<partial-id>`), or the whole token. Otherwise,
  // `<org>/<project>` is a target without an ID.
  / sep t:segment "/" i:segment end &{ return !optional && mayBeId(i); }
    { return { ...pathTarget(t), ids: [{ text: text().slice(1), id: i }] }; }
  / sep !"/" t:$(segment "/" segment "/" [^\0]*) end &{ return !optional; } {
      const slash = t.lastIndexOf("/");
      return {
        ...pathTarget(t.slice(0, slash)),
        ids: [{ text: t, id: t.slice(slash + 1) }],
      };
    }
  / sep i:segment end &{ return !optional; } { return { ids: [{ text: i, id: i }] }; }
  // `<target> [<id>...]`
  / sep t:token x:more { return { target: t, ids: x }; }

// The arguments of a kind with names. A name is never a malformed ID: what
// may be an ID is one.
namedArguments
  // An ID with its own syntax: the whole token, and whole tokens after it
  = &{ return wholeIds; } sep i:token &{ return idLike(i); }
    x:(sep t:token { return { text: t, id: t }; })*
    { return { ids: [{ text: i, id: i }, ...x] }; }
  // Any other URL is a target
  / sep t:url n:afterTarget { return { target: t, ...n }; }
  // `<id> <org>/<project> [<id>...]`: reversed; only a real ID can come
  // first
  / !{ return wholeIds; } sep i:segment &{ return isId(i); } sep !idPath
    t:$([^/\0]* "/" [^\0]*) x:more
    { return { target: t, ids: [{ text: i, id: i }, ...x], reversed: true }; }
  // `[<org>/[<project>/]]<id> [<id>...]`, with slugs before the ID: a
  // name may hold slashes too (`Latency/p95`, `Errors.v2/2026`)
  / !{ return wholeIds; } sep p:slugPath x:more {
      return {
        ...pathTarget(p.target ?? ""),
        ids: [{ text: p.text, id: p.id }, ...x],
      };
    }
  // Anything else in one token is a name, slashes and all
  / sep n:token end { return { ids: [], name: n }; }
  // `<target> <id> [<id>...]` or `<target> <name>`; a bare word as the
  // target may instead be the name's first word, which the caller can
  // check once it knows what the word names
  / sep t:token n:afterTarget {
      return {
        target: t,
        ...n,
        ...(n.name !== undefined && !t.includes("/") && { bareTarget: true }),
      };
    }

// What follows a target: IDs, when the first token is or may be one, or a
// name, which takes every token left.
afterTarget
  = end { return { ids: [] }; }
  / &(sep i:token &{ return idLike(i); }) x:more { return { ids: x }; }
  / x:(sep @token)+ { return { ids: [], name: x.join(" ") }; }

// The IDs after the first token. Each may repeat the target:
// `<target>/<id>`.
more
  = (sep @(idPath / t:token { return { text: t, id: t }; }))*

// `[<target>/]<id>` in one token: the last segment is an ID, maybe with
// slashes pasted after it.
idPath
  = t:$(!("/" idSegment argEnd) [^\0])* "/" i:idSegment argEnd
    { return { text: text(), target: t, id: i }; }
  / i:idSegment argEnd { return { text: text(), id: i }; }

// `[<org>/[<project>/]]<id>` in one token, where the org and project are
// slugs
slugPath
  = t:$(slug "/" slug) "/" i:idSegment argEnd
    { return { text: text(), target: t, id: i }; }
  / t:slug "/" i:idSegment argEnd { return { text: text(), target: t, id: i }; }
  / i:idSegment argEnd { return { text: text(), id: i }; }

slug = $[a-zA-Z0-9_-]+

// An ID, and the slashes after it
idSegment
  = i:segment "/"* &{ return isId(i); } { return i; }

// A Sentry URL carrying the ID
urlWithId
  = u:token &{ return idUrl(u) !== null; } { return idUrl(u); }

url
  = $("http" "s"? "://" [^\0]*)

token = $[^\0]+

segment = $[^/\0]+

sep = "\0"

argEnd = &sep / end

end = !.
