import { describe, expect, test } from "vitest";
import { upsert } from "../../../src/lib/db/utils.js";

describe("upsert", () => {
  test("generates basic UPSERT statement", () => {
    const result = upsert("auth", { id: 1, token: "abc123" }, ["id"]);

    expect(result.sql).toBe(
      "INSERT INTO auth (id, token) VALUES (?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token"
    );
    expect(result.values).toEqual([1, "abc123"]);
  });

  test("handles multiple columns", () => {
    const result = upsert(
      "users",
      { id: 1, name: "Bob", age: 30, updated_at: 12_345 },
      ["id"]
    );

    expect(result.sql).toBe(
      "INSERT INTO users (id, name, age, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, age = excluded.age, updated_at = excluded.updated_at"
    );
    expect(result.values).toEqual([1, "Bob", 30, 12_345]);
  });

  test("handles multiple conflict columns", () => {
    const result = upsert(
      "cache",
      { org_id: "org1", project_id: "proj1", data: "cached" },
      ["org_id", "project_id"]
    );

    expect(result.sql).toBe(
      "INSERT INTO cache (org_id, project_id, data) VALUES (?, ?, ?) ON CONFLICT(org_id, project_id) DO UPDATE SET data = excluded.data"
    );
    expect(result.values).toEqual(["org1", "proj1", "cached"]);
  });

  test("excludes columns from update", () => {
    const result = upsert(
      "users",
      { id: 1, name: "Bob", created_at: 1000, updated_at: 2000 },
      ["id"],
      { excludeFromUpdate: ["created_at"] }
    );

    expect(result.sql).toBe(
      "INSERT INTO users (id, name, created_at, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at"
    );
    expect(result.values).toEqual([1, "Bob", 1000, 2000]);
  });

  test("generates DO NOTHING when all non-conflict columns are excluded", () => {
    const result = upsert("settings", { id: 1, value: "test" }, ["id"], {
      excludeFromUpdate: ["value"],
    });

    expect(result.sql).toBe(
      "INSERT INTO settings (id, value) VALUES (?, ?) ON CONFLICT(id) DO NOTHING"
    );
  });

  test("handles null values", () => {
    const result = upsert(
      "auth",
      { id: 1, token: "abc", refresh_token: null },
      ["id"]
    );

    expect(result.sql).toBe(
      "INSERT INTO auth (id, token, refresh_token) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET token = excluded.token, refresh_token = excluded.refresh_token"
    );
    expect(result.values).toEqual([1, "abc", null]);
  });

  test("handles undefined converted to null", () => {
    const result = upsert(
      "auth",
      { id: 1, token: "abc", refresh_token: undefined },
      ["id"]
    );

    expect(result.values).toEqual([1, "abc", undefined]);
  });

  test("throws error for empty data object", () => {
    expect(() => upsert("auth", {}, ["id"])).toThrow(
      "upsert: data object must have at least one column"
    );
  });

  test("throws error for empty conflict columns", () => {
    expect(() => upsert("auth", { id: 1 }, [])).toThrow(
      "upsert: must specify at least one conflict column"
    );
  });

  test("preserves column order from data object", () => {
    const result = upsert("test", { z_col: 1, a_col: 2, m_col: 3 }, ["z_col"]);

    expect(result.sql).toContain("(z_col, a_col, m_col)");
    expect(result.values).toEqual([1, 2, 3]);
  });
});
