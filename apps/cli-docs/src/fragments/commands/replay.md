

## Replay file format

`sentry replay download` writes a flat, time-ordered array of rrweb events, ready for
[rrweb-player](https://github.com/rrweb-io/rrweb/tree/master/packages/rrweb-player)
or [rrvideo](https://github.com/rrweb-io/rrweb/tree/master/packages/rrvideo).
Sentry's custom events (breadcrumbs, performance spans) are kept.
