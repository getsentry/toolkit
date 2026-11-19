/**
 * Scrubbed events from non-JavaScript SDKs, as `sentry local` receives them.
 * Shared by the CLI and viewer tests.
 */

/**
 * sentry-go 0.50 `CaptureException` from a recovered panic. Go sends
 * `exception` as a plain list, and its frames name only `abs_path`.
 */
export const goPanicEvent = {
  event_id: "c".repeat(32),
  platform: "go",
  level: "error",
  timestamp: "2026-11-18T10:15:42.318204Z",
  sdk: { name: "sentry.go", version: "0.50.0" },
  exception: [
    {
      type: "*errors.errorString",
      value: "order 7 not found",
      stacktrace: {
        frames: [
          {
            function: "main",
            module: "runtime",
            abs_path: "/usr/local/go/src/runtime/proc.go",
            lineno: 283,
            in_app: false,
          },
          {
            function: "handleOrder",
            module: "main",
            abs_path: "/app/main.go",
            lineno: 47,
            in_app: true,
          },
        ],
      },
    },
  ],
};

/**
 * sentry-ruby 5.22 on Ruby 3.3: `detailed_message` appends the class name, so
 * the value repeats the type.
 */
export const rubyExceptionEvent = {
  event_id: "d".repeat(32),
  platform: "ruby",
  level: "error",
  timestamp: 1_795_010_400.538,
  sdk: { name: "sentry.ruby", version: "5.22.0" },
  exception: {
    values: [
      {
        type: "OrderNotFound",
        value: "order 7 not found (OrderNotFound)",
        module: "",
        stacktrace: {
          frames: [
            {
              filename: "app/controllers/orders_controller.rb",
              abs_path: "/app/app/controllers/orders_controller.rb",
              function: "show",
              lineno: 12,
              in_app: true,
            },
          ],
        },
      },
    ],
  },
};
