

## Using Attribute Keys

Attributes are the typed key-value data attached to spans, logs, and metric samples. Their keys can be passed to other commands to filter, add columns, or group results:

```bash
# Filter spans that have the attribute
sentry span list my-org/my-project -q 'has:gen_ai.request.model'

# Add the attribute as a column
sentry span list my-org/my-project --fields gen_ai.request.model

# Group a metric by the attribute
sentry explore my-org/ --dataset metrics -m llm.token_usage -F gen_ai.request.model
```

Custom non-string attributes include their type in the key, e.g. `tags[cart.total,number]`. Quote these keys in the shell.
