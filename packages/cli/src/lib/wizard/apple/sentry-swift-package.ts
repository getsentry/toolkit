/**
 * The Sentry Cocoa Swift package and product the iOS wizard links.
 */

import type {
  SwiftPackageProductSpec,
  SwiftPackageSpec,
} from "./xcode-manager.js";

export const SENTRY_SPM_ALREADY_LINKED_FRAMEWORK_COMMENT =
  "Sentry in Frameworks";

export const sentrySwiftPackageSpec: SwiftPackageSpec = {
  repositoryURL: "https://github.com/getsentry/sentry-cocoa/",
  requirement: {
    kind: "upToNextMajorVersion",
    minimumVersion: "9.0.0",
  },
  commentName: "sentry-cocoa",
};

export const sentrySwiftPackageProductSpec: SwiftPackageProductSpec = {
  package: sentrySwiftPackageSpec,
  productName: "Sentry",
};
