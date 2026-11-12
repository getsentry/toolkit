/**
 * sentry release create
 *
 * Create a new Sentry release.
 */

import { inlineCode, text } from "@sentry/toolkit-core/markdown";
import type { SentryContext } from "../../context.js";
import { createRelease } from "../../lib/api-client.js";
import { sentry } from "../../lib/app-identity.js";
import { buildCommand } from "../../lib/command.js";
import {
  parseProjectList,
  parseUrl,
  parseVcsRef,
} from "../../lib/completion-target.js";
import {
  colorTag,
  mdKvTable,
  renderMarkdown,
} from "../../lib/formatters/markdown.js";
import { CommandOutput } from "../../lib/formatters/output.js";
import { DRY_RUN_ALIASES, DRY_RUN_FLAG } from "../../lib/mutate-command.js";
import type { SentryRelease, WithOutputFields } from "../../types/index.js";
import { type ReleaseTarget, releaseParameter } from "./parse.js";
import { ReleaseCreateOutputSchema } from "../../generated/output-schemas/release.js";
import type { ReleaseCreateOutputFields } from "../../output-schemas/release.js";

const usageHint = () => sentry`release create [<org>/]<version>`;

/** The release `--dry-run` reports: the request body, shaped like a release. */
type ReleaseCreateDryRun = WithOutputFields<
  Pick<SentryRelease, "version" | "ref" | "url" | "dateReleased">,
  typeof ReleaseCreateOutputFields
> & { projects: { slug: string }[] };

function formatReleaseCreated(release: SentryRelease): string {
  const lines: string[] = [];
  lines.push(`## Release Created: ${text(release.version)}`);
  lines.push("");
  const kvRows: [string, string][] = [];
  kvRows.push(["Version", inlineCode(release.version)]);
  kvRows.push([
    "Status",
    release.dateReleased
      ? colorTag("green", "Finalized")
      : colorTag("yellow", "Unreleased"),
  ]);
  if (release.projects?.length) {
    kvRows.push(["Projects", release.projects.map((p) => p.slug).join(", ")]);
  }
  lines.push(mdKvTable(kvRows));
  return renderMarkdown(lines.join("\n"));
}

export const createCommand = buildCommand({
  docs: {
    brief: "Create a release",
    fullDescription:
      "Create a new Sentry release.\n\n" +
      "The version must match the `release` value in Sentry.init().\n" +
      "Use `org/version` to specify the org — the `org/` prefix is the org slug, not\n" +
      "part of the version. E.g., `sentry/1.0.0` means org=sentry, version=1.0.0.",
    examples: [
      {
        description: "Create a release",
        run: "release create 1.0.0",
      },
      {
        description: "Create a release in an explicit organization",
        run: "release create my-org/1.0.0",
      },
      {
        description: "Create and finalize a release",
        run: "release create 1.0.0 --finalize",
      },
      {
        description: "Create a release for specific projects",
        run: "release create 1.0.0 --project proj-a,proj-b",
      },
      {
        description:
          "Typical CI release: create, associate commits, finalize, and record a deploy",
        run: [
          "release create my-org/1.0.0 --project my-project",
          "release set-commits my-org/1.0.0 --auto",
          "release finalize my-org/1.0.0",
          "release deploy my-org/1.0.0 production",
        ],
      },
      {
        description: "Create a release from a proposed version",
        run: 'release create "$(sentry release propose-version --json | jq -r .version)"',
      },
      {
        description: "Set the release ref and URL",
        run: "release create 1.0.0 --ref main --url https://github.com/org/repo/releases/tag/1.0.0",
      },
      {
        description: "Preview without creating",
        run: "release create 1.0.0 --dry-run",
      },
    ],
  },
  output: {
    human: (data: SentryRelease | ReleaseCreateDryRun) => {
      if ("dryRun" in data && data.dryRun) {
        const projects = data.projects.map((p) => p.slug);
        return renderMarkdown(
          `Would create release ${inlineCode(data.version)}` +
            (projects.length > 0
              ? ` in projects: ${projects.join(", ")}`
              : "") +
            (data.dateReleased ? " (finalized)" : "") +
            " (dry run)",
        );
      }
      return formatReleaseCreated(data as SentryRelease);
    },
    schema: ReleaseCreateOutputSchema,
  },
  parameters: {
    positional: {
      kind: "tuple",
      parameters: [
        releaseParameter(
          usageHint,
          "[<org>/]<version> - Release version to create",
        ),
      ],
    },
    flags: {
      project: {
        kind: "parsed",
        parse: parseProjectList,
        brief: "Associate with project(s), comma-separated",
        optional: true,
      },
      finalize: {
        kind: "boolean",
        brief: "Immediately finalize the release (set dateReleased)",
        default: false,
      },
      ref: {
        kind: "parsed",
        parse: parseVcsRef,
        brief: "Git ref (branch or tag name)",
        optional: true,
      },
      url: {
        kind: "parsed",
        parse: parseUrl,
        brief: "URL to the release source",
        optional: true,
      },
      "dry-run": DRY_RUN_FLAG,
    },
    aliases: { ...DRY_RUN_ALIASES, p: "project" },
  },
  async *func(
    this: SentryContext,
    flags: {
      readonly project?: string;
      readonly finalize: boolean;
      readonly ref?: string;
      readonly url?: string;
      readonly "dry-run": boolean;
      readonly json: boolean;
      readonly fields?: string[];
    },
    target: ReleaseTarget,
  ) {
    const { version, org } = await target.resolved;

    const body: Parameters<typeof createRelease>[1] = { version };
    if (flags.project) {
      body.projects = flags.project.split(",").map((p) => p.trim());
    }
    if (flags.ref) {
      body.ref = flags.ref;
    }
    if (flags.url) {
      body.url = flags.url;
    }
    if (flags.finalize) {
      body.dateReleased = new Date().toISOString();
    }

    // Dry-run mode: show what would be created without calling the API
    if (flags["dry-run"]) {
      const preview: ReleaseCreateDryRun = {
        dryRun: true,
        version,
        projects: (body.projects ?? []).map((slug) => ({ slug })),
        ref: body.ref,
        url: body.url,
        dateReleased: body.dateReleased,
      };
      yield new CommandOutput(preview);
      return { hint: "Dry run — no release was created." };
    }

    const release = await createRelease(org, body);
    yield new CommandOutput(release);

    const hint = flags.finalize
      ? "Release created and finalized."
      : `Release created. Finalize with: ${sentry`release finalize ${version}`}`;
    return { hint };
  },
});
