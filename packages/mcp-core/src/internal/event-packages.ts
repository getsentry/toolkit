import { z } from "zod";
import type { Event } from "../api-client/types";

export const SelectedEventPackagesSchema = z.object({
  metadataAvailable: z.boolean(),
  packages: z.array(
    z.discriminatedUnion("status", [
      z.object({
        name: z.string(),
        status: z.literal("recorded"),
        version: z.string(),
        truncated: z.boolean(),
      }),
      z.object({
        name: z.string(),
        status: z.enum(["not_listed", "version_not_recorded"]),
        version: z.null(),
        truncated: z.literal(false),
      }),
    ]),
  ),
});

/** Select once for both structured and Markdown output, without exposing the full map. */
export function selectEventPackages(
  packages: Event["packages"],
  packageNames?: string[],
): z.infer<typeof SelectedEventPackagesSchema> | undefined {
  if (!packageNames?.length) {
    return undefined;
  }
  if (!packages || Object.keys(packages).length === 0) {
    return { metadataAvailable: false, packages: [] };
  }

  return {
    metadataAvailable: true,
    packages: [...new Set(packageNames)].map((name) => {
      const version = Object.hasOwn(packages, name)
        ? packages[name]
        : undefined;
      if (version === undefined || !version?.trim()) {
        return {
          name,
          status: version === undefined ? "not_listed" : "version_not_recorded",
          version: null,
          truncated: false,
        };
      }
      return {
        name,
        status: "recorded",
        version: version.slice(0, 256),
        truncated: version.length > 256,
      };
    }),
  };
}
