

## Replay file format

`sentry replay download` writes a flat, time-ordered array of rrweb events, ready for
[rrweb-player](https://github.com/rrweb-io/rrweb/tree/master/packages/rrweb-player)
or [rrvideo](https://github.com/rrweb-io/rrweb/tree/master/packages/rrvideo).
Sentry's custom events (breadcrumbs, performance spans) are kept.

Mobile replays are recorded as video, one mp4 clip per recording segment, so
`sentry replay download` joins the clips into one `<replay-id>.mp4` with
[ffmpeg](https://ffmpeg.org/). Clips that differ in size, such as after the
screen rotates, are letterboxed into one frame size. Gaps in the recording,
such as time the app spent in the background, hold the last frame, so the
video's timeline matches the replay's. When ffmpeg is not on your `PATH`, the
clips are saved in a `<replay-id>-clips` directory with a `clips.txt` list:

```bash
ffmpeg -f concat -i <replay-id>-clips/clips.txt -c copy <replay-id>.mp4
```
