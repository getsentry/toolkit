/**
 * sentry build download <build-id>
 *
 * Download a mobile build artifact (APK/IPA) previously uploaded to Sentry's
 * preprod system for size analysis. Resolves the build's download URL via the
 * preprod-artifacts install-details endpoint and streams the binary to disk.
 *
 * Org-scoped (no project). Sentry SaaS only.
 */

import { resolve } from "node:path";
import type { SentryContext } from "../../context.js";
import {
  buildFormatFromUrl,
  downloadBuildArtifact,
  getBuildInstallDetails,
  toBinaryDownloadUrl,
} from "../../lib/api/preprod-artifacts.js";
import { buildCommand } from "../../lib/command.js";
import { ContextError, ResolutionError } from "../../lib/errors.js";
import { mdKvTable, renderMarkdown } from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { resolveOrgRegion } from "../../lib/region.js";
import { resolveOrg } from "../../lib/resolve-target.js";

const USAGE_HINT = "sentry build download <build-id>";

/** Structured result for `build download`. */
type BuildDownloadResult = {
  /** The downloaded build's ID. */
  buildId: string;
  /** Organization slug the build belongs to. */
  org: string;
  /** Local path the artifact was written to. */
  output: string;
  /** The artifact format (`ipa` or `apk`). */
  format: "ipa" | "apk";
};

/** Human-readable formatter for the download result. */
function formatDownloadResult(data: BuildDownloadResult): string {
  return renderMarkdown(
    mdKvTable([
      ["Build ID", data.buildId],
      ["Format", data.format],
      ["Saved to", data.output],
    ])
  );
}

export const downloadCommand = buildCommand({
  docs: {
    brief: "Download a build artifact",
    fullDescription:
      "Download a mobile build artifact (APK or IPA) previously uploaded to " +
      "Sentry's preprod system for size analysis. The build is resolved by " +
      "ID within the organization; the artifact is streamed to a local file.\n\n" +
      "This feature only works with Sentry SaaS.\n\n" +
      "Usage:\n" +
      "  sentry build download 1234567890\n" +
      "  sentry build download 1234567890 --output ./app.ipa",
  },
  output: {
    human: formatDownloadResult,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        {
          brief: "ID of the build to download",
          parse: String,
          placeholder: "build-id",
        },
      ],
    },
    flags: {
      output: {
        kind: "parsed",
        parse: String,
        brief:
          "Output path (default: preprod_artifact_<build-id>.<ext> in the current directory)",
        optional: true,
      },
    },
    aliases: {
      o: "output",
    },
  },
  async *func(
    this: SentryContext,
    flags: { output?: string },
    buildId: string
  ) {
    const resolved = await resolveOrg({ cwd: this.cwd });
    if (!resolved) {
      throw new ContextError("Organization", USAGE_HINT);
    }
    const { org } = resolved;

    const details = await getBuildInstallDetails(org, buildId);
    if (!(details.isInstallable && details.installUrl)) {
      throw new ResolutionError(
        `Build ${buildId}`,
        "is not installable",
        USAGE_HINT,
        [
          "The build may still be processing, or it has no downloadable artifact.",
        ]
      );
    }

    const url = toBinaryDownloadUrl(details.installUrl);
    const format = buildFormatFromUrl(url);
    const output = resolve(
      this.cwd,
      flags.output ?? `preprod_artifact_${buildId}.${format}`
    );

    const regionUrl = await resolveOrgRegion(org);
    await downloadBuildArtifact(regionUrl, url, output);

    yield new CommandOutput<BuildDownloadResult>({
      buildId,
      org,
      output,
      format,
    });
    return { hint: `Downloaded build ${buildId} to ${output}` };
  },
});
