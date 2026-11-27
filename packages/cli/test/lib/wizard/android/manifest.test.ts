import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  addManifestSnippet,
  getMainActivity,
} from "../../../../src/lib/wizard/android/manifest.js";
import { manifest } from "../../../../src/lib/wizard/android/templates.js";

vi.mock("../../../../src/lib/error-reporting.js", () => ({
  reportCliError: vi.fn(),
}));

describe("AndroidManifest.xml", () => {
  let tmpDir: string;
  let manifestFile: string;

  beforeEach(() => {
    vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    tmpDir = mkdtempSync(path.join(tmpdir(), "android-manifest-test-"));
    manifestFile = path.join(tmpDir, "AndroidManifest.xml");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true });
    vi.restoreAllMocks();
  });

  describe("getMainActivity", () => {
    it("finds the activity with the MAIN action and the manifest package", () => {
      writeFileSync(
        manifestFile,
        `<?xml version="1.0" encoding="utf-8"?>
<manifest xmlns:android="http://schemas.android.com/apk/res/android"
    package="com.example.sample">
  <application android:label="Sample">
    <!-- <activity android:name=".Commented" /> -->
    <activity android:name=".SettingsActivity" />
    <activity android:name=".DeepLinkActivity">
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
      </intent-filter>
    </activity>
    <activity
        android:name="ui.MainActivity"
        android:exported="true">
      <intent-filter>
        <action android:name="android.intent.action.VIEW" />
      </intent-filter>
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
      </intent-filter>
    </activity>
  </application>
</manifest>
`,
      );

      expect(getMainActivity(manifestFile)).toEqual({
        packageName: "com.example.sample",
        activityName: "ui.MainActivity",
      });
    });

    it("returns no package name when the manifest has none", () => {
      writeFileSync(
        manifestFile,
        `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <application>
    <activity android:name=".MainActivity">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
      </intent-filter>
    </activity>
  </application>
</manifest>`,
      );

      expect(getMainActivity(manifestFile)).toEqual({
        packageName: undefined,
        activityName: ".MainActivity",
      });
    });

    it("returns nothing for a single activity without intent filters", () => {
      writeFileSync(
        manifestFile,
        `<manifest><application><activity android:name=".Only" /></application></manifest>`,
      );

      expect(getMainActivity(manifestFile)).toEqual({});
    });

    it("ignores activity aliases", () => {
      writeFileSync(
        manifestFile,
        `<manifest>
  <application>
    <activity-alias android:name=".Alias">
      <intent-filter>
        <action android:name="android.intent.action.MAIN" />
      </intent-filter>
    </activity-alias>
  </application>
</manifest>`,
      );

      expect(getMainActivity(manifestFile)).toEqual({});
    });

    it("returns nothing for a manifest it can't parse", () => {
      writeFileSync(manifestFile, `<manifest><application></manifest>`);

      expect(getMainActivity(manifestFile)).toEqual({});
    });

    it("returns nothing when the manifest is missing", () => {
      expect(getMainActivity(manifestFile)).toEqual({});
    });
  });

  describe("addManifestSnippet", () => {
    const original = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
	<application   android:label="Sample" >
		<activity android:name=".MainActivity" />
	</application>
</manifest>
`;

    it("adds the Sentry options before </application> and keeps the rest as-is", () => {
      writeFileSync(manifestFile, original);

      expect(addManifestSnippet(manifestFile, "https://key@dsn", false)).toBe(
        true,
      );

      const insertAt = original.indexOf("</application>");
      expect(readFileSync(manifestFile, "utf8")).toBe(
        original.slice(0, insertAt) +
          manifest("https://key@dsn", false) +
          original.slice(insertAt),
      );
    });

    it("enables logs when asked to", () => {
      writeFileSync(manifestFile, original);

      addManifestSnippet(manifestFile, "https://key@dsn", true);

      expect(readFileSync(manifestFile, "utf8")).toContain(
        '<meta-data android:name="io.sentry.logs.enabled" android:value="true" />',
      );
    });

    it("leaves a manifest that already configures Sentry alone", () => {
      const configured = original.replace(
        "</application>",
        '<meta-data android:name="io.sentry.dsn" android:value="x" /></application>',
      );
      writeFileSync(manifestFile, configured);

      expect(addManifestSnippet(manifestFile, "https://key@dsn", false)).toBe(
        true,
      );
      expect(readFileSync(manifestFile, "utf8")).toBe(configured);
    });

    it("fails without an <application> element", () => {
      writeFileSync(manifestFile, "<manifest />");

      expect(addManifestSnippet(manifestFile, "https://key@dsn", false)).toBe(
        false,
      );
      expect(readFileSync(manifestFile, "utf8")).toBe("<manifest />");
    });
  });
});
