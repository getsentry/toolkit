

## Examples

### List attributes

```bash
# List span attribute keys for a project
sentry attribute list my-org/my-project

# List log attribute keys across the whole organization
sentry attribute list my-org/ --dataset logs

# Find keys containing "http" that are also of type string
sentry attribute list --search http --type string

# Attributes seen on the same spans as the specified attribute
sentry attribute list --with gen_ai.request.model

# Add descriptions, example values, and deprecation info
sentry attribute list --search http --context

# Show more than the default 25
sentry attribute list my-org/my-project -n 100

# Select fields as JSON
sentry attribute list --json --fields key,type,source
```
