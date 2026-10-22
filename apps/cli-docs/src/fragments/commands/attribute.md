

## Examples

### List attributes

```bash
# List span attribute keys for a project
sentry attribute list my-org/my-project

# List log attribute keys across the whole organization
sentry attribute list my-org/ --dataset logs

# Find keys containing "gen_ai" that are also of type string
sentry attribute list --search gen_ai --type string

# Attributes seen on the same spans as the specified attribute
sentry attribute list --with gen_ai.request.model

# Show descriptions, example values, and deprecation info
sentry attribute list --context

# Show more than the default 25
sentry attribute list my-org/my-project -n 100

# Select fields as JSON
sentry attribute list --json --fields key,type,source
```

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
