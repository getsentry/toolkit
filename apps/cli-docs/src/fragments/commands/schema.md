Search the bundled API schema using product concepts or CLI command paths.
Discovery includes summaries, paths, tags, and query parameter values: `logs`
can find Explore's `dataset=logs` as well as feature-flag audit logs. Results
explain their matches and show related CLI commands discovered from command
implementations. A related API does not necessarily reproduce the command's filters,
pagination, or transformations.

Use `sentry help <command>` for CLI flags and usage examples. Schema describes
API operations and parameters for constructing requests with `sentry api`.

Use an exact operation ID, SDK function name, or HTTP method and path for a
precise lookup. Concept searches return all matching candidates; deprecated
operations are marked and sorted after active ones. No endpoint is chosen just
because it appears first in the catalog.

With `--json`, discovery returns an array of endpoints with additive `match`
metadata. Exact single-endpoint lookups remain endpoint objects, `--search`
always returns an array, and `--all` returns the flat catalog without match
metadata. The schema is bundled from the CLI's SDK version and works offline.
