import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  extractDsnsFromContent,
  extractFirstDsnFromContent,
  scanCodeForDsns,
  scanCodeForFirstDsn,
} from "../../../src/lib/dsn/code-scanner.js";

describe("Code Scanner", () => {
  const testDir = join(import.meta.dirname, ".test-code-scanner");

  beforeEach(() => {
    mkdirSync(testDir, { recursive: true });
  });

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true });
    delete process.env.SENTRY_HOST;
    delete process.env.SENTRY_URL;
  });

  describe("extractDsnsFromContent", () => {
    test("extracts DSN from JavaScript code", () => {
      const content = `
        Sentry.init({
          dsn: "https://abc123@o123.ingest.sentry.io/456"
        });
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc123@o123.ingest.sentry.io/456"]);
    });

    test("extracts DSN from Python code", () => {
      const content = `
        sentry_sdk.init(
            dsn="https://abc123@o123.ingest.sentry.io/456"
        )
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc123@o123.ingest.sentry.io/456"]);
    });

    test("extracts DSN from Go code", () => {
      const content = `
        sentry.Init(sentry.ClientOptions{
          Dsn: "https://abc123@o123.ingest.sentry.io/456",
        })
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc123@o123.ingest.sentry.io/456"]);
    });

    test("extracts DSN from constant assignment", () => {
      const content = `
        const SENTRY_DSN = "https://abc123@o123.ingest.sentry.io/456";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc123@o123.ingest.sentry.io/456"]);
    });

    test.each([
      ["all lower", "https://abc@o1.ingest.sentry.io/456"],
      ["all upper", "HTTPS://abc@o1.ingest.sentry.io/456"],
      ["title", "Https://abc@o1.ingest.sentry.io/456"],
      ["mixed", "hTtPs://abc@o1.ingest.sentry.io/456"],
      ["http no s", "HTTP://abc@o1.ingest.sentry.io/456"],
    ])("detects DSN with %s scheme casing (regression: literal-prefix fast path)", (_label, url) => {
      // An earlier version of the literal-prefix probe used two
      // case-sensitive `indexOf` calls (covering only all-lower and
      // all-upper), which silently dropped mixed-case schemes like
      // `Https://`. The probe is now `/http/i`. This test pins the
      // correctness contract.
      const content = `const DSN = "${url}";`;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toHaveLength(1);
      expect(dsns[0]).toBe(url);
    });

    test("extracts multiple DSNs", () => {
      const content = `
        const PROD_DSN = "https://prod@o123.ingest.sentry.io/111";
        const DEV_DSN = "https://dev@o456.ingest.sentry.io/222";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toHaveLength(2);
      expect(dsns).toContain("https://prod@o123.ingest.sentry.io/111");
      expect(dsns).toContain("https://dev@o456.ingest.sentry.io/222");
    });

    test("deduplicates DSNs", () => {
      const content = `
        const DSN1 = "https://abc@o123.ingest.sentry.io/456";
        const DSN2 = "https://abc@o123.ingest.sentry.io/456";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toHaveLength(1);
    });

    test("ignores single-line comments with //", () => {
      const content = `
        // const DSN = "https://abc123@o123.ingest.sentry.io/456";
        const REAL_DSN = "https://real@o456.ingest.sentry.io/789";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores Python/shell comments with #", () => {
      const content = `
        # DSN = "https://abc123@o123.ingest.sentry.io/456"
        REAL_DSN = "https://real@o456.ingest.sentry.io/789"
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores HTML comments with <!--", () => {
      const content = `
        <!-- <script>const DSN = "https://abc123@o123.ingest.sentry.io/456";</script> -->
        <script>const DSN = "https://real@o456.ingest.sentry.io/789";</script>
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores C-style block comment lines starting with /*", () => {
      const content = `
        /* const DSN = "https://abc123@o123.ingest.sentry.io/456"; */
        const REAL_DSN = "https://real@o456.ingest.sentry.io/789";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores JSDoc/multi-line comment continuation lines starting with *", () => {
      const content = `
        /**
         * DSN: "https://abc123@o123.ingest.sentry.io/456"
         */
        const REAL_DSN = "https://real@o456.ingest.sentry.io/789";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores SQL comments with --", () => {
      const content = `
        -- INSERT INTO config VALUES ('dsn', 'https://abc123@o123.ingest.sentry.io/456');
        INSERT INTO config VALUES ('dsn', 'https://real@o456.ingest.sentry.io/789');
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("ignores Python triple-quote docstrings", () => {
      const content = `
        '''https://abc123@o123.ingest.sentry.io/456'''
        DSN = "https://real@o456.ingest.sentry.io/789"
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://real@o456.ingest.sentry.io/789"]);
    });

    test("returns empty array for content without DSNs", () => {
      const content = `
        const config = { debug: true };
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual([]);
    });

    test("only accepts *.sentry.io hosts for SaaS", () => {
      const content = `
        const REAL = "https://abc@o123.ingest.sentry.io/456";
        const FAKE = "https://abc@fake.example.com/456";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc@o123.ingest.sentry.io/456"]);
    });

    test("extracts DSN with secret key (legacy format)", () => {
      // Some older Sentry installations or SDKs use public:secret format
      const content = `
        const DSN = "https://publickey:secretkey@o123.ingest.sentry.io/456";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual([
        "https://publickey:secretkey@o123.ingest.sentry.io/456",
      ]);
    });

    test("extracts both regular and secret-key DSNs", () => {
      const content = `
        const DSN1 = "https://public@o123.ingest.sentry.io/111";
        const DSN2 = "https://public:secret@o456.ingest.sentry.io/222";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toHaveLength(2);
      expect(dsns).toContain("https://public@o123.ingest.sentry.io/111");
      expect(dsns).toContain("https://public:secret@o456.ingest.sentry.io/222");
    });

    test("accepts self-hosted DSNs when SENTRY_URL is set", () => {
      process.env.SENTRY_URL = "https://sentry.mycompany.com:9000";
      const content = `
        const DSN = "https://abc@sentry.mycompany.com:9000/123";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc@sentry.mycompany.com:9000/123"]);
    });

    test("rejects SaaS DSNs when SENTRY_URL is set (self-hosted mode)", () => {
      process.env.SENTRY_URL = "https://sentry.mycompany.com:9000";
      const content = `
        const SAAS_DSN = "https://abc@o123.ingest.sentry.io/456";
        const SELF_HOSTED_DSN = "https://def@sentry.mycompany.com:9000/789";
      `;
      const dsns = extractDsnsFromContent(content);
      // Only the self-hosted DSN should be accepted
      expect(dsns).toEqual(["https://def@sentry.mycompany.com:9000/789"]);
    });

    test("throws ConfigError when SENTRY_URL is invalid", () => {
      // normalizeUrl prepends https:// to bare strings, so use a value
      // that remains unparseable even after normalization (https://://)
      process.env.SENTRY_URL = "://";
      const content = `
        const SAAS_DSN = "https://abc@o123.ingest.sentry.io/456";
      `;

      // Invalid SENTRY_URL should throw immediately since nothing will work
      expect(() => extractDsnsFromContent(content)).toThrow(
        /SENTRY_HOST\/SENTRY_URL.*not a valid URL/
      );
    });

    test("accepts self-hosted DSNs when SENTRY_HOST is set", () => {
      process.env.SENTRY_HOST = "https://sentry.mycompany.com:9000";
      const content = `
        const DSN = "https://abc@sentry.mycompany.com:9000/123";
      `;
      const dsns = extractDsnsFromContent(content);
      expect(dsns).toEqual(["https://abc@sentry.mycompany.com:9000/123"]);
    });

    test("SENTRY_HOST takes precedence over SENTRY_URL for DSN validation", () => {
      process.env.SENTRY_HOST = "https://sentry.mycompany.com:9000";
      process.env.SENTRY_URL = "https://sentry.other.com";
      const content = `
        const DSN1 = "https://abc@sentry.mycompany.com:9000/123";
        const DSN2 = "https://def@sentry.other.com/456";
      `;
      const dsns = extractDsnsFromContent(content);
      // Only the SENTRY_HOST DSN should be accepted
      expect(dsns).toEqual(["https://abc@sentry.mycompany.com:9000/123"]);
    });
  });

  describe("extractFirstDsnFromContent", () => {
    test("returns first DSN", () => {
      const content = `
        const DSN1 = "https://first@o123.ingest.sentry.io/111";
        const DSN2 = "https://second@o456.ingest.sentry.io/222";
      `;
      const dsn = extractFirstDsnFromContent(content);
      expect(dsn).toBe("https://first@o123.ingest.sentry.io/111");
    });

    test("returns null when no DSN found", () => {
      const dsn = extractFirstDsnFromContent("no dsn here");
      expect(dsn).toBeNull();
    });
  });

  describe("scanCodeForFirstDsn", () => {
    test("finds DSN in root file", async () => {
      writeFileSync(
        join(testDir, "config.ts"),
        'const DSN = "https://abc@o123.ingest.sentry.io/456";'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://abc@o123.ingest.sentry.io/456");
      expect(result?.source).toBe("code");
      expect(result?.sourcePath).toBe("config.ts");
    });

    test("finds DSN in subdirectory", async () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/sentry.ts"),
        'Sentry.init({ dsn: "https://abc@o123.ingest.sentry.io/456" });'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://abc@o123.ingest.sentry.io/456");
      expect(result?.sourcePath).toBe("src/sentry.ts");
    });

    test("returns null when no DSN found", async () => {
      writeFileSync(join(testDir, "index.ts"), "console.log('hello');");

      const result = await scanCodeForFirstDsn(testDir);
      expect(result).toBeNull();
    });

    test("skips node_modules directory", async () => {
      mkdirSync(join(testDir, "node_modules/some-package"), {
        recursive: true,
      });
      writeFileSync(
        join(testDir, "node_modules/some-package/index.js"),
        'const DSN = "https://abc@o123.ingest.sentry.io/456";'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result).toBeNull();
    });

    test("skips test directories", async () => {
      // DSNs in test/ should be ignored (they contain test fixtures, not real config)
      mkdirSync(join(testDir, "test/lib"), { recursive: true });
      writeFileSync(
        join(testDir, "test/lib/scanner.test.ts"),
        'const DSN = "https://testkey@o123.ingest.sentry.io/456";'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result).toBeNull();

      // Also test tests/ directory
      mkdirSync(join(testDir, "tests/unit"), { recursive: true });
      writeFileSync(
        join(testDir, "tests/unit/app.test.ts"),
        'const DSN = "https://testkey@o999.ingest.sentry.io/789";'
      );

      const allResult = await scanCodeForDsns(testDir);
      expect(allResult.dsns).toHaveLength(0);
    });

    test("skips __mocks__ and fixtures directories", async () => {
      mkdirSync(join(testDir, "__mocks__"), { recursive: true });
      writeFileSync(
        join(testDir, "__mocks__/sentry.ts"),
        'export const DSN = "https://mock@o123.ingest.sentry.io/111";'
      );
      mkdirSync(join(testDir, "fixtures"), { recursive: true });
      writeFileSync(
        join(testDir, "fixtures/config.ts"),
        'export const DSN = "https://fixture@o123.ingest.sentry.io/222";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(0);
    });

    test("still finds DSNs in src/ when test/ is skipped", async () => {
      // Ensure test/ skipping doesn't affect real source directories
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/config.ts"),
        'const DSN = "https://realkey@o123.ingest.sentry.io/456";'
      );
      mkdirSync(join(testDir, "test"), { recursive: true });
      writeFileSync(
        join(testDir, "test/fixture.ts"),
        'const DSN = "https://fakekey@o999.ingest.sentry.io/999";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0].raw).toBe(
        "https://realkey@o123.ingest.sentry.io/456"
      );
    });

    test("respects gitignore", async () => {
      writeFileSync(join(testDir, ".gitignore"), "ignored/");
      mkdirSync(join(testDir, "ignored"), { recursive: true });
      writeFileSync(
        join(testDir, "ignored/config.ts"),
        'const DSN = "https://ignored@o123.ingest.sentry.io/456";'
      );
      writeFileSync(
        join(testDir, "real.ts"),
        'const DSN = "https://real@o456.ingest.sentry.io/789";'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://real@o456.ingest.sentry.io/789");
    });

    test("infers packagePath for monorepo structure", async () => {
      // Use depth 2 (packages/frontend/sentry.ts) to stay within MAX_SCAN_DEPTH
      mkdirSync(join(testDir, "packages/frontend"), { recursive: true });
      writeFileSync(
        join(testDir, "packages/frontend/sentry.ts"),
        'const DSN = "https://abc@o123.ingest.sentry.io/456";'
      );

      const result = await scanCodeForFirstDsn(testDir);
      expect(result?.packagePath).toBe("packages/frontend");
    });

    test("scans various file types", async () => {
      // Test Python
      writeFileSync(
        join(testDir, "app.py"),
        'sentry_sdk.init(dsn="https://py@o123.ingest.sentry.io/1")'
      );

      let result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://py@o123.ingest.sentry.io/1");

      // Clean and test Go
      rmSync(join(testDir, "app.py"));
      writeFileSync(
        join(testDir, "main.go"),
        'sentry.Init(sentry.ClientOptions{Dsn: "https://go@o123.ingest.sentry.io/2"})'
      );

      result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://go@o123.ingest.sentry.io/2");

      // Clean and test Ruby
      rmSync(join(testDir, "main.go"));
      writeFileSync(
        join(testDir, "config.rb"),
        'Sentry.init do |config|\n  config.dsn = "https://rb@o123.ingest.sentry.io/3"\nend'
      );

      result = await scanCodeForFirstDsn(testDir);
      expect(result?.raw).toBe("https://rb@o123.ingest.sentry.io/3");
    });
  });

  describe("scanCodeForDsns", () => {
    test("finds all DSNs across multiple files", async () => {
      mkdirSync(join(testDir, "src"), { recursive: true });
      writeFileSync(
        join(testDir, "src/frontend.ts"),
        'const DSN = "https://frontend@o123.ingest.sentry.io/111";'
      );
      writeFileSync(
        join(testDir, "src/backend.ts"),
        'const DSN = "https://backend@o456.ingest.sentry.io/222";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(2);

      const dsns = result.dsns.map((r) => r.raw);
      expect(dsns).toContain("https://frontend@o123.ingest.sentry.io/111");
      expect(dsns).toContain("https://backend@o456.ingest.sentry.io/222");

      // Verify mtimes are tracked for source files
      expect(Object.keys(result.sourceMtimes)).toHaveLength(2);
      expect(result.sourceMtimes["src/frontend.ts"]).toBeGreaterThan(0);
      expect(result.sourceMtimes["src/backend.ts"]).toBeGreaterThan(0);
    });

    test("deduplicates same DSN from multiple files", async () => {
      writeFileSync(
        join(testDir, "a.ts"),
        'const DSN = "https://same@o123.ingest.sentry.io/456";'
      );
      writeFileSync(
        join(testDir, "b.ts"),
        'const DSN = "https://same@o123.ingest.sentry.io/456";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(1);
      // Both source files should be tracked even if DSN is deduplicated
      expect(Object.keys(result.sourceMtimes)).toHaveLength(2);
    });

    test("returns empty result when no DSNs found", async () => {
      writeFileSync(join(testDir, "index.ts"), "console.log('hello');");

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toEqual([]);
      expect(result.sourceMtimes).toEqual({});
    });

    test("skips files larger than 256 KB", async () => {
      // Create a file that exceeds MAX_FILE_SIZE (256 * 1024 bytes)
      const largePadding = "x".repeat(256 * 1024 + 1);
      const content = `const DSN = "https://abc@o123.ingest.sentry.io/456";\n${largePadding}`;
      writeFileSync(join(testDir, "large.ts"), content);

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toEqual([]);
    });

    test("finds DSNs on long single-line files (>2000 chars, common in minified JS)", async () => {
      // Regression: `grepFiles` defaults to `maxLineLength: 2000` which
      // truncates `match.line` with a `…` suffix. The DSN scanner then
      // re-runs `DSN_PATTERN` on that truncated line, so a DSN near the
      // end of a long line would silently disappear (the pattern ends
      // with `/\d+` — trailing digits get replaced by `…`).
      //
      // The scanner explicitly passes `maxLineLength: Infinity` to
      // disable truncation, because memory is bounded by the walker's
      // 256KB file cap.
      const filler = "x".repeat(1990);
      const dsn = "https://abc@o111222.ingest.us.sentry.io/7654321";
      const line = `${filler} const DSN = "${dsn}";`;
      // Sanity: DSN starts past column 2000.
      expect(line.indexOf(dsn)).toBeGreaterThan(2000);
      writeFileSync(join(testDir, "minified.js"), line);

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0]?.raw).toBe(dsn);
    });

    test("finds DSNs in monorepo packages deeper than MAX_SCAN_DEPTH", async () => {
      // packages/spotlight/src/instrument.ts is depth 3 from root,
      // but with monorepo depth reset, packages/spotlight/ resets to 0
      // so src/instrument.ts is only depth 1 from the package root
      mkdirSync(join(testDir, "packages/spotlight/src"), { recursive: true });
      writeFileSync(
        join(testDir, "packages/spotlight/src/instrument.ts"),
        'Sentry.init({ dsn: "https://spotlight@o123.ingest.sentry.io/111" });'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0]?.raw).toBe(
        "https://spotlight@o123.ingest.sentry.io/111"
      );
      expect(result.dsns[0]?.packagePath).toBe("packages/spotlight");
    });

    test("finds DSNs from multiple monorepo packages", async () => {
      mkdirSync(join(testDir, "packages/frontend/src"), { recursive: true });
      mkdirSync(join(testDir, "packages/backend/src"), { recursive: true });
      writeFileSync(
        join(testDir, "packages/frontend/src/sentry.ts"),
        'const DSN = "https://fe@o123.ingest.sentry.io/111";'
      );
      writeFileSync(
        join(testDir, "packages/backend/src/sentry.ts"),
        'const DSN = "https://be@o456.ingest.sentry.io/222";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(2);

      const dsns = result.dsns.map((d) => d.raw);
      expect(dsns).toContain("https://fe@o123.ingest.sentry.io/111");
      expect(dsns).toContain("https://be@o456.ingest.sentry.io/222");

      // Verify packagePath is set correctly for each
      const feResult = result.dsns.find((d) => d.raw.includes("fe@"));
      const beResult = result.dsns.find((d) => d.raw.includes("be@"));
      expect(feResult?.packagePath).toBe("packages/frontend");
      expect(beResult?.packagePath).toBe("packages/backend");
    });

    test("finds DSNs deeply nested in monorepo packages", async () => {
      // packages/spotlight/src/electron/main/index.ts is depth 5 from root,
      // but after monorepo reset at packages/spotlight/, it's depth 3 —
      // exactly at MAX_SCAN_DEPTH. This was a specific failing case.
      mkdirSync(join(testDir, "packages/spotlight/src/electron/main"), {
        recursive: true,
      });
      writeFileSync(
        join(testDir, "packages/spotlight/src/electron/main/index.ts"),
        'Sentry.init({ dsn: "https://electron@o123.ingest.sentry.io/333" });'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toHaveLength(1);
      expect(result.dsns[0]?.raw).toBe(
        "https://electron@o123.ingest.sentry.io/333"
      );
      expect(result.dsns[0]?.packagePath).toBe("packages/spotlight");
    });

    test("respects depth limit for non-monorepo directories", async () => {
      // src/very/deeply/nested/config.ts is depth 4 — beyond MAX_SCAN_DEPTH (3).
      // Should NOT be found. This confirms the depth reset only applies to
      // monorepo package directories, not arbitrary subdirectories.
      mkdirSync(join(testDir, "src/very/deeply/nested"), { recursive: true });
      writeFileSync(
        join(testDir, "src/very/deeply/nested/config.ts"),
        'const DSN = "https://deep@o123.ingest.sentry.io/999";'
      );

      const result = await scanCodeForDsns(testDir);
      expect(result.dsns).toEqual([]);
    });

    test("gracefully handles unreadable files", async () => {
      const { chmodSync } = require("node:fs") as typeof import("node:fs");
      const filePath = join(testDir, "secret.ts");
      writeFileSync(
        filePath,
        'const DSN = "https://abc@o123.ingest.sentry.io/456";'
      );
      chmodSync(filePath, 0o000);

      try {
        const result = await scanCodeForDsns(testDir);
        expect(result.dsns).toEqual([]);
      } finally {
        // Restore permissions so afterEach cleanup can delete
        chmodSync(filePath, 0o644);
      }
    });

    test("nonexistent root produces empty result, no partial state", async () => {
      // Documents the contract that's hardened by the PR 791 review
      // finding: any error path through `scanDirectory` returns all
      // three result maps empty. The catch block used to leak a
      // partial `dirMtimes` populated by `onDirectoryVisit` before
      // the error — if cached, the verifier would only check visited
      // dirs and miss new DSNs in unvisited ones. Fix: empty on error.
      //
      // (In practice the walker doesn't throw on a missing root —
      // it simply yields nothing — so this is the happy-empty path.
      // The mid-walk-throw case is hard to synthesize in a test but
      // the fix covers it symmetrically via the catch block.)
      const missingDir = join(testDir, "does-not-exist");
      const result = await scanCodeForDsns(missingDir);
      expect(result.dsns).toEqual([]);
      expect(result.sourceMtimes).toEqual({});
      expect(result.dirMtimes).toEqual({});
    });

    test("dirMtimes is populated for every visited directory", async () => {
      // PR 3 migrated the walker; dirMtimes comes from the
      // `onDirectoryVisit` hook. This pins the invariant the cache
      // verifier (`src/lib/db/dsn-cache.ts::validateDirMtime`) silently
      // depends on — every directory entered by the walker must have
      // a finite integer mtime in the result. Previously asserted by
      // nothing; now explicit.
      mkdirSync(join(testDir, "src", "lib", "deep"), { recursive: true });
      writeFileSync(join(testDir, "src/a.ts"), "// no dsn");
      writeFileSync(join(testDir, "src/lib/b.ts"), "// no dsn");
      writeFileSync(join(testDir, "src/lib/deep/c.ts"), "// no dsn");

      const result = await scanCodeForDsns(testDir);
      // Keys are POSIX-normalized relative paths; "." for cwd.
      const keys = Object.keys(result.dirMtimes).sort();
      expect(keys).toContain(".");
      expect(keys).toContain("src");
      expect(keys).toContain("src/lib");
      expect(keys).toContain("src/lib/deep");
      // Values are floored integers matching the cache verifier's math.
      for (const [dir, mtime] of Object.entries(result.dirMtimes)) {
        expect(Number.isInteger(mtime)).toBe(true);
        expect(mtime).toBeGreaterThan(0);
        // Sanity: key should never be an absolute path.
        expect(dir.startsWith("/")).toBe(false);
      }
    });
  });
});
