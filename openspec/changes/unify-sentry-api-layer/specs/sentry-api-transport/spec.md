# Spec Delta

## Purpose

Defines when a Sentry API request from the CLI or MCP is retried, how long
it waits first, and what the caller sees when it gives up.

## ADDED Requirements

### Requirement: Only idempotent requests are retried

The transport SHALL automatically retry a failed request only when its
method is GET, HEAD, or OPTIONS, or when the caller marks that request
`idempotent`. A 401 that leads to a successful credential refresh SHALL be
replayed once for any method.

#### Scenario: POST without the opt-in

- **WHEN** a POST without the `idempotent` opt-in gets a 429, a 5xx, or a timeout
- **THEN** the transport returns that failure without sending the request again

#### Scenario: POST with the opt-in

- **WHEN** a POST marked `idempotent`, such as a content-addressed chunk upload, gets a 503
- **THEN** the transport retries it like a GET

#### Scenario: Token refresh

- **WHEN** any request, of any method, gets a 401 and the credential provider refreshes the token
- **THEN** the transport sends the request once more with the new token

### Requirement: Rate-limited requests wait for the reset

On a retryable 429, the transport SHALL wait for the delay the response
gives before retrying: `Retry-After` (seconds or an HTTP-date) when
present, otherwise `X-Sentry-Rate-Limit-Reset`. It SHALL measure the reset
against the response `Date` when the local clock disagrees with it by more
than a few seconds. When the response gives no usable delay, or the 429 is
for concurrency (`X-Sentry-Rate-Limit-ConcurrentRemaining: 0`), it SHALL use
jittered exponential backoff.

#### Scenario: Reset header within the cap

- **WHEN** a GET gets a 429 whose `X-Sentry-Rate-Limit-Reset` is 1 second away and the per-wait cap is 2 seconds
- **THEN** the transport waits about 1 second and retries the GET

#### Scenario: Skewed local clock

- **WHEN** the local clock is 10 minutes behind the response `Date` and the reset is 1 second after that `Date`
- **THEN** the transport waits about 1 second, not 10 minutes

#### Scenario: Concurrency limit

- **WHEN** a GET gets a 429 with `X-Sentry-Rate-Limit-ConcurrentRemaining: 0`
- **THEN** the transport retries after a jittered backoff delay, not at the window reset

### Requirement: Retry waits are capped

Each product SHALL set a maximum number of retries, a per-wait cap, and a
total-wait cap. When the next wait would exceed either cap, the transport
SHALL stop retrying and return a rate-limit error that says how many seconds
to wait before trying again. An aborted request SHALL stop waiting at once.

#### Scenario: Reset beyond the cap

- **WHEN** a GET gets a 429 whose reset is 30 seconds away and the per-wait cap is 2 seconds
- **THEN** the transport does not wait and returns a rate-limit error saying to retry in 30 seconds

#### Scenario: Retries exhausted

- **WHEN** a GET is still rate limited after the last allowed retry
- **THEN** the caller gets a rate-limit error with the delay from the last response

#### Scenario: Aborted during a wait

- **WHEN** the caller aborts a request while it waits to retry
- **THEN** the wait ends and the request fails with the abort reason

### Requirement: Retries do not stack

A request SHALL be retried by one layer only. When the MCP sends its
requests through a host-supplied or shared transport, `SentryApiService`
SHALL not retry them again.

#### Scenario: MCP on the shared transport

- **WHEN** an MCP tool's GET is rate limited on every attempt through the shared transport
- **THEN** the Sentry API receives at most `maxRetries + 1` requests for that call
