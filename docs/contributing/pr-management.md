# Pull Request Management

Guide to Toolkit pull requests, GitHub CLI usage, review feedback, and commits
for CLI, MCP, and shared packages.

## GitHub CLI Usage

### Installation and Setup

```bash
# Install GitHub CLI
brew install gh  # macOS
# or follow instructions at https://cli.github.com/

# Authenticate
gh auth login

# Verify installation
gh auth status
```

### Creating Pull Requests

```bash
# Create PR with title and description
gh pr create --title "feat: add new search functionality" --body "$(cat <<'EOF'
## Summary
- Add natural language search for events
- Implement AI-powered query translation

## Changes
- Added search_events tool with AI integration
- Implemented dataset-specific formatting
- Added comprehensive test coverage
EOF
)"

# Create draft PR
gh pr create --draft --title "WIP: experimental feature"

# Create PR with specific base branch
gh pr create --base main --head feat-better-search
```

### Managing Pull Requests

```bash
# View PR status
gh pr status

# List PRs
gh pr list
gh pr list --state open --author @me

# View specific PR
gh pr view 123
gh pr view https://github.com/getsentry/toolkit/pull/123

# Check CI status
gh pr checks 123

# Merge PR (when ready)
gh pr merge 123 --squash --delete-branch
```

### Reviewing Feedback

```bash
# View PR comments and reviews
gh pr view 123 --comments

# View specific review
gh api repos/getsentry/toolkit/pulls/123/reviews

# List review comments on specific files
gh api repos/getsentry/toolkit/pulls/123/comments
```

## Handling Review Feedback

### Sources of Feedback

1. **Human reviewers** - Team members providing code review
2. **AI agents** (e.g., Cursor, other Claude instances) - Automated suggestions
3. **CI/CD systems** - Build failures, test failures, linting issues
4. **GitHub bots** - Automated security, dependency, or quality checks

### Validation Process

**CRITICAL**: Always verify feedback validity before implementing changes.

#### For Human Review Feedback

- ✅ **Always implement** - Human reviewers understand context and requirements
- ✅ **Ask for clarification** if feedback is unclear
- ✅ **Discuss trade-offs** if you disagree with approach

#### For AI Agent Feedback

- ⚠️ **Verify accuracy** - AI suggestions may be outdated or context-unaware
- ⚠️ **Check compatibility** - Ensure suggestions align with project patterns
- ⚠️ **Test thoroughly** - AI changes can introduce subtle bugs

**Common AI feedback to validate carefully:**

```bash
# AI suggests error handling - verify it's needed
- "Add error handling for JSON.parse"
  → Check if error handling exists elsewhere in call chain

# AI suggests performance optimizations - verify impact
- "Use useMemo for expensive calculations"
  → Measure if optimization is actually needed

# AI suggests refactoring - verify consistency
- "Extract this into a separate function"
  → Check if it follows existing code patterns
```

#### For CI/CD Feedback

- ✅ **Fix immediately** - Build/test failures block progress
- ✅ **Address linting** - Maintains code quality standards
- ✅ **Resolve conflicts** - Required for merge

### Response Workflow

```bash
# 1. Fetch latest comments
gh pr view --comments

# 2. Address each piece of feedback
git checkout feat-better-search
# Make changes...

# 3. Commit with reference to feedback
git commit -m "fix: address review feedback about error handling

Per @reviewer suggestion, add proper error boundaries around
JSON.parse operations in search-events.ts.

Co-Authored-By: Codex CLI Agent <noreply@openai.com>"

# 4. Push and notify
git push
gh pr comment --body "✅ Addressed all review feedback"
```

## Commit Message Structure

### Format Standard

```
<type>(<scope>): <description>

[optional body]

[optional footer]
```

### Types

- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code change that neither fixes a bug nor adds a feature
- `perf`: Performance improvement
- `test`: Adding or modifying tests
- `docs`: Documentation changes
- `style`: Code style changes (formatting, missing semicolons, etc.)
- `chore`: Changes to build process or auxiliary tools

### Scope (optional)

- `server`: MCP server changes
- `client`: Test client changes
- `cloudflare`: Cloudflare Worker changes
- `evals`: Evaluation test changes
- `tools`: Tool-specific changes
- `api`: API client changes

### Examples

```bash
# Feature addition
git commit -m "feat(tools): add natural language search for events

Implement AI-powered query translation using OpenAI GPT-4 to convert
natural language queries into Sentry search syntax. Supports multiple
datasets: errors, logs, and spans.

Co-Authored-By: Codex CLI Agent <noreply@openai.com>"

# Bug fix
git commit -m "fix(evals): update search-events eval to use available exports

Replace missing TaskRunner and Factuality imports with NoOpTaskRunner
and ToolPredictionScorer to resolve CI build failures after factuality
checker removal.

Co-Authored-By: Codex CLI Agent <noreply@openai.com>"

# Refactoring
git commit -m "refactor: move tool test to appropriate directory

Move toolDefinitions.test.ts to tools/ directory and rename to tools.test.ts
to fix circular dependency and improve organization.

Co-Authored-By: Codex CLI Agent <noreply@openai.com>"
```

### AI Attribution

- When assisted by AI, include only a Co-Authored-By footer naming the agent, for example:
  - `Co-Authored-By: Codex CLI Agent <noreply@openai.com>`
  - `Co-Authored-By: Claude Code <noreply@anthropic.com>`

Do not include generator or "Generated with" banners in PR descriptions or commits.

## PR Description Structure

