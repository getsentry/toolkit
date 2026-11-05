/**
 * Structured output for `get_profile_details`.
 *
 * One profile comes back in one of three summary shapes, discriminated by
 * `profileType`: a sample-format transaction profile, a legacy speedscope
 * transaction profile, or a continuous profile chunk. Sample analysis sits
 * beside the summary and is null for legacy profiles.
 */

import { z } from "zod";
import { suggestedToolActionSchema } from "../../../internal/tool-helpers/suggested-actions";
import type {
  LegacySpeedscopeProfile,
  ProfileChunk,
  TransactionProfile,
} from "../../../api-client/types";

const MAX_TOP_FRAMES = 10;

const nullableString = z.string().nullable();

const sampleAnalysisSchema = z.object({
  frameCount: z.number(),
  sampleCount: z.number(),
  stackCount: z.number(),
  threads: z.array(
    z.object({
      id: z.string(),
      name: nullableString,
      sampleCount: z.number(),
    }),
  ),
  topFrames: z
    .array(
      z.object({
        function: nullableString,
        location: nullableString,
        isApplication: z.boolean(),
        count: z
          .number()
          .describe("Occurrences of the frame across sampled stacks."),
      }),
    )
    .describe(
      "Most frequent frames. Only application frames when focusOnUserCode is true.",
    ),
});

const transactionSummaryFields = {
  profileUrl: z.string(),
  project: z.string(),
  profileId: z.string(),
  transactionName: nullableString,
  traceId: nullableString,
  traceUrl: nullableString,
  durationMs: z.number().nullable(),
  platform: z.string(),
  environment: nullableString,
  device: nullableString,
  os: nullableString,
};

export const getProfileDetailsOutputSchema = z.object({
  profile: z.discriminatedUnion("profileType", [
    z.object({
      profileType: z.literal("transaction"),
      ...transactionSummaryFields,
      release: nullableString,
      sdk: nullableString,
      activeThreadId: nullableString,
    }),
    z
      .object({
        profileType: z.literal("legacy"),
        ...transactionSummaryFields,
      })
      .describe("Legacy speedscope profile, for example Android."),
    z.object({
      profileType: z.literal("continuous"),
      profileUrl: z.string(),
      project: z.string(),
      profilerId: z.string(),
      chunkId: z.string(),
      start: z.string(),
      end: z.string(),
      platform: z.string(),
      release: nullableString,
      environment: nullableString,
    }),
  ]),
  samples: sampleAnalysisSchema
    .nullable()
    .describe("Null for legacy profiles, which have no sample-format data."),
  suggestedActions: z.array(suggestedToolActionSchema),
});

type ProfileDetails = Omit<
  z.infer<typeof getProfileDetailsOutputSchema>,
  "suggestedActions"
>;
type LegacyProfileDetails = {
  profile: Extract<ProfileDetails["profile"], { profileType: "legacy" }>;
  samples: null;
};
type SampleAnalysis = z.infer<typeof sampleAnalysisSchema>;

interface ProfileSampleData {
  frames: ProfileChunk["profile"]["frames"];
  samples: Array<{ stack_id: number; thread_id: string }>;
  stacks: ProfileChunk["profile"]["stacks"];
  threadMetadata: ProfileChunk["profile"]["thread_metadata"];
}

interface ProfileLinks {
  profileUrl: string;
  project: string;
  traceUrl: string | null;
}

function toMs(ns: number): number {
  return Math.round(ns / 10_000) / 100;
}

function joinPresent(
  parts: Array<string | null | undefined>,
  separator: string,
): string | null {
  const present = parts.filter(Boolean);
  return present.length > 0 ? present.join(separator) : null;
}

