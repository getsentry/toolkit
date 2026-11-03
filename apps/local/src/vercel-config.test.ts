import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, test } from "vitest";

describe("Local Vercel configuration", () => {
  test("installs dependencies cleanly and serves SPA deep links", () => {
    const configPath = resolve(process.cwd(), "vercel.json");
    expect(existsSync(configPath)).toBe(true);
    if (!existsSync(configPath)) {
      return;
    }

    const config = JSON.parse(readFileSync(configPath, "utf8")) as {
      installCommand?: string;
      rewrites?: Array<{ destination?: string; source?: string }>;
    };
    expect(config.installCommand).toBe(
      "pnpm install --force --frozen-lockfile",
    );
    expect(config.rewrites ?? []).toContainEqual({
      source: "/(.*)",
      destination: "/index.html",
    });
  });
});
