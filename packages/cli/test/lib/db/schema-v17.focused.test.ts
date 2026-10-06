import { describe, expect, test } from "vitest";
import { closeDatabase, getDatabase } from "../../../src/lib/db/index.js";
import { CURRENT_SCHEMA_VERSION } from "../../../src/lib/db/schema.js";
import { useTestConfigDir } from "../../helpers.js";

useTestConfigDir("schema-v17-focused-");

describe("schema v17 organization region provenance", () => {
  test("uses a strict credential, lookup-origin, and slug primary key", () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(17);
    const columns = getDatabase()
      .query("PRAGMA table_info(org_regions)")
      .all() as Array<{
      name: string;
      notnull: number;
      pk: number;
    }>;
    const byName = new Map(columns.map((column) => [column.name, column]));
    expect(byName.get("credential_identity")).toMatchObject({
      notnull: 1,
      pk: 1,
    });
    expect(byName.get("source_origin")).toMatchObject({ notnull: 1, pk: 2 });
    expect(byName.get("org_slug")).toMatchObject({ notnull: 1, pk: 3 });
    expect(byName.get("response_origin")).toMatchObject({ notnull: 1, pk: 0 });
  });

  test("discards v16 rows whose provenance is unknowable", () => {
    const db = getDatabase();
    db.exec("DROP TABLE org_regions");
    db.exec(`CREATE TABLE org_regions (
      org_slug TEXT PRIMARY KEY, region_url TEXT NOT NULL, org_id TEXT,
      org_name TEXT, org_role TEXT, updated_at INTEGER NOT NULL
    )`);
    db.query(
      "INSERT INTO org_regions (org_slug, region_url, updated_at) VALUES (?, ?, ?)",
    ).run("legacy", "https://legacy.example.com", Date.now());
    db.query("UPDATE schema_version SET version = 16").run();
    closeDatabase();
    const migrated = getDatabase();
    expect(
      migrated.query("SELECT COUNT(*) AS count FROM org_regions").get(),
    ).toEqual({ count: 0 });
    expect(migrated.query("SELECT version FROM schema_version").get()).toEqual({
      version: 17,
    });
  });
});
