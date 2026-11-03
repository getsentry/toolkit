## Field selection

With `trace view --json --fields`, summary fields such as `traceId` and
`duration` select trace metadata. Bare attribute names such as `http.method`
request that attribute on every span and return it under each span's
`additional_attributes`. The output retains `span_id` and `children` so that
attributes on nested spans stay connected to the trace. Include summary fields
explicitly when you need them.

Selecting `spans` keeps the full span tree, including any requested attributes.
Paths starting with `spans.` select the corresponding JSON structure. They do
not implicitly recurse into `children`; include `children` in the path to
select that level. Attribute names keep their literal dots in the output.
To request an attribute whose name starts with `spans.`, use its full path,
such as `spans.additional_attributes.spans.foo`.
