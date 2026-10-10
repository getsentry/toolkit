## Examples

### Ask a documentation question

```bash
sentry docs "How do I configure tracing in Next.js?"
```

The answer includes inline links and a Sources section containing the Sentry
documentation pages used to answer the question.

### Search the documentation index

```bash
sentry docs list "source maps"
```

```
TITLE                    DESCRIPTION                         URL
Source Maps              Upload source maps for JavaScript   https://docs.sentry.io/...
```

Use `--limit` to restrict the number of results or `--json` for structured
output.
