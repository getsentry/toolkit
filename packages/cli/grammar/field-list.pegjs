// Output fields are paths or API expressions, not search filters. Preserve
// their spelling and split only at commas outside balanced groups or quotes.
fields
  = head:field tail:("," field)* {
      return [head, ...tail.map((part) => part[1])].filter(Boolean);
    }

field
  = value:$(part*) { return value.trim(); }

// Unmatched punctuation can be part of a literal JSON key. This grammar
// separates fields without validating the API expressions themselves.
part
  = brackets / parentheses / quoted / [^,]

brackets
  = "[" (brackets / parentheses / quoted / [^()[\]"])* "]"

parentheses
  = "(" (brackets / parentheses / quoted / [^()[\]"])* ")"

quoted
  = '"' ("\\" . / [^"\\])* '"'
