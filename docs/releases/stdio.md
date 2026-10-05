# stdio Release

npm package release process for the MCP server stdio transport.

## Overview

The MCP server is published to npm as `@sentry/mcp-server` for use with:
- Claude Desktop
- Cursor IDE
- VS Code with MCP extension
- Other MCP clients supporting stdio transport

## Package Structure

Published package includes:
- Compiled TypeScript (`dist/`)
- stdio transport implementation
- Type definitions
- Tool definitions

## Release Process

### 1. Version Bump

Update version in `packages/mcp-server/package.json`:

```json
{
  "name": "@sentry/mcp-server",
  "version": "1.2.3"
}
```

Follow semantic versioning:
- **Major**: Breaking changes to tool interfaces
- **Minor**: New tools or non-breaking features
- **Patch**: Bug fixes

### 2. Update Changelog

Document changes in `CHANGELOG.md`:

```markdown
## [1.2.3] - 2025-01-16

### Added
- New `search_docs` tool for documentation search

### Fixed
- Fix context propagation in tool handlers
```

### 3. Quality Checks

**MANDATORY before publishing:**

```bash
pnpm -w run lint:fix    # Fix linting issues
pnpm tsc --noEmit       # TypeScript type checking
pnpm test               # Run all tests
pnpm run build          # Ensure clean build
```

All checks must pass.

### 4. Publish to npm

```bash
cd packages/mcp-server

# Dry run to verify package contents
npm publish --dry-run

# Publish to npm
npm publish
```

### 5. Tag Release

```bash
git tag v1.2.3
git push origin v1.2.3
```

## MCP Registry

The **Publish MCP Registry** workflow publishes `server.json` on stable GitHub
releases using GitHub Actions OIDC; no registry secret is needed. It reads the
manifest from `main` and sets both versions from the release, so there is no
extra version bump to maintain. The listing includes npm and the hosted endpoint.

Craft publishes GitHub before npm. The workflow waits for the npm package before
publishing the listing. Check this Actions run separately from the Craft release.
To retry or publish an existing release after merging the workflow:

```bash
gh workflow run mcp-registry.yml --repo getsentry/sentry-mcp --ref main -f version=0.40.0
```

An identical active listing is safe to rerun. Different metadata for an existing
version fails verification because registry versions are immutable; publish those
changes with the next release. Registry failures do not undo the npm release.

## User Installation

Users install via npx in their MCP client configuration:

### Claude Desktop

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "sntrys_...",
        "SENTRY_HOST": "sentry.io"
      }
    }
  }
}
```

Config location:
- **macOS**: `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows**: `%APPDATA%\Claude\claude_desktop_config.json`

### Cursor IDE

Add to `.cursor/mcp.json`:

```json
{
  "mcpServers": {
    "sentry": {
      "command": "npx",
      "args": ["-y", "@sentry/mcp-server"],
      "env": {
        "SENTRY_ACCESS_TOKEN": "sntrys_...",
        "SENTRY_HOST": "sentry.io"
      }
    }
  }
}
```

## Environment Variables

Required:
- `SENTRY_ACCESS_TOKEN` - Sentry API access token
- `SENTRY_HOST` - Sentry instance hostname (default: `sentry.io`)

Optional:
- `SENTRY_ORG` - Default organization slug
- `SENTRY_PROJECT` - Default project slug
- `MCP_DISABLE_SKILLS` - Disable specific skills, comma-separated (e.g. `seer`)

## Version Pinning

Users can pin to specific versions:

```json
{
  "args": ["-y", "@sentry/mcp-server@1.2.3"]
}
```

## Testing Releases

### Local Testing Before Publishing

Test the built package locally:

```bash
cd packages/mcp-server
npm pack
# Creates sentry-mcp-server-1.2.3.tgz

# Test installation
npm install -g ./sentry-mcp-server-1.2.3.tgz

# Run stdio server
SENTRY_ACCESS_TOKEN=... @sentry/mcp-server
```

### Beta Releases

For testing with users before stable release:

```bash
npm publish --tag beta
```

Users install with:
```json
{
  "args": ["-y", "@sentry/mcp-server@beta"]
}
```

## Troubleshooting

### Package Not Found
- Verify package name: `@sentry/mcp-server` (with scope)
- Check npm registry: `npm view @sentry/mcp-server`

### Version Mismatch
- Users may have cached version: `npx clear-npx-cache`
- Recommend version pinning for stability

### Build Failures
- Ensure `pnpm run build` succeeds before publishing
- Check TypeScript compilation errors
- Verify all dependencies are listed in package.json

## References

- Package config: `packages/mcp-server/package.json`
- stdio transport: `packages/mcp-server/src/transports/stdio.ts`
- Build script: `packages/mcp-server/scripts/build.ts`
- npm publishing docs: https://docs.npmjs.com/cli/publish
