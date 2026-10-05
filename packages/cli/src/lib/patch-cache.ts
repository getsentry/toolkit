import { join } from "node:path";
import { makeCache, type PatchCache, type PatchChain } from "binpatch";
import { getConfigDir } from "./db/index.js";

export type { ChainMeta, PatchStepMeta } from "binpatch";
// biome-ignore lint/performance/noBarrelFile: preserve the existing cache API
export { chainFileName, patchFileName } from "binpatch";

function cache(): PatchCache {
  return makeCache(join(getConfigDir(), "patch-cache"));
}

export function savePatchesToCache(
  chain: Pick<PatchChain, "patches" | "expectedSha256">,
  steps: { fromVersion: string; toVersion: string }[]
): Promise<void> {
  return cache().save(chain, steps);
}

export async function loadCachedChain(
  currentVersion: string,
  targetVersion: string
): ReturnType<PatchCache["load"]> {
  const result = await cache().load(currentVersion, targetVersion);
  if (!result) {
    return null;
  }
  return {
    ...result,
    patches: result.patches.map((patch) => ({
      ...patch,
      data: new Uint8Array(patch.data),
    })),
  };
}

export function cleanupPatchCache(): Promise<void> {
  return cache().cleanup();
}

export function clearPatchCache(): Promise<void> {
  return cache().clear();
}
