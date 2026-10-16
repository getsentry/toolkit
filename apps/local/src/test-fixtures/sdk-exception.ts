/** Scrubbed Sentry Node captureException payload, including an SDK error cause. */
export const sdkException = {
  event_id: "a".repeat(32),
  level: "error",
  transaction: "POST /checkout",
  request: { method: "POST", url: "https://example.test/checkout" },
  exception: {
    values: [
      {
        type: "Error",
        value: "Payment gateway unavailable",
        mechanism: {
          type: "chained",
          source: "cause",
          exception_id: 1,
          parent_id: 0,
        },
        stacktrace: {
          frames: [
            {
              filename: "/app/gateway.ts",
              function: "connectGateway",
              lineno: 15,
              colno: 8,
            },
          ],
        },
      },
      {
        type: "TypeError",
        value: "Cannot read properties of undefined (reading 'total')",
        stacktrace: {
          frames: [
            {
              filename: "node:internal/modules/run_main",
              function: "runMain",
              lineno: 101,
              colno: 5,
              in_app: false,
            },
            {
              filename: "/app/checkout.ts",
              function: "submitOrder",
              lineno: 42,
              colno: 17,
              in_app: true,
              context_line: 'throw new TypeError("Checkout failed");',
            },
          ],
        },
      },
    ],
  },
};
