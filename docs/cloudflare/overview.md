# Cloudflare Web Chat Application

This directory contains documentation for the Cloudflare-hosted web chat application that **uses** the Sentry MCP server.

## Important: This is NOT part of MCP

The Cloudflare chat application (`packages/mcp-cloudflare`) is a **separate web application** that demonstrates how to build a chat interface using MCP. It is not part of the MCP protocol or server itself.

Think of it as:

- **MCP Server**: The backend service that provides Sentry functionality via the Model Context Protocol
- **Cloudflare Chat**: A frontend web app (like ChatGPT) that connects to and uses the MCP server

## What This Application Provides

- Web-based chat UI with OAuth authentication
- AI-powered assistant using OpenAI's GPT-4
- Integration with Sentry MCP tools via HTTP transport
- Cloudflare Workers deployment for global edge hosting

## Architecture Separation

```
┌─────────────────────────┐     ┌──────────────────────┐
│   Cloudflare Web App    │     │    MCP Server        │
│  (This Documentation)   │     │  (Core MCP Docs)     │
├─────────────────────────┤     ├──────────────────────┤
│ • React Frontend        │     │ • MCP Protocol       │
│ • Chat UI              │ --> │ • Sentry Tools       │
│ • OAuth Flow           │     │                      │
│ • GPT-4 Integration    │     │                      │
└─────────────────────────┘     └──────────────────────┘
        Uses MCP via                 The actual MCP
        HTTP Transport               implementation
```

## Documentation Structure

- Architecture: [Cloudflare Architecture](architecture.md) - Technical architecture of the web application
- OAuth Architecture: [OAuth Architecture](oauth-architecture.md) - OAuth flow and token management
- Chat Interface: [Cloudflare Architecture](architecture.md) - See "Chat Interface" section
- Deployment: [Cloudflare Release](../releases/cloudflare.md) - Deploying to Cloudflare Workers

## Quick Links

- Live deployment: https://mcp.sentry.dev
- Package location: `packages/mcp-cloudflare`
- **For MCP Server docs**: See "Architecture" in [Architecture Overview](../architecture/overview.md)