### Focus on Reviewer Needs

**Good PR descriptions help reviewers understand:**

- What problem was solved
- What changes were made
- Why these changes were necessary
- Any potential impact or risks

**Avoid including:**

- Test plans or instructions (CI handles testing)
- Implementation details that are clear from the code
- Line-by-line walkthroughs
- Verbose explanations better suited for documentation

### Template

```markdown
## Summary

<!-- Brief description of what was changed and why -->

Fixes [issue] by [solution approach]. This addresses [problem] and enables [benefit].

### Key Changes

<!-- High-level changes that reviewers should focus on -->

- Fixed [specific issue]: [brief explanation]
- Added [new feature]: [brief explanation]
- Refactored [component]: [brief explanation]

### Breaking Changes

<!-- If any breaking changes -->

- None

<!-- OR -->

- Updated tool interface (see migration guide)

### Dependencies

<!-- Related PRs or external dependencies -->

- Depends on #123
- Requires Sentry API version X.Y
```

### Real Examples

**Good - Concise and reviewer-focused:**

```markdown
## Summary

Fixes search_events tool to properly understand OpenTelemetry semantic conventions and refactors the code into a clean module structure.

### Key Changes

- Fixed semantic understanding: "agent calls" now correctly maps to GenAI conventions (`gen_ai.*`) instead of MCP tool calls
- Refactored 1385-line monolithic file into 8 focused modules with clear responsibilities
- Added dynamic semantic lookup for better attribute disambiguation
```

**Bad - Too verbose with unnecessary details:**

```markdown
## Summary

This PR implements comprehensive improvements to the search_events tool...

### Technical Implementation Details

- Uses OpenAI GPT-4 for natural language processing
- Implements sophisticated caching mechanisms
- Creates extensive test coverage with MSW mocks
- Follows advanced TypeScript patterns

### Test Plan

1. Run `pnpm test` to verify all tests pass
2. Test with various query types:
   - "agent calls" should return GenAI spans
   - "database errors" should return DB-related errors
3. Verify the UI displays results correctly
4. Check that performance remains optimal

### File Structure Changes

- src/tools/search-events.ts → src/tools/catalog/search-events.ts
- Added src/tools/support/search-events/agent.ts for AI logic
- [... detailed file-by-file breakdown ...]
```

## Review Process Workflow

### 1. Pre-Review Checklist

```bash
# Run all quality checks before requesting review
pnpm run tsc     # TypeScript compilation
pnpm run lint    # Code linting
pnpm run test    # Unit tests

# Check git status is clean
git status

# Verify CI passes
gh pr checks
```

### 2. Requesting Review

```bash
# Add specific reviewers
gh pr edit --add-reviewer @username1,@username2

# Add to review by team
gh pr edit --add-reviewer @getsentry/mcp-team

# Mark as ready for review (if draft)
gh pr ready
```

### 3. Responding to Reviews

```bash
# View all feedback
gh pr view --comments

# Address feedback in commits
git add .
git commit -m "fix: address review feedback about validation

Add input validation for natural language queries per @reviewer
suggestion. Ensures minimum length and sanitizes special characters.

Co-Authored-By: Claude <noreply@anthropic.com>"

# Respond to comments
gh pr comment --body "Thanks for the feedback! Fixed the validation issue in latest commit."

# Re-request review after changes
gh pr edit --add-reviewer @username
```

### 4. Final Steps

```bash
# Ensure all checks pass
gh pr checks

# Merge when approved
gh pr merge --squash --delete-branch

# Or merge with detailed commit message
gh pr merge --squash --delete-branch --body "$(cat <<'EOF'
feat: add natural language search for Sentry events

Complete implementation of AI-powered search tool that translates
natural language queries into Sentry search syntax. Supports errors,
logs, and spans datasets with comprehensive field selection.

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```

## Troubleshooting Common Issues

### CI Failures

```bash
# Check specific failure
gh pr checks --watch

# View detailed logs
gh run view <run-id> --log

# Common fixes:
# - TypeScript errors: Fix type issues locally
# - Test failures: Debug with `pnpm test -- --reporter=verbose`
# - Lint errors: Run `pnpm lint --fix`
```

### Merge Conflicts

```bash
# Update branch with latest main
git checkout feat-better-search
git fetch origin
git rebase origin/main

# Resolve conflicts manually, then:
git add .
git rebase --continue
git push --force-with-lease
```

### Review Comments Not Resolving

```bash
# View unresolved comments
gh pr view --comments | grep -A5 -B5 "REQUESTED_CHANGES"

# Ensure you've addressed all feedback:
# 1. Made code changes
# 2. Committed changes
# 3. Pushed to branch
# 4. Responded to comments
```

## Best Practices

### Do's

- ✅ Always verify AI feedback before implementing
- ✅ Write clear, descriptive commit messages
- ✅ Focus PR descriptions on reviewer needs, not test plans
- ✅ Respond promptly to review feedback
- ✅ Run quality checks before pushing
- ✅ Use GitHub CLI for efficient workflow

### Don'ts

- ❌ Never auto-apply AI suggestions without validation
- ❌ Don't commit without running tests locally
- ❌ Don't merge without reviewer approval
- ❌ Don't ignore CI failures
- ❌ Don't force push without `--force-with-lease`

### AI Agent Collaboration

- 🤖 AI agents may suggest improvements via comments
- 🤖 Always evaluate AI suggestions for correctness and fit
- 🤖 Test AI-suggested changes thoroughly
- 🤖 Include AI feedback validation in your review process
