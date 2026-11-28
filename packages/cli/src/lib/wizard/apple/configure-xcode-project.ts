/**
 * Apply the iOS wizard's Xcode project changes to one target (the Sentry
 * Swift package and the upload build phase) and save the project.
 */

import { traceStep } from "../telemetry.js";
import { type SentryProjectData } from "../utils/types.js";
import {
  SENTRY_SPM_ALREADY_LINKED_FRAMEWORK_COMMENT,
  sentrySwiftPackageProductSpec,
} from "./sentry-swift-package.js";
import { XcodeProject } from "./xcode-manager.js";

export function configureXcodeProject({
  xcProject,
  project,
  target,
}: {
  xcProject: XcodeProject;
  project: SentryProjectData;
  target: string;
}) {
  traceStep("Update Xcode project", () => {
    xcProject.updateXcodeProject(
      project,
      target,
      {
        product: sentrySwiftPackageProductSpec,
        existingFrameworkComment: SENTRY_SPM_ALREADY_LINKED_FRAMEWORK_COMMENT,
        successMessage: "Added Sentry SPM dependency to your project",
      },
      true,
    );
  });
}