function buildSampleAnalysis(
  profile: ProfileSampleData,
  options: { focusOnUserCode: boolean },
): SampleAnalysis {
  const threadSampleCounts = new Map<string, number>();
  const frameCounts = new Map<number, number>();
  for (const sample of profile.samples) {
    threadSampleCounts.set(
      sample.thread_id,
      (threadSampleCounts.get(sample.thread_id) ?? 0) + 1,
    );
    for (const frameIndex of profile.stacks[sample.stack_id] ?? []) {
      frameCounts.set(frameIndex, (frameCounts.get(frameIndex) ?? 0) + 1);
    }
  }

  const topFrames = [...frameCounts.entries()]
    .flatMap(([frameIndex, count]) => {
      const frame = profile.frames[frameIndex];
      if (!frame || (options.focusOnUserCode && !frame.in_app)) {
        return [];
      }
      const functionName = frame.function || frame.raw_function || null;
      return [
        {
          function:
            frame.class_name && functionName
              ? `${frame.class_name}.${functionName}`
              : functionName,
          location:
            frame.filename && frame.lineno
              ? `${frame.filename}:${frame.lineno}`
              : frame.module || frame.abs_path || null,
          isApplication: frame.in_app,
          count,
        },
      ];
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, MAX_TOP_FRAMES);

  return {
    frameCount: profile.frames.length,
    sampleCount: profile.samples.length,
    stackCount: profile.stacks.length,
    threads: Object.entries(profile.threadMetadata).map(([id, metadata]) => ({
      id,
      name: metadata.name || null,
      sampleCount: threadSampleCounts.get(id) ?? 0,
    })),
    topFrames,
  };
}

function formatRelease(release: TransactionProfile["release"]): string | null {
  if (typeof release === "string") {
    return release || null;
  }
  return release?.version || null;
}

function getTransactionProfileDurationNs(
  profile: TransactionProfile,
): number | null {
  const relativeStart = profile.transaction?.relative_start_ns;
  const relativeEnd = profile.transaction?.relative_end_ns;
  if (
    typeof relativeStart === "number" &&
    Number.isFinite(relativeStart) &&
    typeof relativeEnd === "number" &&
    Number.isFinite(relativeEnd) &&
    relativeEnd >= relativeStart
  ) {
    return relativeEnd - relativeStart;
  }

  // V1 transaction profile samples always carry elapsed_since_start_ns in
  // nanoseconds — there's no timestamp field on the wire — so we can derive
  // duration from them directly without scale inference.
  const elapsed = profile.profile.samples
    .map((sample) => sample.elapsed_since_start_ns)
    .filter((value) => Number.isFinite(value))
    .sort((a, b) => a - b);
  if (elapsed.length < 2) {
    return null;
  }

  const duration = elapsed[elapsed.length - 1]! - elapsed[0]!;
  return duration > 0 ? Math.round(duration) : null;
}

export function buildTransactionProfileDetails(
  profile: TransactionProfile,
  links: ProfileLinks & { profileId: string },
  options: { focusOnUserCode: boolean },
): ProfileDetails {
  const durationNs = getTransactionProfileDurationNs(profile);
  return {
    profile: {
      profileType: "transaction",
      profileUrl: links.profileUrl,
      project: links.project,
      profileId: profile.profile_id ?? profile.event_id ?? links.profileId,
      transactionName: profile.transaction?.name ?? null,
      traceId: profile.transaction?.trace_id ?? null,
      traceUrl: links.traceUrl,
      durationMs: durationNs === null ? null : toMs(durationNs),
      platform: profile.platform,
      environment: profile.environment || null,
      device: joinPresent(
        [
          profile.device?.model,
          profile.device?.classification,
          profile.device?.arch,
        ],
        " · ",
      ),
      os: joinPresent(
        [profile.os?.name, profile.os?.version, profile.os?.build_number],
        " ",
      ),
      release: formatRelease(profile.release),
      sdk: joinPresent(
        [profile.client_sdk?.name, profile.client_sdk?.version],
        " ",
      ),
      activeThreadId: profile.transaction?.active_thread_id ?? null,
    },
    samples: buildSampleAnalysis(
      {
        frames: profile.profile.frames,
        samples: profile.profile.samples,
        stacks: profile.profile.stacks,
        threadMetadata: profile.profile.thread_metadata,
      },
      options,
    ),
  };
}

/**
 * Legacy profiles (e.g. Android) do not expose sample-format data through the
 * profile details API, so only summary metadata is reported.
 */
export function buildLegacyProfileDetails(
  profile: LegacySpeedscopeProfile,
  links: ProfileLinks & { profileId: string },
): LegacyProfileDetails {
  const metadata = profile.metadata;
  const durationNs =
    profile.durationNS != null && Number.isFinite(profile.durationNS)
      ? profile.durationNS
      : null;
  return {
    profile: {
      profileType: "legacy",
      profileUrl: links.profileUrl,
      project: links.project,
      profileId: profile.profileID ?? links.profileId,
      transactionName:
        profile.transactionName ?? metadata?.transactionName ?? null,
      traceId: metadata?.traceID ?? null,
      traceUrl: links.traceUrl,
      durationMs: durationNs === null ? null : toMs(durationNs),
      platform: profile.platform,
      environment: metadata?.environment || null,
      device: joinPresent(
        [metadata?.deviceManufacturer, metadata?.deviceModel],
        " ",
      ),
      os: joinPresent([metadata?.deviceOSName, metadata?.deviceOSVersion], " "),
    },
    samples: null,
  };
}

export function buildContinuousProfileDetails(
  chunk: ProfileChunk,
  request: {
    profileUrl: string;
    project: string;
    profilerId: string;
    start: string;
    end: string;
  },
  options: { focusOnUserCode: boolean },
): ProfileDetails {
  return {
    profile: {
      profileType: "continuous",
      profileUrl: request.profileUrl,
      project: request.project,
      profilerId: request.profilerId,
      chunkId: chunk.chunk_id,
      start: request.start,
      end: request.end,
      platform: chunk.platform,
      release: chunk.release,
      environment: chunk.environment,
    },
    samples: buildSampleAnalysis(
      {
        frames: chunk.profile.frames,
        samples: chunk.profile.samples,
        stacks: chunk.profile.stacks,
        threadMetadata: chunk.profile.thread_metadata,
      },
      options,
    ),
  };
}
