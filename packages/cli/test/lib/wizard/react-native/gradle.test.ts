import { describe, expect, it } from "vitest";
import {
  addRNSentryGradlePlugin,
  doesAppBuildGradleIncludeRNSentryGradlePlugin,
} from "../../../../src/lib/wizard/react-native/gradle.js";

describe("react-native gradle", () => {
  describe("doesAppBuildGradleIncludeSentry", () => {
    it("returns false for empty file", () => {
      expect(doesAppBuildGradleIncludeRNSentryGradlePlugin("")).toBe(false);
    });

    it("returns false for minimal app/build.gradle", () => {
      const appBuildGradle = `apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      expect(
        doesAppBuildGradleIncludeRNSentryGradlePlugin(appBuildGradle),
      ).toBe(false);
    });

    it("returns false for app/build.gradle with SAGP", () => {
      const appBuildGradle = `apply plugin: "com.android.application"
apply plugin: "io.sentry.android.gradle"

sentry {
}

android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      expect(
        doesAppBuildGradleIncludeRNSentryGradlePlugin(appBuildGradle),
      ).toBe(false);
    });

    it("returns true for app/build.gradle with RN SAGP", () => {
      const appBuildGradle = `apply plugin: "com.android.application"
apply plugin: "io.sentry.android.gradle"

sentry {
}

apply from: new File(["node", "--print", "require.resolve('@sentry/react-native/package.json')"].execute().text.trim(), "../sentry.gradle")

android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      expect(
        doesAppBuildGradleIncludeRNSentryGradlePlugin(appBuildGradle),
      ).toBe(true);
    });
  });

  describe("addRNSentryGradlePlugin", () => {
    it("does not add nothing to empty file", () => {
      expect(addRNSentryGradlePlugin("")).toBe("");
    });

    it("does add RN SAGP", () => {
      const input = `apply plugin: "com.android.application"

android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      const expectedOutput = `apply plugin: "com.android.application"

apply from: new File(["node", "--print", "require.resolve('@sentry/react-native/package.json')"].execute().text.trim(), "../sentry.gradle")
android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      expect(addRNSentryGradlePlugin(input)).toBe(expectedOutput);
    });

    it("does add RN SAGP to build gradle with SAGP", () => {
      const input = `apply plugin: "com.android.application"
apply plugin: "io.sentry.android.gradle"

sentry {
}

android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      const expectedOutput = `apply plugin: "com.android.application"
apply plugin: "io.sentry.android.gradle"

sentry {
}

apply from: new File(["node", "--print", "require.resolve('@sentry/react-native/package.json')"].execute().text.trim(), "../sentry.gradle")
android {
    ndkVersion rootProject.ext.ndkVersion

    compileSdkVersion rootProject.ext.compileSdkVersion

    namespace "com.samplenewarchitecture"
    defaultConfig {
        applicationId "com.samplenewarchitecture"
        minSdkVersion rootProject.ext.minSdkVersion
        targetSdkVersion rootProject.ext.targetSdkVersion
        versionCode 1
        versionName "1.0"
    }
}
`;
      expect(addRNSentryGradlePlugin(input)).toBe(expectedOutput);
    });
  });
});
