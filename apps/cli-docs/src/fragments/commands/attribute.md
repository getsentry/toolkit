

## Using Attribute Keys

Attributes are the typed key-value data attached to spans, logs, and metric samples. Their keys can be passed to other commands like `explore` to filter, add columns, or group results.

Custom non-string attributes include their type in the key, e.g. `tags[cart.total,number]`. Search for the name (`cart.total`), then use the returned key in queries and fields. Quote these keys in the shell.

The endpoint returns discovery candidates, including built-in and virtual keys even when no matching item was observed. It does not provide an exhaustive inventory or proof that every candidate co-occurs with the `has:` keys.
