import { expect, test } from "vitest";
import { attributeFields } from "./inspector-data.ts";

test("attribute values hide terminal colour codes in nested strings too", () => {
  // uvicorn's logging record, kept as breadcrumb data by sentry-python.
  const [field] = attributeFields({
    record: {
      color_message: "Started server process [\u001b[36m%d\u001b[0m]",
      args: ["\u001b[1m41234\u001b[0m"],
    },
  });
  expect(field?.value).toBe(
    '{"color_message":"Started server process [%d]","args":["41234"]}',
  );
});
