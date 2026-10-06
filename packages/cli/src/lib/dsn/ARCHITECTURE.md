# DSN Detection Module

This module detects Sentry DSN from various sources in a project directory.

## Overview

The DSN detection module provides automatic project detection for the Sentry CLI.
It finds DSNs from source code, environment files, and environment variables,
with intelligent caching for performance.

## Architecture

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              Public API                                      │
│                            (index.ts)                                        │
├─────────────────────────────────────────────────────────────────────────────┤
│  detectDsn()        - Cached single DSN detection                           │
│  detectAllDsns()    - Multi-DSN detection for monorepos                     │
│  resolveProject()   - DSN → org/project resolution                          │
└─────────────────────────────────────────────────────────────────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │   env.ts    │ │ env-file.ts │ │ languages/  │
            │  (env var)  │ │ (.env files)│ │(source code)│
            └─────────────┘ └─────────────┘ └─────────────┘
                    │               │               │
                    └───────────────┴───────────────┘
                                    │
                                    ▼
                          ┌─────────────────┐
                          │   scanner.ts    │
                          │ (shared utils)  │
                          └─────────────────┘
                                    │
                    ┌───────────────┼───────────────┐
                    ▼               ▼               ▼
            ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
            │  parser.ts  │ │  cache.ts   │ │  types.ts   │
            │ (DSN parse) │ │ (caching)   │ │ (types)     │
            └─────────────┘ └─────────────┘ └─────────────┘
```

## Detection Priority

DSNs are detected in this priority order (highest first):

1. **Source code** - Explicit DSN in `Sentry.init()` calls
2. **Environment files** - `.env.local`, `.env`, etc.
3. **Environment variable** - `SENTRY_DSN`

## Files

| File | Purpose |
|------|---------|
| `index.ts` | Public API - re-exports for clean imports |
| `types.ts` | All TypeScript types and Zod schemas |
| `detector.ts` | Main detection orchestration with caching |
| `scanner.ts` | Shared file scanning utilities |
| `parser.ts` | DSN string parsing and validation |
| `cache.ts` | Cache read/write to config file |
| `resolver.ts` | DSN → org/project via Sentry API |
| `errors.ts` | User-friendly error messages |
| `env.ts` | `SENTRY_DSN` env var detection |
| `env-file.ts` | `.env` file detection + monorepo scanning |
| `languages/` | Language-specific code detectors |

## Adding a New Language Detector

1. Create `languages/{lang}.ts`:

```typescript
import type { LanguageDetector } from "./types.js";

const DSN_PATTERN = /your_regex_here/;

export function extractDsnFromLang(content: string): string | null {
  const match = content.match(DSN_PATTERN);
  return match?.[1] ?? null;
}

export const langDetector: LanguageDetector = {
  name: "Language Name",
  extensions: [".ext"],
  skipDirs: ["vendor", "cache"],
  extractDsn: extractDsnFromLang,
};
```

2. Register in `languages/index.ts`:

```typescript
import { langDetector } from "./lang.js";

export const languageDetectors: LanguageDetector[] = [
  // ... existing detectors
  langDetector,
];
```

3. Add tests in `test/lib/dsn/languages/{lang}.test.ts`

## Adding a New Detection Source

1. Create the source file (e.g., `config-file.ts`)
2. Implement detection function returning `DetectedDsn | null`
3. Add to detection chain in `detector.ts`
4. Update `DsnSource` type in `types.ts`
5. Update `getDsnSourceDescription()` in `detector.ts`

## Caching Strategy

The module uses a two-level caching strategy:

1. **DSN Cache** - Stores detected DSN and source location per directory
2. **Project Cache** - Stores resolved org/project info per DSN

Cache invalidation:
- DSN cache is verified by re-reading the source file
- If DSN changed, cache is updated
- If file deleted, full scan is triggered

## Monorepo Support

The module detects DSNs in monorepo structures:

- Scans `packages/*/`, `apps/*/`, `libs/*/`, etc.
- Each package/app can have its own DSN
- `detectAllDsns()` returns all found DSNs
- `packagePath` field tracks which package a DSN belongs to

## Testing

```bash
# Run DSN-related tests
bun test test/lib/dsn

# Run specific test file
bun test test/lib/dsn/detector.test.ts
```

## Performance

- **Fast path (cache hit)**: ~5ms - reads single file to verify
- **Slow path (cache miss)**: ~2-5s - full glob scan
- Skip directories are applied to avoid scanning `node_modules`, etc.
