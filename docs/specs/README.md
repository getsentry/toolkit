# Feature Specifications

This directory contains detailed specifications for features in the Sentry MCP
server. Each spec should live in a single Markdown file under `docs/specs/`.

## Specs

- [Agent Conversations](ai-conversations.md)
- [Alert Inspection and Editing](alert-rules.md)
- [Embedded Agent OpenAI Routing](embedded-agent-openai-routing.md)
- [External Issue Linking](issue-linking.md)
- [Project Management Tools](project-management.md)
- [Remembered OAuth Skill Defaults](remembered-oauth-skills.md)
- [Search Events](search-events.md)
- [Sentry-Bearer Cloudflare Auth](sentry-bearer-cloudflare-auth.md)
- [Subpath Constraints](subpath-constraints.md)

## Purpose

Feature specifications serve to:

1. **Document Design Decisions**: Capture the reasoning behind architectural choices
2. **Define Interfaces**: Specify tool inputs, outputs, and behavior
3. **Guide Implementation**: Provide clear direction for developers
4. **Enable Review**: Allow stakeholders to review and provide feedback
5. **Preserve Knowledge**: Maintain historical context for future reference

## Creating New Specifications

When adding a new feature specification:

1. Create a new Markdown file under `specs/` with a descriptive name
2. Keep the spec in a **single, concise `.md` file** that covers:
   - Problem statement and motivation
   - High-level design approach
   - Interface definitions (with code examples)
   - Key constraints and requirements
   - Migration/compatibility concerns
3. Link to the spec from relevant documentation when there is a natural place
   to reference it

**Important Guidelines**:
- Keep specs in a single file under `docs/specs/`
- Focus on WHAT and WHY, not HOW
- Include code examples for interfaces and usage
- Document constraints and meta concerns
- Avoid implementation details (no function internals, prompts, etc.)
- Think "contract" not "blueprint"

## Specification Template

For consistency, new specifications should include:

1. **Overview**: Problem statement and proposed solution
2. **Motivation**: Why this feature is needed
3. **Design**: Technical architecture and approach
4. **Interface**: API/tool definitions
5. **Examples**: Usage scenarios and expected behavior
6. **Implementation**: Step-by-step plan (NO time estimates)
7. **Testing**: Validation strategy
8. **Migration**: If replacing existing functionality
9. **Future Work**: Potential enhancements

**Important**: Do NOT include time windows, deadlines, or duration estimates in specifications. Implementation timing is determined by agents and project priorities, not by the spec.

## Review Process

1. Create specification documents in a feature branch
2. Open PR for review by team members
3. Address feedback and iterate
4. Merge once consensus is reached
5. Update status as implementation progresses
