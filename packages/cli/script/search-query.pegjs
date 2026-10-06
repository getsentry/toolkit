// Simplified Sentry search query grammar for CLI.
//
// Produces a flat list of typed AST nodes for OR→in-list rewriting.
// Derived from the canonical Sentry grammar at:
//   https://github.com/getsentry/sentry/blob/master/static/app/components/searchSyntax/grammar.pegjs
//
// Key simplifications:
// - No TokenConverter or predicate-based filter type classification
// - No aggregate key/function support (not needed for rewriting)
// - No date/duration/size/percentage format parsing (classified as comparison)
// - Structural output only: text | text_in | comparison | free_text | boolean_op | paren_group

search
  = _ head:term tail:(_ term)* _ {
      return [head, ...tail.map(function(t) { return t[1]; })];
    }
  / _ { return []; }

term
  = boolean_op / paren_group / filter / free_text

// ---------------------------------------------------------------------------
// Boolean operators
// ---------------------------------------------------------------------------

boolean_op
  = op:("OR"i / "AND"i) &end_of_value {
      return { type: "boolean_op", op: op.toUpperCase() };
    }

// ---------------------------------------------------------------------------
// Parenthesized groups (opaque to OR rewriter)
// ---------------------------------------------------------------------------

paren_group
  = "(" _ head:term_no_paren tail:(_ term_no_paren)* _ ")" {
      var inner = [head].concat(tail.map(function(t) { return t[1]; }));
      return { type: "paren_group", inner: inner, raw: text() };
    }

term_no_paren
  = boolean_op / filter / free_text

// ---------------------------------------------------------------------------
// Filters: key:value patterns
// ---------------------------------------------------------------------------

// Order matters: try in-list first (starts with [), then comparison
// (starts with operator), then plain text (catch-all).
filter
  = negation:"!"? key:filter_key ":" value:in_list {
      return { type: "text_in_filter", negated: !!negation, key: key, values: value };
    }
  / negation:"!"? key:filter_key ":" op:comparison_op value:filter_value {
      return { type: "comparison_filter", negated: !!negation, key: key, op: op, value: value };
    }
  / negation:"!"? key:filter_key ":" value:filter_value {
      return { type: "text_filter", negated: !!negation, key: key, value: value };
    }

// Keys: alphanumeric, dots, underscores, dashes, brackets (for tags[key])
filter_key
  = chars:[a-zA-Z0-9_.\[\]-]+ { return chars.join(""); }

// ---------------------------------------------------------------------------
// Values
// ---------------------------------------------------------------------------

filter_value
  = quoted_value / plain_value

quoted_value
  = '"' chars:('\\"' / [^"])* '"' {
      return '"' + chars.join("") + '"';
    }

plain_value
  = chars:[^ \t\n()\[\],]+ { return chars.join(""); }

// In-list: [val1,val2,"val 3"]
in_list
  = "[" _ head:in_list_item tail:(_ "," _ in_list_item)* _ "]" {
      return [head].concat(tail.map(function(t) { return t[3]; }));
    }

in_list_item
  = quoted_value / in_list_plain

in_list_plain
  = chars:[^,\] \t\n"]+ { return chars.join(""); }

// Comparison operators (order matters: >= before >, etc.)
comparison_op
  = ">=" / "<=" / ">" / "<" / "=" / "!="

// ---------------------------------------------------------------------------
// Free text (anything that isn't a filter or boolean operator)
//
// Consumes whole words (matching upstream grammar's free_text_unquoted).
// The negative lookaheads check the entire remaining text, not individual
// characters, preventing false matches on substrings like "or" in "error".
// ---------------------------------------------------------------------------

free_text
  = value:quoted_value {
      return { type: "free_text", value: value, quoted: true };
    }
  / !filter !boolean_op value:$[^ \t\n()]+ {
      return { type: "free_text", value: value, quoted: false };
    }

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

_ "whitespace"
  = [ \t]*

end_of_value
  = [ \t\n)] / !.
