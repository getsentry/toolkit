// @vitest-environment node
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "vitest";
import { defaultFixtures } from "./replay.ts";

test("bundled envelope item lengths match their raw payload boundaries", async () => {
  const files = (await readdir(defaultFixtures)).filter((name) =>
    /\.(txt|bin)$/.test(name),
  );
  expect(files.length).toBeGreaterThanOrEqual(9);
  for (const file of files) {
    const data = await readFile(join(defaultFixtures, file));
    let cursor = data.indexOf(10) + 1;
    expect(cursor, file).toBeGreaterThan(0);
    while (cursor < data.length) {
      const headerEnd = data.indexOf(10, cursor);
      expect(headerEnd, file).toBeGreaterThanOrEqual(cursor);
      const header = JSON.parse(
        data.subarray(cursor, headerEnd).toString("utf8"),
      ) as { type: string; length: number };
      expect(
        Number.isSafeInteger(header.length) && header.length >= 0,
        file,
      ).toBe(true);
      const payloadStart = headerEnd + 1;
      const payload = data.subarray(payloadStart, payloadStart + header.length);
      expect(payload.byteLength, file).toBe(header.length);
      if (header.type !== "attachment")
        expect(() => JSON.parse(payload.toString("utf8")), file).not.toThrow();
      cursor = payloadStart + header.length;
      expect(
        data[cursor],
        `${file}: ${header.type} payload must end at its LF delimiter`,
      ).toBe(10);
      cursor++;
    }
    expect(cursor, file).toBe(data.length);
  }
});
