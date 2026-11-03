---
name: testing-guidelines
description: Guide for writing tests. Use when adding new functionality, fixing bugs, or when tests are needed. Emphasizes integration tests, real-world fixtures, and regression coverage.
---

# Testing Guidelines

Follow these principles when writing tests.

## Core Principles

### 1. Mock External Services, Use Real Fixtures

**ALWAYS** mock third-party network services. **ALWAYS** use fixtures based on real-world data.

- Fixtures must be scrubbed of PII (use dummy data like `foo@example.com`, `user-123`)
- Capture real API responses, then sanitize them
- Never make actual network calls in tests

### 2. Prefer Integration Tests Over Unit Tests

Focus on **end-to-end style tests** that validate inputs and outputs, not implementation details.

- Test the public interface, not internal methods
- Unit tests are valuable for edge cases in pure functions, but integration tests are the priority
- If refactoring breaks tests but behavior is unchanged, the tests were too coupled to implementation

### 3. Minimize Edge Case Testing

Don't test every variant of a problem.

- Cover the **common path** thoroughly
- Skip exhaustive input permutations
- Skip unlikely edge cases that add maintenance burden without value
- One representative test per category of input is usually sufficient

### 4. Always Add Regression Tests for Bugs

When a **bug** is identified, **ALWAYS** add a test that would have caught it.

- The test should fail before the fix and pass after
- Name it descriptively to document the bug
- This prevents the same bug from recurring

**Note:** Regression tests are for unintentional broken behavior (bugs), not intentional changes. Intentional feature removals, deprecations, or breaking changes do NOT need regression tests—these are design decisions, not defects.

### 5. Cover Every User Entry Point

**ALWAYS** have at least one basic test for each customer/user entry point.

- CLI commands, API endpoints, public/exported functions
- Test the common/happy path first
- This proves the entry point works at all

**Note:** "Entry point" means the public interface—exported functions, CLI commands, API routes. Internal/private functions are NOT entry points, even if they handle user-facing flags or options. Test entry points; internal functions get coverage through those tests.

### 6. Tests Validate Before Manual QA

Tests are how we validate **ANY** functionality works before manual testing.

- Write tests first or alongside code, not as an afterthought
- If you can't test it, reconsider the design
- Passing tests should give confidence to ship

## Technical Guidelines

### File Organization

- Co-locate tests with source files when possible
- Use the project's standard test file naming convention

### Test Isolation

Every test must:

- Run independently without affecting other tests
- Use temporary directories for file operations
- Clean up resources after completion

### Pure Function Tests

For pure functions without side effects, no special setup is needed—just test inputs and outputs directly.

## Checklist Before Submitting

- [ ] New entry points have at least one happy-path test
- [ ] Bug fixes (not intentional changes) include a regression test
- [ ] External services are mocked with sanitized fixtures
- [ ] Tests validate behavior, not implementation
- [ ] No shared state between tests
