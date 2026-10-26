# Spec Delta

## Purpose

Lets the CLI and MCP fetch a bounded number of rows from any Sentry list
endpoint and resume exactly where the previous call stopped.

## ADDED Requirements

### Requirement: Limit-bounded walks

A list operation SHALL return at most the requested number of rows. It SHALL
use the fewest requests that can hold them, with page sizes spread as evenly
as possible and no page larger than the API maximum of 100.

#### Scenario: Limit above one page

- **WHEN** a caller requests 201 rows from an endpoint with more than 201 rows
- **THEN** the walk makes three requests of 67 rows each and returns 201 rows

#### Scenario: Limit within one page

- **WHEN** a caller requests 25 rows
- **THEN** the walk makes one request with a page size of 25

### Requirement: Resume-safe cursors

A walk that stops before the end of the results SHALL return a cursor that
resumes at the first row the caller has not received, including when it
stopped inside a page.

#### Scenario: Stop inside a page

- **WHEN** a walk returns 30 rows of a 67-row page and the caller passes the returned cursor back
- **THEN** the next walk starts at row 31 of that page without repeating or skipping rows

#### Scenario: Cursor accepted by the API and older clients

- **WHEN** a caller sends a returned cursor directly to the Sentry API, or to an older CLI
- **THEN** the request succeeds and returns rows at or before the resume point, never after it

### Requirement: Page-number cursors keep their page size

Resuming a page-number cursor SHALL reuse the page size encoded in that
cursor, whatever the new limit.

#### Scenario: Resume with a different limit

- **WHEN** a page-number cursor produced with a page size of 50 is resumed with a limit of 10
- **THEN** the walk requests pages of 50 and returns the first 10 unseen rows

### Requirement: Bounded page count

A walk SHALL stop after a fixed maximum number of pages. It SHALL return
the rows collected so far, a resume cursor, and an indication that the page
cap stopped it.

#### Scenario: Page cap reached

- **WHEN** an endpoint keeps returning next pages beyond the page cap
- **THEN** the walk stops at the cap and returns a cursor that resumes after the last returned row

### Requirement: Complete walks fail loudly

A walk that must see every row, such as one whose result a mutation depends
on, SHALL fail rather than return partial results. That applies when a page
is invalid, a cursor repeats, or the page cap is reached.

#### Scenario: Repeated cursor

- **WHEN** an endpoint returns a next cursor it already returned during the same walk
- **THEN** the walk fails with an error naming the operation
