# Changelog
## 1.0.0

### New Features ✨

#### HTTP

- Make CacheStore.deleteMatching optional by @BYK with @sentry-junior in [#2550](https://github.com/getsentry/toolkit/pull/2550)
- Add @sentry/http and move CLI and MCP caching and retries onto it by @BYK with @sentry-junior in [#2509](https://github.com/getsentry/toolkit/pull/2509)

#### Other

- (mcp) Remove search_attributes experimental flag by @nikkikapadia in [#2251](https://github.com/getsentry/toolkit/pull/2251)

### Bug Fixes 🐛

#### CI

- Ignore Craft-written changelogs in oxfmt by @BYK with @sentry-junior in [#2551](https://github.com/getsentry/toolkit/pull/2551)
- Only post the token cost comment when the MCP surface changes by @BYK with @sentry-junior in [#2533](https://github.com/getsentry/toolkit/pull/2533)

#### Other

- (cli) Wait for sourcemap processing in CI by @BYK with @sentry-junior in [#2507](https://github.com/getsentry/toolkit/pull/2507)

### Internal Changes 🔧

- (ci) Handle ENOENT instead of existsSync in token cost comment script by @sentry-junior in [#2535](https://github.com/getsentry/toolkit/pull/2535)
- (cli) Fix env- and Node-dependent test failures, drop ~/src/sentry path by @dcramer with @sentry-junior in [#2457](https://github.com/getsentry/toolkit/pull/2457)
- (deps) Bump @sentry/api to 3.2.0 by @BYK with @sentry-release-bot and @sentry-junior in [#2447](https://github.com/getsentry/toolkit/pull/2447)
- (http) Retry Sentry API requests through @sentry/api 3's retry hook by @BYK with @sentry-junior in [#2542](https://github.com/getsentry/toolkit/pull/2542)

